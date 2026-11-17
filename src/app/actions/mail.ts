"use server";

import { z } from "zod";
import { requireMailboxAccess } from "@/server/auth/dal";
import { consume } from "@/server/auth/rate-limit";
import { MailboxUnavailableError, MailServerError } from "@/server/mail/client";
import { MessageNotFoundError, moveMessages, setFlags, trashMessages } from "@/server/mail/messages";
import { SendError, sendMessage } from "@/server/mail/smtp";
import { syncMailbox, type SyncResult } from "@/server/mail/sync";

/**
 * Mail Server Actions. Each one re-authorises against the mailbox (never trust
 * the client), validates input, and maps internal errors to plain messages.
 */

export type ActionResult<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

const uuid = z.uuid();
const ids = z.array(z.uuid()).min(1).max(500);

function failure(err: unknown): { ok: false; error: string } {
  if (err instanceof MailboxUnavailableError || err instanceof MailServerError || err instanceof SendError) {
    return { ok: false, error: err.message };
  }
  if (err instanceof MessageNotFoundError) return { ok: false, error: err.message };
  console.error("[mail action]", err instanceof Error ? err.message : err);
  return { ok: false, error: "Something went wrong. Please try again." };
}

export async function syncNowAction(mailboxId: string, scope: "inbox" | "all" = "inbox"): Promise<ActionResult<SyncResult>> {
  const id = uuid.parse(mailboxId);
  await requireMailboxAccess(id, "read");
  try {
    return { ok: true, data: await syncMailbox(id, { scope: scope === "all" ? "all" : "inbox" }) };
  } catch (err) {
    return failure(err);
  }
}

export async function setFlagsAction(
  mailboxId: string,
  messageIds: string[],
  change: { seen?: boolean; flagged?: boolean },
): Promise<ActionResult> {
  const auth = await requireMailboxAccess(uuid.parse(mailboxId), "organise");
  const parsed = z.object({ seen: z.boolean().optional(), flagged: z.boolean().optional() }).parse(change);
  try {
    await setFlags(auth, ids.parse(messageIds), parsed);
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
}

export async function moveAction(mailboxId: string, messageIds: string[], folderId: string): Promise<ActionResult<number>> {
  const auth = await requireMailboxAccess(uuid.parse(mailboxId), "organise");
  try {
    return { ok: true, data: await moveMessages(auth, ids.parse(messageIds), uuid.parse(folderId)) };
  } catch (err) {
    return failure(err);
  }
}

export async function trashAction(mailboxId: string, messageIds: string[]): Promise<ActionResult<number>> {
  const auth = await requireMailboxAccess(uuid.parse(mailboxId), "organise");
  try {
    return { ok: true, data: await trashMessages(auth, ids.parse(messageIds)) };
  } catch (err) {
    return failure(err);
  }
}

// ── Sending ─────────────────────────────────────────────────────────────────

const addressList = z
  .string()
  .max(10_000)
  .transform((s) =>
    s
      .split(/[,;\n]/)
      .map((x) => x.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.email({ message: "One of the addresses isn't valid." })).max(100));

const sendSchema = z
  .object({
    to: addressList,
    cc: addressList,
    bcc: addressList,
    subject: z.string().max(998),
    body: z.string().max(500_000),
    inReplyTo: z.string().max(512).optional(),
  })
  .refine((m) => m.to.length + m.cc.length + m.bcc.length > 0, { message: "Add at least one recipient." });

export type SendValues = { to: string; cc: string; bcc: string; subject: string; body: string };
/** On failure the submitted values come back so the form can keep them (React resets forms after actions). */
export type SendState = { error?: string; sent?: boolean; values?: SendValues };

export async function sendAction(mailboxId: string, _prev: SendState, form: FormData): Promise<SendState> {
  const auth = await requireMailboxAccess(uuid.parse(mailboxId), "send");
  const values: SendValues = {
    to: String(form.get("to") ?? ""),
    cc: String(form.get("cc") ?? ""),
    bcc: String(form.get("bcc") ?? ""),
    subject: String(form.get("subject") ?? ""),
    body: String(form.get("body") ?? ""),
  };
  const parsed = sendSchema.safeParse({
    ...values,
    inReplyTo: form.get("inReplyTo") ? String(form.get("inReplyTo")) : undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the message and try again.", values };

  // Guard against runaway sending from a compromised session or a bug.
  const limit = await consume({ key: `send:${auth.mailboxId}`, max: 30, windowMs: 10 * 60_000, blockMs: 10 * 60_000 });
  if (!limit.allowed) return { error: "Sending limit reached. Please wait a few minutes.", values };

  try {
    const m = parsed.data;
    await sendMessage(auth, {
      to: m.to,
      cc: m.cc,
      bcc: m.bcc,
      subject: m.subject,
      text: m.body,
      inReplyTo: m.inReplyTo ?? null,
      references: m.inReplyTo ? [m.inReplyTo] : [],
    });
    return { sent: true };
  } catch (err) {
    return { error: failure(err).error, values };
  }
}
