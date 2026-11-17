import "server-only";
import { z } from "zod";
import { db } from "../db";
import { audit, defaultOrganizationId } from "../audit";
import { sha256Hex } from "../crypto/tokens";
import { verifyPassword } from "../crypto/password-hash";
import { verifyImapLogin } from "../mail/imap";
import type { RequestContext } from "../request";
import { saveMailboxPassword, storedPasswordStillWorks } from "./mailbox-password";
import { consume, loginLimits, resetLimit } from "./rate-limit";

/**
 * Sign-in = "prove you know this mailbox's password" (or the shorter Matium
 * Mail password set in the app, see ./app-password.ts).
 *
 * Order matters:
 *   1. validate input
 *   2. rate-limit (per IP, per address)
 *   3. allowlist check — the address must be a provisioned user who OWNS the
 *      mailbox of the same address. Unknown addresses are rejected BEFORE any
 *      IMAP connection, so the app can't be used to hammer MilesWeb and get its
 *      IP locked out.
 *   3b. Matium Mail password, checked against its hash: on a match, sign in
 *      if the stored mailbox password still works (it stays in use for mail).
 *   4. IMAP LOGIN over verified TLS
 *   5. on success: store the password (envelope-encrypted, new version — see
 *      ./mailbox-password.ts), mark the mailbox ACTIVE, reset the per-address
 *      limiter, audit.
 *
 * The caller (Server Action) creates the session cookie.
 */

export type SignInError =
  | "invalid_input"
  | "invalid_credentials"
  | "rate_limited"
  | "mail_server_unavailable"
  | "mailbox_password_required";
export type SignInResult =
  | { ok: true; userId: string }
  | { ok: false; error: SignInError; retryAfterSeconds?: number };

const inputSchema = z.object({
  email: z.string().trim().max(320).pipe(z.email()),
  password: z.string().min(1).max(1024),
});

/**
 * Mailboxes on a REGISTERED domain with autoProvision=true get an account on
 * their first successful login (user + mailbox + OWNER access). Rows are
 * created only after the mail server accepts the password. Unregistered
 * domains are never accepted: MilesWeb is shared hosting, so other customers'
 * domains live on the same mail server and would also authenticate there.
 */
async function autoProvision(email: string, password: string): Promise<void> {
  const p = db();
  if (await p.mailbox.findUnique({ where: { address: email }, select: { id: true } })) return;
  const domain = await p.domain.findUnique({
    where: { name: email.split("@")[1] ?? "" },
    select: {
      id: true,
      organizationId: true,
      status: true,
      autoProvision: true,
      defaultQuotaBytes: true,
      serverProfile: { select: { imapHost: true, imapPort: true, imapSecurity: true, tlsServername: true } },
    },
  });
  if (!domain || domain.status !== "ACTIVE" || !domain.autoProvision) return;
  const sp = domain.serverProfile;
  const check = await verifyImapLogin(
    { host: sp.imapHost, port: sp.imapPort, security: sp.imapSecurity, tlsServername: sp.tlsServername },
    { username: email, password },
  );
  if (!check.ok) return;
  const user = await p.user.upsert({
    where: { email },
    create: { email, organizationId: domain.organizationId, role: "MEMBER", preferences: {} },
    update: {},
  });
  const mailbox = await p.mailbox.create({
    data: {
      address: email,
      organizationId: domain.organizationId,
      domainId: domain.id,
      settings: {},
      quotaLimitBytes: domain.defaultQuotaBytes,
      quotaSource: domain.defaultQuotaBytes ? "MANUAL" : null,
    },
  });
  await p.mailboxAccess.create({ data: { userId: user.id, mailboxId: mailbox.id, role: "OWNER" } });
}

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

  // ── 2b. first login on a registered domain → create the account ───────────
  await autoProvision(email, password).catch((err) =>
    console.error("[auth] auto-provision failed", err instanceof Error ? err.message : err),
  );

  // ── 3. allowlist ──────────────────────────────────────────────────────────
  const p = db();
  const [user, mailbox] = await Promise.all([
    p.user.findUnique({
      where: { email },
      select: { id: true, status: true, organizationId: true, appPasswordHash: true },
    }),
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

  // ── 3b. Matium Mail password ──────────────────────────────────────────────
  // No match → the input is tried as the mailbox password below. On a match
  // the stored mailbox password must still work: after a change in mPanel
  // the new one has to be entered once before the short one works again.
  if (
    user.appPasswordHash &&
    mailbox.credential &&
    (await verifyPassword(password, user.appPasswordHash))
  ) {
    if (!(await storedPasswordStillWorks(mailbox.id))) {
      await audit({
        organizationId: user.organizationId,
        action: "auth.login.failure",
        actorUserId: user.id,
        mailboxId: mailbox.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        metadata: { method: "app_password", reason: "mailbox_password_changed" },
      });
      return { ok: false, error: "mailbox_password_required" };
    }
    await p.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await resetLimit(loginLimits.perAccount(emailHash).key);
    await audit({
      organizationId: user.organizationId,
      action: "auth.login.success",
      actorUserId: user.id,
      mailboxId: mailbox.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { method: "app_password" },
    });
    return { ok: true, userId: user.id };
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
  const version = await saveMailboxPassword(mailbox.id, email, password);
  await p.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await resetLimit(loginLimits.perAccount(emailHash).key);

  await audit({
    organizationId: user.organizationId,
    action: "auth.login.success",
    actorUserId: user.id,
    mailboxId: mailbox.id,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    metadata: { method: "mailbox_password", credentialVersion: version },
  });

  return { ok: true, userId: user.id };
}
