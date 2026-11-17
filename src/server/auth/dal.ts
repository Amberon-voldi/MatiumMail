import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { db } from "../db";
import { sessionFromCookies, type SessionUser } from "./session";

/**
 * Data Access Layer — the ONLY way pages, actions and route handlers get the
 * current user or a mailbox. Every Server Action / Route Handler must call
 * `requireUser()` (or `requireMailboxAccess()`) itself; never trust the client.
 *
 * With Cache Components enabled, anything calling these reads the request
 * cookie and must render inside a <Suspense> boundary.
 */

/** Current session, de-duplicated within one request. */
export const getCurrentSession = cache(sessionFromCookies);

export async function requireUser(): Promise<SessionUser> {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  return session.user;
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
 * Redirects home when the user has no grant (without revealing whether the
 * mailbox exists) and throws when the grant is too weak for the action.
 */
export async function requireMailboxAccess(
  mailboxId: string,
  permission: MailboxPermission,
): Promise<AuthorizedMailbox> {
  const user = await requireUser();
  const access = await db().mailboxAccess.findUnique({
    where: { userId_mailboxId: { userId: user.id, mailboxId } },
    select: { role: true, mailbox: { select: { status: true } } },
  });
  if (!access || access.mailbox.status === "DISABLED") redirect("/");
  if (!roleAllows(access.role, permission)) {
    throw new Error(`Not permitted: ${permission}`);
  }
  return { mailboxId, userId: user.id, role: access.role };
}
