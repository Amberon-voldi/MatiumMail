import "server-only";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { audit } from "../audit";
import { db } from "../db";
import { openSecret } from "../crypto/envelope";
import { credentialKeyRing, mailboxCredentialContext } from "../crypto/keyring";
import { hashPassword, verifyPassword } from "../crypto/password-hash";
import { sha256Hex } from "../crypto/tokens";
import { verifyImapLogin } from "../mail/imap";
import type { RequestContext } from "../request";
import { saveMailboxPassword } from "./mailbox-password";
import { consume, loginLimits, resetLimit } from "./rate-limit";
import type { SessionUser } from "./session";

/**
 * The app's own sign-in password ("Matium Mail password"): a short
 * alternative to the mailbox password, whose minimum length is set by the
 * mail host. The mailbox password stays stored (envelope-encrypted) for
 * IMAP/SMTP; this one only opens a session here and is kept as a scrypt hash.
 *
 * Setting it requires the current password (the mailbox password or the
 * current app password), so a stolen session can't lock the owner out.
 * Wrong guesses count against the same per-address limit as sign-in.
 */

export const APP_PASSWORD_MIN_LENGTH = 6;
export const APP_PASSWORD_MAX_LENGTH = 128;

export type SetAppPasswordError = "invalid_input" | "too_short" | "mismatch" | "wrong_current_password" | "rate_limited";
export type SetAppPasswordResult =
  | { ok: true }
  | { ok: false; error: SetAppPasswordError; retryAfterSeconds?: number };

const inputSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(1).max(APP_PASSWORD_MAX_LENGTH),
  confirmPassword: z.string().max(APP_PASSWORD_MAX_LENGTH),
});

export async function hasAppPassword(userId: string): Promise<boolean> {
  const user = await db().user.findUnique({ where: { id: userId }, select: { appPasswordHash: true } });
  return Boolean(user?.appPasswordHash);
}

/** True when `password` is the user's app password or the password of their own mailbox. */
async function isCurrentPassword(user: SessionUser, password: string): Promise<boolean> {
  const p = db();
  const row = await p.user.findUnique({ where: { id: user.id }, select: { appPasswordHash: true } });
  if (row?.appPasswordHash && (await verifyPassword(password, row.appPasswordHash))) return true;

  const mailbox = await p.mailbox.findUnique({
    where: { address: user.email },
    select: {
      id: true,
      credential: { select: { ciphertext: true, iv: true, authTag: true, wrappedDek: true, keyId: true, version: true } },
      domain: {
        select: { serverProfile: { select: { imapHost: true, imapPort: true, imapSecurity: true, tlsServername: true } } },
      },
    },
  });
  if (!mailbox) return false;
  if (mailbox.credential) {
    const stored = openSecret(
      credentialKeyRing(),
      mailboxCredentialContext(mailbox.id, mailbox.credential.version),
      mailbox.credential,
    );
    // Compare digests so the check takes the same time whatever the lengths.
    const same = timingSafeEqual(Buffer.from(sha256Hex(stored), "hex"), Buffer.from(sha256Hex(password), "hex"));
    if (same) return true;
  }

  // The mailbox password may have been changed in mPanel since it was saved:
  // ask the mail server, and keep the new one if it's accepted.
  const sp = mailbox.domain.serverProfile;
  const check = await verifyImapLogin(
    { host: sp.imapHost, port: sp.imapPort, security: sp.imapSecurity, tlsServername: sp.tlsServername },
    { username: user.email, password },
  );
  if (!check.ok) return false;
  await saveMailboxPassword(mailbox.id, user.email, password);
  return true;
}

export async function setAppPassword(
  user: SessionUser,
  raw: { currentPassword: unknown; newPassword: unknown; confirmPassword: unknown },
  ctx: RequestContext,
): Promise<SetAppPasswordResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid_input" };
  const { currentPassword, newPassword, confirmPassword } = parsed.data;
  if (newPassword.length < APP_PASSWORD_MIN_LENGTH) return { ok: false, error: "too_short" };
  if (newPassword !== confirmPassword) return { ok: false, error: "mismatch" };

  const limit = loginLimits.perAccount(sha256Hex(user.email));
  const allowed = await consume(limit);
  if (!allowed.allowed) {
    return { ok: false, error: "rate_limited", retryAfterSeconds: Math.ceil(allowed.retryAfterMs / 1000) };
  }

  if (!(await isCurrentPassword(user, currentPassword))) {
    await audit({
      organizationId: user.organizationId,
      action: "auth.app_password.failure",
      actorUserId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { reason: "wrong_current_password" },
    });
    return { ok: false, error: "wrong_current_password" };
  }

  await db().user.update({ where: { id: user.id }, data: { appPasswordHash: await hashPassword(newPassword) } });
  await resetLimit(limit.key);
  await audit({
    organizationId: user.organizationId,
    action: "auth.app_password.set",
    actorUserId: user.id,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
  return { ok: true };
}
