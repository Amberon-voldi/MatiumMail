import "server-only";
import { z } from "zod";
import { db } from "../db";
import { audit, defaultOrganizationId } from "../audit";
import { sha256Hex } from "../crypto/tokens";
import { sealSecret } from "../crypto/envelope";
import { credentialKeyRing, mailboxCredentialContext } from "../crypto/keyring";
import { invalidateMailboxConnection } from "../mail/client";
import { verifyImapLogin } from "../mail/imap";
import type { RequestContext } from "../request";
import { consume, loginLimits, resetLimit } from "./rate-limit";

/**
 * Sign-in = "prove you know this mailbox's password".
 *
 * Order matters:
 *   1. validate input
 *   2. rate-limit (per IP, per address)
 *   3. allowlist check — the address must be a provisioned user who OWNS the
 *      mailbox of the same address. Unknown addresses are rejected BEFORE any
 *      IMAP connection, so the app can't be used to hammer MilesWeb and get its
 *      IP locked out.
 *   4. IMAP LOGIN over verified TLS
 *   5. on success: store the password (envelope-encrypted, new version),
 *      mark the mailbox ACTIVE, reset the per-address limiter, audit.
 *
 * The caller (Server Action) creates the session cookie.
 */

export type SignInError = "invalid_input" | "invalid_credentials" | "rate_limited" | "mail_server_unavailable";
export type SignInResult =
  | { ok: true; userId: string }
  | { ok: false; error: SignInError; retryAfterSeconds?: number };

const inputSchema = z.object({
  email: z.string().trim().max(320).pipe(z.email()),
  password: z.string().min(1).max(1024),
});

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function signIn(raw: { email: unknown; password: unknown }, ctx: RequestContext): Promise<SignInResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid_input" };
  const email = normalizeEmail(parsed.data.email);
  const password = parsed.data.password;
  const emailHash = sha256Hex(email);

  // ── 2. rate limits ────────────────────────────────────────────────────────
  const [byIp, byAccount] = await Promise.all([
    consume(loginLimits.perIp(ctx.ip)),
    consume(loginLimits.perAccount(emailHash)),
  ]);
  if (!byIp.allowed || !byAccount.allowed) {
    const retryAfterMs = Math.max(
      byIp.allowed ? 0 : byIp.retryAfterMs,
      byAccount.allowed ? 0 : byAccount.retryAfterMs,
    );
    const orgId = await defaultOrganizationId();
    if (orgId) {
      await audit({
        organizationId: orgId,
        action: "auth.login.rate_limited",
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        metadata: { emailHash, scope: byIp.allowed ? "account" : "ip" },
      });
    }
    return { ok: false, error: "rate_limited", retryAfterSeconds: Math.ceil(retryAfterMs / 1000) };
  }

  // ── 3. allowlist ──────────────────────────────────────────────────────────
  const p = db();
  const [user, mailbox] = await Promise.all([
    p.user.findUnique({ where: { email }, select: { id: true, status: true, organizationId: true } }),
    p.mailbox.findUnique({
      where: { address: email },
      select: {
        id: true,
        status: true,
        organizationId: true,
        domain: {
          select: {
            status: true,
            serverProfile: {
              select: { imapHost: true, imapPort: true, imapSecurity: true, tlsServername: true },
            },
          },
        },
        credential: { select: { version: true } },
      },
    }),
  ]);
  const access =
    user && mailbox
      ? await p.mailboxAccess.findUnique({
          where: { userId_mailboxId: { userId: user.id, mailboxId: mailbox.id } },
          select: { role: true },
        })
      : null;

  const allowed =
    user?.status === "ACTIVE" &&
    mailbox !== null &&
    mailbox.status !== "DISABLED" &&
    mailbox.domain.status === "ACTIVE" &&
    access?.role === "OWNER";

  if (!allowed || !user || !mailbox) {
    const orgId = user?.organizationId ?? mailbox?.organizationId ?? (await defaultOrganizationId());
    if (orgId) {
      await audit({
        organizationId: orgId,
        action: "auth.login.failure",
        actorUserId: user?.id ?? null,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        metadata: { emailHash, reason: "not_allowed" },
      });
    }
    return { ok: false, error: "invalid_credentials" };
  }

  // ── 4. IMAP login ─────────────────────────────────────────────────────────
  const profile = mailbox.domain.serverProfile;
  const result = await verifyImapLogin(
    {
      host: profile.imapHost,
      port: profile.imapPort,
      security: profile.imapSecurity,
      tlsServername: profile.tlsServername,
    },
    { username: email, password },
  );

  if (!result.ok) {
    await audit({
      organizationId: user.organizationId,
      action: "auth.login.failure",
      actorUserId: user.id,
      mailboxId: mailbox.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { reason: result.reason },
    });
    return result.reason === "auth_failed"
      ? { ok: false, error: "invalid_credentials" }
      : { ok: false, error: "mail_server_unavailable" };
  }

  // ── 5. persist ────────────────────────────────────────────────────────────
  const version = (mailbox.credential?.version ?? 0) + 1;
  const sealed = sealSecret(credentialKeyRing(), mailboxCredentialContext(mailbox.id, version), password);
  const now = new Date();
  // Prisma's Bytes fields require Uint8Array<ArrayBuffer>; copy out of Node Buffers.
  const bytes = (b: Buffer) => new Uint8Array(b);
  const credentialData = {
    type: "PASSWORD" as const,
    username: email,
    ciphertext: bytes(sealed.ciphertext),
    iv: bytes(sealed.iv),
    authTag: bytes(sealed.authTag),
    wrappedDek: bytes(sealed.wrappedDek),
    keyId: sealed.keyId,
    version,
    lastVerifiedAt: now,
  };
  await p.$transaction([
    p.mailboxCredential.upsert({
      where: { mailboxId: mailbox.id },
      create: { mailboxId: mailbox.id, ...credentialData },
      update: credentialData,
    }),
    p.mailbox.update({
      where: { id: mailbox.id },
      data: { status: "ACTIVE", statusReason: null, consecutiveFailures: 0 },
    }),
    p.user.update({ where: { id: user.id }, data: { lastLoginAt: now } }),
  ]);
  await resetLimit(loginLimits.perAccount(emailHash).key);
  // New credential version: drop any cached connection built from the old one.
  invalidateMailboxConnection(mailbox.id);

  await audit({
    organizationId: user.organizationId,
    action: "auth.login.success",
    actorUserId: user.id,
    mailboxId: mailbox.id,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    metadata: { credentialVersion: version },
  });

  return { ok: true, userId: user.id };
}
