import "server-only";
import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { checkMailboxAccess, type AuthorizedMailbox, type MailboxPermission } from "./auth/dal";
import { MailboxUnavailableError, MailServerError } from "./mail/client";
import { AttachmentTooLargeError, MailActionError, MessageNotFoundError } from "./mail/messages";
import { SendError } from "./mail/smtp";
import { isMissingTable, UploadError } from "./mail/uploads";

/**
 * Shared plumbing for the mail JSON API (src/app/api/mail). Every handler
 * goes through mailboxRoute(), which:
 *   - refuses cross-site mutations (Origin must match Host; on top of the
 *     SameSite=Lax session cookie),
 *   - authorises the mailbox for the signed-in accounts (JSON 401/403/404,
 *     never a redirect),
 *   - turns internal errors into short, safe messages.
 */

const NO_STORE = { "Cache-Control": "private, no-store" };

export function json(data: unknown, init: ResponseInit = {}): Response {
  return NextResponse.json(data, { ...init, headers: { ...NO_STORE, ...(init.headers as Record<string, string> | undefined) } });
}

export function apiError(status: number, error: string, code?: string): Response {
  return json(code ? { error, code } : { error }, { status });
}

/** Same check Next.js applies to Server Actions: the Origin's host must be this host. */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const DENIED: Record<401 | 403 | 404, [string, string]> = {
  401: ["Your session has ended. Please sign in again.", "unauthenticated"],
  403: ["You don't have permission to do that in this mailbox.", "forbidden"],
  404: ["Not found.", "not_found"],
};

export async function mailboxRoute(
  request: Request,
  params: Promise<{ mailboxId: string }>,
  permission: MailboxPermission,
  handler: (auth: AuthorizedMailbox) => Promise<Response>,
): Promise<Response> {
  const mutation = request.method !== "GET" && request.method !== "HEAD";
  if (mutation && !isSameOrigin(request)) return apiError(403, "Cross-site request refused.", "forbidden");
  const { mailboxId } = await params;
  if (!z.uuid().safeParse(mailboxId).success) return apiError(404, ...DENIED[404]);
  try {
    const check = await checkMailboxAccess(mailboxId, permission);
    if (!check.ok) return apiError(check.status, ...DENIED[check.status]);
    return await handler(check.auth);
  } catch (err) {
    return errorResponse(err);
  }
}

export function errorResponse(err: unknown): Response {
  if (err instanceof MailboxUnavailableError) {
    return apiError(409, err.message, err.status === "NEEDS_REAUTH" ? "needs_reauth" : "unavailable");
  }
  if (err instanceof MailServerError) {
    return err.reason === "auth_failed" ? apiError(409, err.message, "needs_reauth") : apiError(503, err.message, "mail_server");
  }
  if (err instanceof MessageNotFoundError) return apiError(404, err.message, "not_found");
  if (err instanceof AttachmentTooLargeError) return apiError(413, err.message, "too_large");
  if (err instanceof SendError) return apiError(422, err.message, "send_failed");
  if (err instanceof UploadError) return apiError(err.status, err.message, "upload");
  if (err instanceof MailActionError) return apiError(422, err.message, "action");
  if (err instanceof ZodError) return apiError(400, err.issues[0]?.message ?? "Invalid request.", "invalid");
  if (err instanceof SyntaxError) return apiError(400, "Invalid request.", "invalid");
  if (isMissingTable(err)) {
    return apiError(503, "Attachments need a database update. Ask the administrator to run the latest migration.", "migration_required");
  }
  if (err instanceof Error && /^Not permitted/.test(err.message)) return apiError(403, ...DENIED[403]);
  console.error("[api]", err instanceof Error ? `${err.name}: ${err.message}` : err);
  return apiError(500, "Something went wrong. Please try again.", "internal");
}

/** Parse a JSON body against a schema (throws ZodError / SyntaxError → 400). */
export async function readJson<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  const text = await request.text();
  if (text.length > 6_000_000) throw new UploadError("Request too large.", 413);
  return schema.parse(JSON.parse(text || "{}"));
}
