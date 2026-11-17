import "server-only";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { MAX_ATTACHMENTS_BYTES, type SendRequest } from "@/lib/mail-types";
import type { AuthorizedMailbox } from "../auth/dal";
import { db } from "../db";
import { loadMailboxConnection, withImap } from "./client";
import {
  forwardQuoteHtml,
  forwardQuoteText,
  htmlToText,
  quotableHtml,
  quoteText,
  replyQuoteHtml,
  sanitizeOutgoingHtml,
  wrapOutgoingHtml,
} from "./compose-html";
import {
  fetchAttachmentContents,
  formatAddr,
  MessageNotFoundError,
  parseSourceForCompose,
  quoteDateFormat,
  rememberRecipients,
  setFlags,
} from "./messages";
import { escapeHtml } from "./sanitize";
import { buildMime, sendMessage, SendError, type OutgoingAttachment, type OutgoingMessage, type SendResult } from "./smtp";
import { isPartId } from "./structure";
import { referencesOf, toAddrList } from "./threads";
import { deleteUploads, loadUploads } from "./uploads";

/**
 * Turning a composer request into a real message: threading headers for
 * replies, the quoted original, forwarded attachments, uploaded files and
 * pasted images (as inline cid: attachments, which every client displays).
 * Drafts are saved to the IMAP Drafts folder, tagged with the composer's
 * draft key so each save replaces the previous one and sending removes them.
 */

const DRAFT_HEADER = "X-Matium-Draft";

/** "Name <addr>" or "addr"; never CR/LF (header injection). */
const recipient = z
  .string()
  .max(400)
  .transform((s) => s.trim())
  .refine((s) => !/[\r\n]/.test(s), "Invalid recipient.")
  .refine((s) => {
    const m = /<([^<>\s]+)>\s*$/.exec(s) ?? /^([^\s<>,;]+)$/.exec(s);
    return Boolean(m && z.email().safeParse(m[1]).success);
  }, "One of the addresses isn't valid.");

export const sendRequestSchema = z
  .object({
    mode: z.enum(["new", "reply", "replyAll", "forward", "draft"]),
    sourceId: z.uuid().nullable(),
    draftKey: z.uuid().nullable(),
    to: z.array(recipient).max(100),
    cc: z.array(recipient).max(100),
    bcc: z.array(recipient).max(100),
    subject: z
      .string()
      .max(998)
      .transform((s) => s.replace(/[\r\n]+/g, " ")),
    html: z.string().max(5_000_000),
    includeQuote: z.boolean(),
    forwardParts: z.array(z.string().refine(isPartId)).max(50),
    uploadIds: z.array(z.uuid()).max(30),
  })
  .refine((r) => r.mode === "new" || r.sourceId, { message: "Missing original message." });

const isReply = (mode: SendRequest["mode"]) => mode === "reply" || mode === "replyAll";

async function buildOutgoing(auth: AuthorizedMailbox, req: SendRequest): Promise<OutgoingMessage> {
  let html = sanitizeOutgoingHtml(req.html);
  const attachments: OutgoingAttachment[] = [];

  // Pasted images become inline attachments (data: URLs are blocked by most clients).
  let pasted = 0;
  html = html.replace(
    /<img\b([^>]*?)\bsrc="data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=\s]+)"/gi,
    (_m, before: string, type: string, b64: string) => {
      const cid = `${randomBytes(8).toString("hex")}@matium.mail`;
      const ext = type.split("/")[1].replace("jpeg", "jpg");
      attachments.push({ filename: `image-${++pasted}.${ext}`, contentType: type, content: Buffer.from(b64, "base64"), cid });
      return `<img${before}src="cid:${cid}"`;
    },
  );
  let text = htmlToText(html);
  let inReplyTo: string | null = null;
  let references: string[] = [];

  if (req.sourceId && req.mode !== "new") {
    const meta = await db().messageMeta.findFirst({
      where: { id: req.sourceId, mailboxId: auth.mailboxId },
      select: {
        messageIdHeader: true,
        inReplyTo: true,
        references: true,
        fromName: true,
        fromAddress: true,
        toAddrs: true,
        ccAddrs: true,
        sentAt: true,
        internalDate: true,
      },
    });
    if (!meta) throw new MessageNotFoundError();

    if (isReply(req.mode)) {
      inReplyTo = meta.messageIdHeader;
      references = [...referencesOf(meta.references), meta.messageIdHeader]
        .filter((r): r is string => Boolean(r))
        .slice(-20);
    } else if (req.mode === "draft") {
      inReplyTo = meta.inReplyTo;
      references = referencesOf(meta.references);
    }

    if ((isReply(req.mode) && req.includeQuote) || req.mode === "forward") {
      const { parsed } = await parseSourceForCompose(auth, req.sourceId);
      const original = quotableHtml(parsed.html || parsed.textAsHtml || `<pre>${escapeHtml(parsed.text ?? "")}</pre>`);
      const originalText = parsed.text ?? htmlToText(original);
      const fromText = formatAddr({ name: meta.fromName, address: meta.fromAddress }) || parsed.from?.text || "";
      const dateText = quoteDateFormat.format(parsed.date ?? meta.sentAt ?? meta.internalDate);
      if (req.mode === "forward") {
        const list = (v: unknown) => toAddrList(v).map(formatAddr).join(", ");
        const fields: Array<[string, string]> = [
          ["From", fromText],
          ["Date", dateText],
          ["Subject", parsed.subject ?? ""],
          ["To", list(meta.toAddrs)],
          ["Cc", list(meta.ccAddrs)],
        ];
        html += forwardQuoteHtml(fields, original);
        text += forwardQuoteText(fields, originalText);
      } else {
        const label = `On ${dateText}, ${fromText} wrote:`;
        html += replyQuoteHtml(label, original);
        text += `\n\n${label}\n${quoteText(originalText)}`;
      }
      // Images shown inside the quoted original travel along with their Content-IDs.
      for (const a of parsed.attachments) {
        if (a.cid && original.includes(`cid:${a.cid}`)) {
          attachments.push({ filename: a.filename ?? "image", contentType: a.contentType, content: a.content, cid: a.cid });
        }
      }
    }

    if ((req.mode === "forward" || req.mode === "draft") && req.forwardParts.length) {
      attachments.push(...(await fetchAttachmentContents(auth, req.sourceId, req.forwardParts, MAX_ATTACHMENTS_BYTES)));
    }
  }

  attachments.push(...(await loadUploads(auth, req.uploadIds)));
  const total = attachments.reduce((sum, a) => sum + a.content.length, 0);
  if (total > MAX_ATTACHMENTS_BYTES * 1.1) {
    throw new SendError(`Attachments can be up to ${Math.round(MAX_ATTACHMENTS_BYTES / 1024 / 1024)} MB in total.`);
  }

  return {
    to: req.to,
    cc: req.cc,
    bcc: req.bcc,
    subject: req.subject,
    text,
    html: wrapOutgoingHtml(html),
    inReplyTo,
    references,
    attachments,
    headers: req.draftKey ? { [DRAFT_HEADER]: req.draftKey } : undefined,
  };
}

/**
 * Remove this composer's saved drafts (and, when sending, the draft it was
 * opened from), except `keepUid`. Never throws.
 */
async function removeDrafts(
  auth: AuthorizedMailbox,
  draftKey: string | null,
  draftMessageId: string | null,
  keepUid?: number,
): Promise<void> {
  try {
    const p = db();
    const drafts = await p.mailFolder.findFirst({
      where: { mailboxId: auth.mailboxId, specialUse: "DRAFTS" },
      select: { id: true, path: true },
    });
    if (!drafts || (!draftKey && !draftMessageId)) return;
    const opened = draftMessageId
      ? await p.messageMeta.findFirst({
          where: { id: draftMessageId, mailboxId: auth.mailboxId, folderId: drafts.id },
          select: { uid: true },
        })
      : null;
    const removed = await withImap(auth.mailboxId, async (client) => {
      const lock = await client.getMailboxLock(drafts.path);
      try {
        const uids = new Set<number>();
        if (draftKey) {
          const found = await client.search({ header: { [DRAFT_HEADER.toLowerCase()]: draftKey } }, { uid: true });
          if (Array.isArray(found)) found.forEach((u) => uids.add(u));
        }
        if (opened) uids.add(Number(opened.uid));
        if (keepUid !== undefined) uids.delete(keepUid);
        if (uids.size) await client.messageDelete([...uids].join(","), { uid: true });
        return [...uids];
      } finally {
        lock.release();
      }
    });
    if (removed.length) {
      await p.messageMeta.deleteMany({ where: { folderId: drafts.id, uid: { in: removed.map((u) => BigInt(u)) } } });
    }
  } catch (err) {
    console.error("[compose] draft clean-up failed", err instanceof Error ? err.message : err);
  }
}

export async function sendFromRequest(auth: AuthorizedMailbox, req: SendRequest): Promise<SendResult> {
  if (req.to.length + req.cc.length + req.bcc.length === 0) throw new SendError("Add at least one recipient.");
  const msg = await buildOutgoing(auth, req);
  const result = await sendMessage(auth, msg);
  // Housekeeping after a successful send never turns it into a failure.
  await Promise.allSettled([
    deleteUploads(auth, req.uploadIds),
    rememberRecipients(auth.mailboxId, [...req.to, ...req.cc, ...req.bcc]),
    isReply(req.mode) && req.sourceId ? setFlags(auth, [req.sourceId], { answered: true }) : Promise.resolve(),
    removeDrafts(auth, req.draftKey, req.mode === "draft" ? req.sourceId : null),
  ]);
  return result;
}

/**
 * Save (or replace) the composer's draft in the Drafts folder. A draft that
 * was opened from Drafts stays until the message is sent, because later saves
 * still read its attachments and threading headers.
 */
export async function saveDraft(auth: AuthorizedMailbox, req: SendRequest): Promise<{ saved: boolean }> {
  if (!req.draftKey) throw new SendError("Missing draft key.");
  const drafts = await db().mailFolder.findFirst({
    where: { mailboxId: auth.mailboxId, specialUse: "DRAFTS" },
    select: { path: true },
  });
  if (!drafts) throw new SendError("This mailbox has no Drafts folder.");
  const msg = await buildOutgoing(auth, req);
  const conn = await loadMailboxConnection(auth.mailboxId);
  const { raw } = await buildMime(conn, msg, { keepBcc: true });
  const appended = await withImap(auth.mailboxId, (client) => client.append(drafts.path, raw, ["\\Draft", "\\Seen"]));
  const uid = appended && typeof appended === "object" && "uid" in appended ? Number(appended.uid) : undefined;
  // Without UIDPLUS the new copy's UID is unknown; keep everything rather than risk deleting it.
  if (uid !== undefined && Number.isFinite(uid)) await removeDrafts(auth, req.draftKey, null, uid);
  return { saved: true };
}

/** Discard the composer's saved drafts (the user closed it with "Discard"). */
export async function discardDraft(auth: AuthorizedMailbox, draftKey: string, uploadIds: string[]): Promise<void> {
  await Promise.allSettled([removeDrafts(auth, draftKey, null), deleteUploads(auth, uploadIds)]);
}
