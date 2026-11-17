import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "./db";

/**
 * Append-only audit log. The database rejects UPDATE/DELETE on audit_logs
 * (triggers), so entries are permanent.
 *
 * Rules: metadata must never contain passwords, tokens, message bodies or
 * other secrets. Writing an audit entry never breaks the user's request; a
 * failure is reported to the server log instead.
 */

export type AuditAction =
  | "auth.login.success"
  | "auth.login.failure"
  | "auth.login.rate_limited"
  | "auth.logout"
  | "mailbox.credential.updated";

export type AuditEntry = {
  organizationId: string;
  action: AuditAction;
  actorUserId?: string | null;
  mailboxId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Prisma.InputJsonObject;
};

export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await db().auditLog.create({
      data: {
        organizationId: entry.organizationId,
        action: entry.action,
        actorUserId: entry.actorUserId ?? null,
        mailboxId: entry.mailboxId ?? null,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        ipAddress: entry.ip ?? null,
        userAgent: entry.userAgent ?? null,
        metadata: entry.metadata ?? {},
      },
    });
  } catch (err) {
    console.error("[audit] failed to write entry", {
      action: entry.action,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Single-organisation deployments: the organisation to attribute anonymous events to. */
export async function defaultOrganizationId(): Promise<string | null> {
  const org = await db().organization.findFirst({ select: { id: true }, orderBy: { createdAt: "asc" } });
  return org?.id ?? null;
}
