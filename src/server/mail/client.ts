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

/** Run `fn` with a connected, authenticated IMAP client; always logs out. */
export async function withImap<T>(
  mailboxId: string,
  fn: (client: ImapFlow, conn: MailboxConnection) => Promise<T>,
): Promise<T> {
  const conn = await loadMailboxConnection(mailboxId);
  const client = new ImapFlow(imapConnectionOptions(conn.imap, { username: conn.username, password: conn.password }));
  client.on("error", () => {
    /* surfaced via the awaited calls */
  });
  try {
    await client.connect();
  } catch (err) {
    const reason = classifyImapError(err);
    await recordFailure(conn, reason);
    throw new MailServerError(reason);
  }
  try {
    const result = await fn(client, conn);
    await recordHealthy(mailboxId);
    return result;
  } finally {
    await client.logout().catch(() => client.close());
  }
}
