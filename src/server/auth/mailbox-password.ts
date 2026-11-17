import "server-only";
import { z } from "zod";
import { audit } from "../audit";
import { db } from "../db";
import { sealSecret } from "../crypto/envelope";
import { credentialKeyRing, mailboxCredentialContext } from "../crypto/keyring";
import { sha256Hex } from "../crypto/tokens";
import {
  MailboxUnavailableError,
  invalidateMailboxConnection,
  loadMailboxConnection,
  type MailboxConnection,
} from "../mail/client";
import { verifyImapLogin } from "../mail/imap";
import type { RequestContext } from "../request";
import type { AuthorizedMailbox } from "./dal";
import { consume, loginLimits, resetLimit } from "./rate-limit";

/**
 * The stored mailbox password: what the app uses for IMAP/SMTP.
 *
 * When someone changes it in mPanel, the next connection fails and the
 * mailbox becomes NEEDS_REAUTH. The owner then types the new password, either
 * at sign-in or on the mailbox's reconnect page. The mailbox password stays
 * the root of trust: until the new one is entered, the Matium Mail password
 * can't be used to sign in (so changing it in mPanel still locks out anyone
 * who only knew the old one).
 */

/** Store a password the mail server just accepted (new version) and mark the mailbox ACTIVE. */
export async function saveMailboxPassword(mailboxId: string, username: string, password: string): Promise<number> {
  const p = db();
  const current = await p.mailboxCredential.findUnique({ where: { mailboxId }, select: { version: true } });
  const version = (current?.version ?? 0) + 1;
  const sealed = sealSecret(credentialKeyRing(), mailboxCredentialContext(mailboxId, version), password);
  // Prisma's Bytes fields require Uint8Array<ArrayBuffer>; copy out of Node Buffers.
  const bytes = (b: Buffer) => new Uint8Array(b);
  const credentialData = {
    type: "PASSWORD" as const,
    username,
    ciphertext: bytes(sealed.ciphertext),
    iv: bytes(sealed.iv),
    authTag: bytes(sealed.authTag),
    wrappedDek: bytes(sealed.wrappedDek),
    keyId: sealed.keyId,
    version,
    lastVerifiedAt: new Date(),
  };
  await p.$transaction([
    p.mailboxCredential.upsert({
      where: { mailboxId },
      create: { mailboxId, ...credentialData },
      update: credentialData,
    }),
    p.mailbox.update({
      where: { id: mailboxId },
      data: { status: "ACTIVE", statusReason: null, consecutiveFailures: 0 },
    }),
  ]);
  // New credential version: drop any cached connection built from the old one.
  invalidateMailboxConnection(mailboxId);
  return version;
}

/**
 * Does the mail server still accept the stored password? A rejection marks
 * the mailbox NEEDS_REAUTH. A server that can't be reached is not treated as
 * a rejection, so an outage never locks anyone out.
 */
export async function storedPasswordStillWorks(mailboxId: string): Promise<boolean> {
  let conn: MailboxConnection;
  try {
    conn = await loadMailboxConnection(mailboxId);
  } catch (err) {
    if (err instanceof MailboxUnavailableError) return false;
    throw err;
  }
  const result = await verifyImapLogin(conn.imap, { username: conn.username, password: conn.password });
  if (result.ok || result.reason !== "auth_failed") return true;
  await db().mailbox.update({
    where: { id: mailboxId },
    data: { status: "NEEDS_REAUTH", statusReason: "The mail server rejected the stored password." },
  });
  await audit({
    organizationId: conn.organizationId,
    action: "mailbox.auth_failed",
    mailboxId,
    metadata: { stage: "sign_in" },
  });
  return false;
}

export type ReconnectError ="invalid_input" | "invalid_credentials" | "rate_limited" | "mail_server_unavailable";
export type ReconnectResult = { ok: true } | { ok: false; error: ReconnectError; retryAfterSeconds?: number };

/** Check a new mailbox password with the mail server and store it. Needs "manage" access. */
export async function reconnectMailbox(
  auth: AuthorizedMailbox,
  rawPassword: unknown,
  ctx: RequestContext,
): Promise<ReconnectResult> {
  const parsed = z.string().min(1).max(1024).safeParse(rawPassword);
  if (!parsed.success) return { ok: false, error: "invalid_input" };
  const password = parsed.data;

  const mailbox = await db().mailbox.findUniqueOrThrow({
    where: { id: auth.mailboxId },
    select: {
      id: true,
      address: true,
      organizationId: true,
      domain: {
        select: { serverProfile: { select: { imapHost: true, imapPort: true, imapSecurity: true, tlsServername: true } } },
      },
    },
  });

  // Same budget as signing in to this address: both try the password on the mail server.
  const limit = loginLimits.perAccount(sha256Hex(mailbox.address));
  const allowed = await consume(limit);
  if (!allowed.allowed) {
    return { ok: false, error: "rate_limited", retryAfterSeconds: Math.ceil(allowed.retryAfterMs / 1000) };
  }

  const sp = mailbox.domain.serverProfile;
  const result = await verifyImapLogin(
    { host: sp.imapHost, port: sp.imapPort, security: sp.imapSecurity, tlsServername: sp.tlsServername },
    { username: mailbox.address, password },
  );
  if (!result.ok) {
    await audit({
      organizationId: mailbox.organizationId,
      action: "mailbox.auth_failed",
      actorUserId: auth.userId,
      mailboxId: mailbox.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { source: "reconnect", reason: result.reason },
    });
    return result.reason === "auth_failed"
      ? { ok: false, error: "invalid_credentials" }
      : { ok: false, error: "mail_server_unavailable" };
  }

  const version = await saveMailboxPassword(mailbox.id, mailbox.address, password);
  await resetLimit(limit.key);
  await audit({
    organizationId: mailbox.organizationId,
    action: "mailbox.credential.updated",
    actorUserId: auth.userId,
    mailboxId: mailbox.id,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    metadata: { credentialVersion: version },
  });
  return { ok: true };
}
