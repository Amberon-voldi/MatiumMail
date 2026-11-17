import "server-only";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { db } from "../db";
import { env } from "../env";
import { randomToken, sha256Hex } from "../crypto/tokens";
import { MAX_ACCOUNTS, SESSION_COOKIE, parseSessionCookie, serializeSessionCookie } from "./cookie";

/**
 * Opaque server-side sessions, one per signed-in account; a browser can be
 * signed in to several accounts at once (see MAX_ACCOUNTS).
 *
 * - The cookie holds random 256-bit tokens, most recent sign-in first. Only
 *   SHA-256(token) is stored, so a database leak cannot be turned into a
 *   working session.
 * - Every session has its own idle timeout (slides with activity) and
 *   absolute lifetime (never moves).
 * - `lastSeenAt` is refreshed at most every 5 minutes to keep writes to the
 *   remote database low.
 */

const TOUCH_INTERVAL_MS = 5 * 60_000;

export type SessionUser = {
  id: string;
  email: string;
  displayName: string | null;
  role: "OWNER" | "ADMIN" | "MEMBER";
  organizationId: string;
};

export type ValidSession = {
  sessionId: string;
  user: SessionUser;
};

type CookieSession = ValidSession & { token: string; absoluteExpiresAt: Date };

function lifetimes(now: number) {
  const e = env();
  const absolute = now + e.SESSION_ABSOLUTE_DAYS * 86_400_000;
  const idle = now + e.SESSION_IDLE_HOURS * 3_600_000;
  return { absolute, idle: Math.min(idle, absolute) };
}

/** Look up the cookie's tokens in one query; keeps cookie order, deletes expired sessions. */
async function validateTokens(tokens: string[]): Promise<CookieSession[]> {
  if (tokens.length === 0) return [];
  const ids = tokens.map(sha256Hex);
  const p = db();
  const rows = await p.session.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      expiresAt: true,
      absoluteExpiresAt: true,
      lastSeenAt: true,
      user: {
        select: { id: true, email: true, displayName: true, role: true, status: true, organizationId: true },
      },
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));

  const now = Date.now();
  const expired: string[] = [];
  const valid: CookieSession[] = [];
  const touches: Promise<unknown>[] = [];
  tokens.forEach((token, i) => {
    const row = byId.get(ids[i]);
    if (!row) return;
    if (row.expiresAt.getTime() <= now || row.absoluteExpiresAt.getTime() <= now) {
      expired.push(row.id);
      return;
    }
    if (row.user.status !== "ACTIVE") return;
    // The same account twice can't normally happen; keep the newest.
    if (valid.some((s) => s.user.id === row.user.id)) return;
    if (now - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      const idle = Math.min(now + env().SESSION_IDLE_HOURS * 3_600_000, row.absoluteExpiresAt.getTime());
      touches.push(
        p.session
          .update({ where: { id: row.id }, data: { lastSeenAt: new Date(now), expiresAt: new Date(idle) } })
          .catch(() => {}),
      );
    }
    const { id: userId, email, displayName, role, organizationId } = row.user;
    valid.push({
      token,
      sessionId: row.id,
      absoluteExpiresAt: row.absoluteExpiresAt,
      user: { id: userId, email, displayName, role, organizationId },
    });
  });
  if (expired.length > 0) {
    touches.push(p.session.deleteMany({ where: { id: { in: expired } } }).catch(() => {}));
  }
  await Promise.all(touches);
  return valid;
}

type CookieJar = Awaited<ReturnType<typeof cookies>>;

/** Rewrite the cookie; it lives as long as the longest-lived session in it. */
function writeCookie(jar: CookieJar, sessions: { token: string; absoluteExpiresAt: Date }[]): void {
  if (sessions.length === 0) {
    jar.delete(SESSION_COOKIE);
    return;
  }
  jar.set(SESSION_COOKIE, serializeSessionCookie(sessions.map((s) => s.token)), {
    httpOnly: true,
    secure: env().NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: new Date(Math.max(...sessions.map((s) => s.absoluteExpiresAt.getTime()))),
  });
}

/**
 * Create a session row and add it to the browser's signed-in accounts, first
 * in line. Signing in again to an account that is already here replaces its
 * session; past MAX_ACCOUNTS the oldest sign-in is dropped.
 * Call only from a Server Action / Route Handler.
 */
export async function createSession(userId: string, ctx: { ip: string; userAgent: string | null }): Promise<void> {
  const token = randomToken();
  const now = Date.now();
  const { absolute, idle } = lifetimes(now);
  const p = db();
  await p.session.create({
    data: {
      id: sha256Hex(token),
      userId,
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent,
      expiresAt: new Date(idle),
      absoluteExpiresAt: new Date(absolute),
    },
  });

  const jar = await cookies();
  const existing = await validateTokens(parseSessionCookie(jar.get(SESSION_COOKIE)?.value));
  const others = existing.filter((s) => s.user.id !== userId);
  const kept = others.slice(0, MAX_ACCOUNTS - 1);
  const dropped = existing.filter((s) => !kept.includes(s));
  if (dropped.length > 0) {
    await p.session.deleteMany({ where: { id: { in: dropped.map((s) => s.sessionId) } } }).catch(() => {});
  }
  writeCookie(jar, [{ token, absoluteExpiresAt: new Date(absolute) }, ...kept]);
}

/** Every signed-in account in this browser, most recent sign-in first. */
export async function sessionsFromCookies(): Promise<ValidSession[]> {
  // Session checks compare expiry times with the current clock, which must
  // never happen during prerendering (Cache Components). connection() stops
  // prerendering here so everything below runs only at request time.
  await connection();
  const sessions = await validateTokens(parseSessionCookie((await cookies()).get(SESSION_COOKIE)?.value));
  return sessions.map(({ sessionId, user }) => ({ sessionId, user }));
}

/**
 * Sign one account out of this browser, or all of them when `userId` is
 * omitted. Returns the sessions that ended and how many accounts remain.
 * Server Action only.
 */
export async function destroySessions(userId?: string): Promise<{ ended: ValidSession[]; remaining: number }> {
  const jar = await cookies();
  const tokens = parseSessionCookie(jar.get(SESSION_COOKIE)?.value);
  const sessions = await validateTokens(tokens);
  const ended = userId ? sessions.filter((s) => s.user.id === userId) : sessions;
  const kept = userId ? sessions.filter((s) => s.user.id !== userId) : [];
  // Signing out of everything also clears tokens that no longer validate.
  const ids = userId ? ended.map((s) => s.sessionId) : tokens.map(sha256Hex);
  if (ids.length > 0) {
    await db()
      .session.deleteMany({ where: { id: { in: ids } } })
      .catch(() => {});
  }
  writeCookie(jar, kept);
  return { ended: ended.map(({ sessionId, user }) => ({ sessionId, user })), remaining: kept.length };
}

/** Sign a user out everywhere (e.g. after a security event). */
export async function destroyAllSessionsForUser(userId: string): Promise<void> {
  await db().session.deleteMany({ where: { userId } });
}
