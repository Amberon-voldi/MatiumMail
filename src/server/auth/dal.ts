import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { db } from "../db";
import { sessionsFromCookies, type SessionUser } from "./session";

/**
 * Data Access Layer — the ONLY way pages, actions and route handlers get the
 * current user or a mailbox. Every Server Action / Route Handler must call
 * `requireUser()` / `requireSignedInUser()` (or `requireMailboxAccess()`)
 * itself; never trust the client.
 *
 * A browser can be signed in to several accounts. A mailbox is usable when
 * ANY of them has a grant for it, so every account's mail is open at once.
 *
 * With Cache Components enabled, anything calling these reads the request
 * cookie and must render inside a <Suspense> boundary.
 */

/** Signed-in accounts (most recent sign-in first), de-duplicated within one request. */
export const getCurrentSessions = cache(sessionsFromCookies);

/** The most recently signed-in account. */
export async function requireUser(): Promise<SessionUser> {
  const [session] = await getCurrentSessions();
  if (!session) redirect("/login");
  return session.user;
}

/** Every signed-in account, most recent sign-in first. */
export async function requireUsers(): Promise<SessionUser[]> {
  const sessions = await getCurrentSessions();
  if (sessions.length === 0) redirect("/login");
  return sessions.map((s) => s.user);
}

/** One particular signed-in account; anything else goes home without saying whether it exists. */
export async function requireSignedInUser(userId: string): Promise<SessionUser> {
  const user = (await requireUsers()).find((u) => u.id === userId);
  if (!user) redirect("/");
  return user;
}

export type MailboxPermission = "read" | "send" | "organise" | "manage";
type AccessRole = "OWNER" | "DELEGATE" | "READ_ONLY";

const ALLOWED: Record<AccessRole, ReadonlySet<MailboxPermission>> = {
  OWNER: new Set(["read", "send", "organise", "manage"]),
  DELEGATE: new Set(["read", "send", "organise"]),
  READ_ONLY: new Set(["read"]),
};

export function roleAllows(role: AccessRole, permission: MailboxPermission): boolean {
  return ALLOWED[role].has(permission);
}

export type MailboxSummary = {
  id: string;
  address: string;
  displayName: string | null;
  status: string;
  role: AccessRole;
  quotaUsedBytes: bigint | null;
  quotaLimitBytes: bigint | null;
};

/** Mailboxes the user has been explicitly granted, oldest grant first. */
export async function listMailboxesForUser(userId: string): Promise<MailboxSummary[]> {
  const rows = await db().mailboxAccess.findMany({
    where: { userId, mailbox: { status: { not: "DISABLED" } } },
    orderBy: { createdAt: "asc" },
    select: {
      role: true,
      mailbox: {
        select: {
          id: true,
          address: true,
          displayName: true,
          status: true,
          quotaUsedBytes: true,
          quotaLimitBytes: true,
        },
      },
    },
  });
  return rows.map((r) => ({ ...r.mailbox, role: r.role }));
}

/** A mailbox the current user may act on. Construct only via requireMailboxAccess(). */
export type AuthorizedMailbox = {
  readonly mailboxId: string;
  readonly userId: string;
  readonly role: AccessRole;
};

/**
 * Acts as the first signed-in account whose grant allows `permission`.
 * Redirects home when no account has a grant (without revealing whether the
 * mailbox exists) and throws when every grant is too weak for the action.
 */
export async function requireMailboxAccess(
  mailboxId: string,
  permission: MailboxPermission,
): Promise<AuthorizedMailbox> {
  const users = await requireUsers();
  const grants = await db().mailboxAccess.findMany({
    where: { mailboxId, userId: { in: users.map((u) => u.id) } },
    select: { userId: true, role: true, mailbox: { select: { status: true } } },
  });
  if (grants.length === 0 || grants[0].mailbox.status === "DISABLED") redirect("/");
  const order = (userId: string) => users.findIndex((u) => u.id === userId);
  const grant = grants
    .filter((g) => roleAllows(g.role, permission))
    .sort((a, b) => order(a.userId) - order(b.userId))[0];
  if (!grant) {
    throw new Error(`Not permitted: ${permission}`);
  }
  return { mailboxId, userId: grant.userId, role: grant.role };
}
