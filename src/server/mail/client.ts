import "server-only";
import { ImapFlow } from "imapflow";
import { audit } from "../audit";
import { db } from "../db";
import { openSecret } from "../crypto/envelope";
import { credentialKeyRing, mailboxCredentialContext } from "../crypto/keyring";
import { classifyImapError, imapConnectionOptions, type MailEndpoint } from "./imap";

/**
 * Opening authenticated IMAP sessions for a mailbox, using its stored
 * (envelope-encrypted) credential. The plaintext password exists only in
 * memory for the duration of the connection.
 *
 * Failure policy:
 *   - authentication rejected → mailbox NEEDS_REAUTH, audited; no retries until
 *     the owner signs in again (protects against MilesWeb lockouts)
 *   - other errors            → consecutiveFailures++; ERROR after 5 in a row
 *   - success                 → clears any error state
 */

const MAX_CONSECUTIVE_FAILURES = 5;

export class MailboxUnavailableError extends Error {
  constructor(readonly status: string) {
    super(
      status === "NEEDS_REAUTH"
        ? "This mailbox needs you to sign in again (its password changed or was rejected)."
        : "This mailbox is not available.",
    );
    this.name = "MailboxUnavailableError";
  }
}

export class MailServerError extends Error {
  constructor(readonly reason: string) {
    super(
      reason === "auth_failed"
        ? "The mail server rejected the stored password."
        : "Couldn't reach the mail server. Please try again shortly.",
    );
    this.name = "MailServerError";
  }
}

export type MailboxConnection = {
  mailboxId: string;
  organizationId: string;
  address: string;
  displayName: string | null;
  imap: MailEndpoint;
  smtp: MailEndpoint;
  username: string;
  password: string;
};

export async function loadMailboxConnection(mailboxId: string): Promise<MailboxConnection> {
  const mb = await db().mailbox.findUnique({
    where: { id: mailboxId },
    select: {
      id: true,
      organizationId: true,
      address: true,
      displayName: true,
      status: true,
      domain: {
        select: {
          serverProfile: {
            select: {
              imapHost: true,
              imapPort: true,
              imapSecurity: true,
              smtpHost: true,
              smtpPort: true,
              smtpSecurity: true,
              tlsServername: true,
            },
          },
        },
      },
      credential: {
        select: { username: true, ciphertext: true, iv: true, authTag: true, wrappedDek: true, keyId: true, version: true },
      },
    },
  });
  if (!mb) throw new MailboxUnavailableError("MISSING");
  if (mb.status === "NEEDS_REAUTH" || mb.status === "DISABLED" || !mb.credential) {
    throw new MailboxUnavailableError(mb.credential ? mb.status : "NEEDS_REAUTH");
  }
  const p = mb.domain.serverProfile;
  const password = openSecret(credentialKeyRing(), mailboxCredentialContext(mb.id, mb.credential.version), mb.credential);
  return {
    mailboxId: mb.id,
    organizationId: mb.organizationId,
    address: mb.address,
    displayName: mb.displayName,
    imap: { host: p.imapHost, port: p.imapPort, security: p.imapSecurity, tlsServername: p.tlsServername },
    smtp: { host: p.smtpHost, port: p.smtpPort, security: p.smtpSecurity, tlsServername: p.tlsServername },
    username: mb.credential.username,
    password,
  };
}

async function recordFailure(conn: MailboxConnection, reason: string): Promise<void> {
  const p = db();
  if (reason === "auth_failed") {
    await p.mailbox.update({
      where: { id: conn.mailboxId },
      data: { status: "NEEDS_REAUTH", statusReason: "The mail server rejected the stored password." },
    });
    await audit({
      organizationId: conn.organizationId,
      action: "mailbox.auth_failed",
      mailboxId: conn.mailboxId,
      metadata: { stage: "imap" },
    });
    return;
  }
  const updated = await p.mailbox.update({
    where: { id: conn.mailboxId },
    data: { consecutiveFailures: { increment: 1 }, lastSyncError: reason },
    select: { consecutiveFailures: true },
  });
  if (updated.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    await p.mailbox.update({
      where: { id: conn.mailboxId },
      data: { status: "ERROR", statusReason: `Mail server unreachable (${reason}).` },
    });
  }
}

async function recordHealthy(mailboxId: string): Promise<void> {
  // Single conditional write; a no-op in the common (healthy) case.
  await db().mailbox.updateMany({
    where: { id: mailboxId, OR: [{ consecutiveFailures: { gt: 0 } }, { status: "ERROR" }] },
    data: { consecutiveFailures: 0, status: "ACTIVE", statusReason: null, lastSyncError: null },
  });
}

// ── Connection reuse ────────────────────────────────────────────────────────
//
// A TLS connect + IMAP LOGIN to MilesWeb costs ~1.2 s. Instead of paying that
// on every action, keep one authenticated connection per mailbox per server
// instance and reuse it until it has been idle for IMAP_IDLE_MS. ImapFlow
// serialises commands and mailbox locks, so concurrent requests can share it.
// Decrypted connection details are cached briefly too (saves a DB query and
// the key unwrap per action); both caches are dropped on auth failure and on
// sign-in (credential change).

const IMAP_IDLE_MS = 2 * 60_000;
const CONN_TTL_MS = 5 * 60_000;
/** A connection unused for this long is checked with NOOP before reuse. */
const PROBE_AFTER_MS = 45_000;
const PROBE_TIMEOUT_MS = 5_000;

type PoolEntry = {
  client: ImapFlow;
  conn: MailboxConnection;
  busy: number;
  lastUsed: number;
  idleTimer?: ReturnType<typeof setTimeout>;
};
type Caches = {
  pool: Map<string, PoolEntry>;
  connecting: Map<string, Promise<PoolEntry>>;
  details: Map<string, { conn: MailboxConnection; expires: number }>;
};
const g = globalThis as unknown as { __matiumImap?: Caches };
const caches: Caches = (g.__matiumImap ??= { pool: new Map(), connecting: new Map(), details: new Map() });

async function connectionDetails(mailboxId: string): Promise<MailboxConnection> {
  const hit = caches.details.get(mailboxId);
  if (hit && hit.expires > Date.now()) return hit.conn;
  const conn = await loadMailboxConnection(mailboxId);
  caches.details.set(mailboxId, { conn, expires: Date.now() + CONN_TTL_MS });
  return conn;
}

/** Forget cached credentials and close the pooled connection (call after sign-in or auth failure). */
export function invalidateMailboxConnection(mailboxId: string): void {
  caches.details.delete(mailboxId);
  const entry = caches.pool.get(mailboxId);
  if (entry) {
    caches.pool.delete(mailboxId);
    clearTimeout(entry.idleTimer);
    void entry.client.logout().catch(() => entry.client.close());
  }
}

async function openPooled(mailboxId: string): Promise<PoolEntry> {
  const conn = await connectionDetails(mailboxId);
  const client = new ImapFlow(imapConnectionOptions(conn.imap, { username: conn.username, password: conn.password }));
  client.on("error", () => {
    /* surfaced via the awaited calls; 'close' below evicts the entry */
  });
  try {
    await client.connect();
  } catch (err) {
    const reason = classifyImapError(err);
    invalidateMailboxConnection(mailboxId);
    await recordFailure(conn, reason);
    throw new MailServerError(reason);
  }
  await recordHealthy(mailboxId);
  const entry: PoolEntry = { client, conn, busy: 0, lastUsed: Date.now() };
  client.on("close", () => {
    if (caches.pool.get(mailboxId) === entry) caches.pool.delete(mailboxId);
  });
  caches.pool.set(mailboxId, entry);
  return entry;
}

async function checkout(mailboxId: string): Promise<{ entry: PoolEntry; reused: boolean }> {
  const existing = caches.pool.get(mailboxId);
  if (existing && existing.client.usable) return { entry: existing, reused: true };
  if (existing) caches.pool.delete(mailboxId);
  let pending = caches.connecting.get(mailboxId);
  if (!pending) {
    pending = openPooled(mailboxId).finally(() => caches.connecting.delete(mailboxId));
    caches.connecting.set(mailboxId, pending);
  }
  return { entry: await pending, reused: false };
}

function release(mailboxId: string, entry: PoolEntry): void {
  entry.busy--;
  if (entry.busy > 0 || caches.pool.get(mailboxId) !== entry) return;
  clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    if (entry.busy > 0 || caches.pool.get(mailboxId) !== entry) return;
    caches.pool.delete(mailboxId);
    void entry.client.logout().catch(() => entry.client.close());
  }, IMAP_IDLE_MS);
  entry.idleTimer.unref?.();
}

function isConnectionError(err: unknown): boolean {
  const e = (err ?? {}) as { code?: unknown; message?: unknown };
  return /NoConnection|EPIPE|ECONNRESET|ETIMEDOUT|socket|closed|Connection not available/i.test(
    `${String(e.code ?? "")} ${String(e.message ?? "")}`,
  );
}

/**
 * Run `fn` with an authenticated IMAP client from the per-mailbox pool.
 * If a reused connection turns out to be dead (server timeout, frozen
 * serverless instance), it is replaced and `fn` retried once.
 */
/** NOOP with a short deadline: false when the connection no longer answers. */
async function stillAlive(client: ImapFlow): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      client.noop().then(() => client.usable),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function withImap<T>(
  mailboxId: string,
  fn: (client: ImapFlow, conn: MailboxConnection) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const { entry, reused } = await checkout(mailboxId);
    clearTimeout(entry.idleTimer);
    entry.busy++;
    // After a quiet spell (or a frozen serverless instance) the server may have
    // dropped the socket without us noticing; check cheaply instead of letting
    // the user's request hang until the socket timeout.
    if (reused && entry.busy === 1 && Date.now() - entry.lastUsed > PROBE_AFTER_MS && !(await stillAlive(entry.client))) {
      if (caches.pool.get(mailboxId) === entry) caches.pool.delete(mailboxId);
      entry.client.close();
      release(mailboxId, entry);
      if (attempt < 2) continue;
      throw new MailServerError("unreachable");
    }
    entry.lastUsed = Date.now();
    try {
      return await fn(entry.client, entry.conn);
    } catch (err) {
      const dead = !entry.client.usable || isConnectionError(err);
      if (dead && caches.pool.get(mailboxId) === entry) {
        caches.pool.delete(mailboxId);
        entry.client.close();
      }
      if (dead && reused && attempt === 0) continue;
      throw err;
    } finally {
      entry.lastUsed = Date.now();
      release(mailboxId, entry);
    }
  }
}
