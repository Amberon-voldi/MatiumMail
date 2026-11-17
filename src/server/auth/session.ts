import "server-only";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { db } from "../db";
import { env } from "../env";
import { randomToken, sha256Hex } from "../crypto/tokens";
import { SESSION_COOKIE } from "./cookie";

/**
 * Opaque server-side sessions.
 *
 * - The cookie holds a random 256-bit token. Only SHA-256(token) is stored, so
 *   a database leak cannot be turned into a working session.
 * - Idle timeout slides with activity; the absolute lifetime never moves.
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

function lifetimes(now: number) {
  const e = env();
  const absolute = now + e.SESSION_ABSOLUTE_DAYS * 86_400_000;
  const idle = now + e.SESSION_IDLE_HOURS * 3_600_000;
  return { absolute, idle: Math.min(idle, absolute) };
}

/** Create a session row and set the cookie. Call only from a Server Action / Route Handler. */
export async function createSession(userId: string, ctx: { ip: string; userAgent: string | null }): Promise<void> {
  const token = randomToken();
  const now = Date.now();
  const { absolute, idle } = lifetimes(now);
  await db().session.create({
    data: {
      id: sha256Hex(token),
      userId,
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent,
      expiresAt: new Date(idle),
      absoluteExpiresAt: new Date(absolute),
    },
  });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env().NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: new Date(absolute),
  });
}

/** Look up a session by its cookie token; deletes it if expired. */
export async function validateSessionToken(token: string): Promise<ValidSession | null> {
  if (!token || token.length > 128) return null;
  const id = sha256Hex(token);
  const p = db();
  const row = await p.session.findUnique({
    where: { id },
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
  if (!row) return null;

  const now = Date.now();
  if (row.expiresAt.getTime() <= now || row.absoluteExpiresAt.getTime() <= now) {
    await p.session.delete({ where: { id } }).catch(() => {});
    return null;
  }
  if (row.user.status !== "ACTIVE") return null;

  if (now - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    const idle = Math.min(now + env().SESSION_IDLE_HOURS * 3_600_000, row.absoluteExpiresAt.getTime());
    await p.session
      .update({ where: { id }, data: { lastSeenAt: new Date(now), expiresAt: new Date(idle) } })
      .catch(() => {});
  }

  const { id: userId, email, displayName, role, organizationId } = row.user;
  return { sessionId: row.id, user: { id: userId, email, displayName, role, organizationId } };
}

/** Read and validate the session from the request cookie. */
export async function sessionFromCookies(): Promise<ValidSession | null> {
  // Session checks compare expiry times with the current clock, which must
  // never happen during prerendering (Cache Components). connection() stops
  // prerendering here so everything below runs only at request time.
  await connection();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? validateSessionToken(token) : null;
}

/** Delete the current session (if any) and clear the cookie. Server Action only. */
export async function destroyCurrentSession(): Promise<ValidSession | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  let session: ValidSession | null = null;
  if (token) {
    session = await validateSessionToken(token);
    await db()
      .session.delete({ where: { id: sha256Hex(token) } })
      .catch(() => {});
  }
  jar.delete(SESSION_COOKIE);
  return session;
}

/** Sign a user out everywhere (e.g. after a security event). */
export async function destroyAllSessionsForUser(userId: string): Promise<void> {
  await db().session.deleteMany({ where: { userId } });
}
