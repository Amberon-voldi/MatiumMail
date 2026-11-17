import "server-only";
import { simpleParser } from "mailparser";
import type { FolderSpecialUse } from "@/generated/prisma/client";
import { audit } from "../audit";
import type { AuthorizedMailbox } from "../auth/dal";
import { roleAllows, type MailboxPermission } from "../auth/dal";
import { db } from "../db";
import { withImap } from "./client";
import { emailDocument, escapeHtml, hasBlockedRemoteImages, sanitizeEmailHtml } from "./sanitize";

/**
 * Reading and organising messages. Every function takes an AuthorizedMailbox
 * (from requireMailboxAccess) and scopes every query to that mailbox, so a
 * message id from another mailbox simply isn't found.
 */

const MAX_PARSE_BYTES = 30 * 1024 * 1024;
const ROLE_ORDER: FolderSpecialUse[] = ["INBOX", "DRAFTS", "SENT", "ARCHIVE", "JUNK", "TRASH", "FLAGGED", "ALL", "NONE"];

export class MessageNotFoundError extends Error {
  constructor() {
    super("That message no longer exists on the server.");
    this.name = "MessageNotFoundError";
  }
}

function assertPermission(auth: AuthorizedMailbox, permission: MailboxPermission) {
  if (!roleAllows(auth.role, permission)) throw new Error(`Not permitted: ${permission}`);
}

// ── Listing (database only, fast) ───────────────────────────────────────────

export async function mailboxOverview(auth: AuthorizedMailbox) {
  return db().mailbox.findUniqueOrThrow({
    where: { id: auth.mailboxId },
    select: { id: true, address: true, displayName: true, status: true, statusReason: true, lastSyncAt: true },
  });
}

/** Defaults for replying to a message: recipient, "Re:" subject, threading header. */
export async function replyContext(auth: AuthorizedMailbox, messageId: string) {
  const m = await db().messageMeta.findFirst({
    where: { id: messageId, mailboxId: auth.mailboxId },
    select: { subject: true, fromAddress: true, replyTo: true, messageIdHeader: true },
  });
  if (!m) return null;
  const replyTo = Array.isArray(m.replyTo) ? (m.replyTo as Array<{ address?: string | null }>)[0]?.address : null;
  const subject = m.subject ?? "";
  return {
    to: replyTo || m.fromAddress || "",
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    inReplyTo: m.messageIdHeader ?? undefined,
  };
}

export async function listFolders(auth: AuthorizedMailbox) {
  const folders = await db().mailFolder.findMany({
    where: { mailboxId: auth.mailboxId, selectable: true },
    select: { id: true, name: true, path: true, specialUse: true, totalCount: true, unreadCount: true },
  });
  return folders.sort(
    (a, b) => ROLE_ORDER.indexOf(a.specialUse) - ROLE_ORDER.indexOf(b.specialUse) || a.path.localeCompare(b.path),
  );
}

export type MessageSummary = Awaited<ReturnType<typeof listMessages>>["messages"][number];

export async function listMessages(auth: AuthorizedMailbox, folderId: string, opts: { take?: number; cursor?: string } = {}) {
  const take = Math.min(Math.max(opts.take ?? 50, 1), 100);
  const rows = await db().messageMeta.findMany({
    where: { mailboxId: auth.mailboxId, folderId },
    orderBy: [{ internalDate: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      subject: true,
      fromName: true,
      fromAddress: true,
      internalDate: true,
      isSeen: true,
      isFlagged: true,
      isAnswered: true,
      hasAttachments: true,
      preview: true,
      sizeBytes: true,
    },
  });
  const hasMore = rows.length > take;
  const messages = hasMore ? rows.slice(0, take) : rows;
  return { messages, nextCursor: hasMore ? messages[messages.length - 1].id : null };
}

// ── Opening a message (IMAP fetch + parse + sanitise) ───────────────────────

export type OpenedMessage = {
  id: string;
  subject: string;
  from: string;
  to: string;
  cc: string;
  date: string | null;
  /** Self-contained document for <iframe sandbox srcdoc>. */
  document: string;
  hasBlockedImages: boolean;
  attachments: Array<{ filename: string; contentType: string; size: number }>;
  isSeen: boolean;
  isFlagged: boolean;
};

export async function openMessage(
  auth: AuthorizedMailbox,
  messageId: string,
  opts: { allowRemoteImages?: boolean } = {},
): Promise<OpenedMessage> {
  assertPermission(auth, "read");
  const p = db();
  const meta = await p.messageMeta.findFirst({
    where: { id: messageId, mailboxId: auth.mailboxId },
    select: {
      id: true,
      uid: true,
      uidValidity: true,
      sizeBytes: true,
      preview: true,
      isSeen: true,
      isFlagged: true,
      folder: { select: { path: true } },
    },
  });
  if (!meta) throw new MessageNotFoundError();

  // Re-opening (or re-rendering after an action) shouldn't hit the mail server
  // again: parsed + sanitised bodies are cached briefly. Flags always come from
  // the database row above, so read/star state is never stale.
  const cacheKey = `${meta.id}:${meta.uidValidity}:${opts.allowRemoteImages ? 1 : 0}`;
  const cached = bodyCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return { ...cached.message, isSeen: meta.isSeen, isFlagged: meta.isFlagged };
  }

  if (meta.sizeBytes > MAX_PARSE_BYTES) {
    throw new Error("This message is too large to display here (over 30 MB).");
  }

  const source = await withImap(auth.mailboxId, async (client) => {
    const lock = await client.getMailboxLock(meta.folder.path, { readOnly: true });
    try {
      if (!client.mailbox || BigInt(client.mailbox.uidValidity) !== meta.uidValidity) return null;
      // BODY.PEEK[] — reading never sets \Seen implicitly.
      const msg = await client.fetchOne(String(meta.uid), { source: true }, { uid: true });
      return msg ? (msg.source ?? null) : null;
    } finally {
      lock.release();
    }
  });
  if (!source) {
    await p.messageMeta.delete({ where: { id: meta.id } }).catch(() => {});
    throw new MessageNotFoundError();
  }

  // mailparser inlines cid: images as data: URLs; the sanitiser keeps only raster ones.
  const parsed = await simpleParser(source);
  const rawHtml = parsed.html || parsed.textAsHtml || `<pre>${escapeHtml(parsed.text ?? "")}</pre>`;
  const clean = sanitizeEmailHtml(rawHtml);

  if (meta.preview === null && parsed.text) {
    const preview = parsed.text.replace(/\s+/g, " ").trim().slice(0, 280);
    await p.messageMeta.update({ where: { id: meta.id }, data: { preview } }).catch(() => {});
  }

  const fmt = (v: typeof parsed.to) => (Array.isArray(v) ? v.map((x) => x.text).join(", ") : (v?.text ?? ""));
  const opened: OpenedMessage = {
    id: meta.id,
    subject: parsed.subject ?? "(no subject)",
    from: parsed.from?.text ?? "",
    to: fmt(parsed.to),
    cc: fmt(parsed.cc),
    date: parsed.date ? parsed.date.toISOString() : null,
    document: emailDocument(clean, { allowRemoteImages: opts.allowRemoteImages }),
    hasBlockedImages: hasBlockedRemoteImages(clean),
    attachments: parsed.attachments
      .filter((a) => !a.related)
      .map((a) => ({ filename: a.filename ?? "attachment", contentType: a.contentType, size: a.size })),
    isSeen: meta.isSeen,
    isFlagged: meta.isFlagged,
  };
  cacheBody(cacheKey, opened);
  return opened;
}

// Small in-memory LRU of opened messages (per server instance).
const BODY_TTL_MS = 10 * 60_000;
const BODY_MAX = 100;
const gb = globalThis as unknown as { __matiumBodies?: Map<string, { message: OpenedMessage; expires: number }> };
const bodyCache = (gb.__matiumBodies ??= new Map());

function cacheBody(key: string, message: OpenedMessage): void {
  bodyCache.delete(key);
  bodyCache.set(key, { message, expires: Date.now() + BODY_TTL_MS });
  while (bodyCache.size > BODY_MAX) bodyCache.delete(bodyCache.keys().next().value!);
}

// ── Organising (IMAP first, then mirror into the cache) ─────────────────────

type Grouped = Map<string, { path: string; ids: string[]; uids: number[] }>;

async function groupByFolder(auth: AuthorizedMailbox, ids: string[]): Promise<Grouped> {
  const rows = await db().messageMeta.findMany({
    where: { id: { in: ids.slice(0, 500) }, mailboxId: auth.mailboxId },
    select: { id: true, uid: true, folder: { select: { id: true, path: true } } },
  });
  const groups: Grouped = new Map();
  for (const r of rows) {
    const g = groups.get(r.folder.id) ?? { path: r.folder.path, ids: [], uids: [] };
    g.ids.push(r.id);
    g.uids.push(Number(r.uid));
    groups.set(r.folder.id, g);
  }
  return groups;
}

export async function setFlags(
  auth: AuthorizedMailbox,
  ids: string[],
  change: { seen?: boolean; flagged?: boolean },
): Promise<void> {
  assertPermission(auth, "organise");
  const groups = await groupByFolder(auth, ids);
  if (groups.size === 0) return;
  await withImap(auth.mailboxId, async (client) => {
    for (const g of groups.values()) {
      const lock = await client.getMailboxLock(g.path);
      try {
        const range = g.uids.join(",");
        if (change.seen !== undefined) {
          await (change.seen ? client.messageFlagsAdd : client.messageFlagsRemove).call(client, range, ["\\Seen"], { uid: true });
        }
        if (change.flagged !== undefined) {
          await (change.flagged ? client.messageFlagsAdd : client.messageFlagsRemove).call(client, range, ["\\Flagged"], { uid: true });
        }
      } finally {
        lock.release();
      }
    }
  });
  const data = {
    ...(change.seen !== undefined ? { isSeen: change.seen } : {}),
    ...(change.flagged !== undefined ? { isFlagged: change.flagged } : {}),
  };
  await db().messageMeta.updateMany({ where: { id: { in: [...groups.values()].flatMap((g) => g.ids) } }, data });
}

export async function moveMessages(auth: AuthorizedMailbox, ids: string[], targetFolderId: string): Promise<number> {
  assertPermission(auth, "organise");
  const p = db();
  const target = await p.mailFolder.findFirst({
    where: { id: targetFolderId, mailboxId: auth.mailboxId, selectable: true },
    select: { path: true, specialUse: true },
  });
  if (!target) throw new Error("Unknown destination folder.");
  const groups = await groupByFolder(auth, ids);
  let moved = 0;
  await withImap(auth.mailboxId, async (client) => {
    for (const [folderId, g] of groups) {
      if (folderId === targetFolderId) continue;
      const lock = await client.getMailboxLock(g.path);
      try {
        // UID MOVE (or COPY + flag + UID EXPUNGE of exactly these UIDs) via ImapFlow.
        await client.messageMove(g.uids.join(","), target.path, { uid: true });
        await p.messageMeta.deleteMany({ where: { id: { in: g.ids } } });
        moved += g.ids.length;
      } finally {
        lock.release();
      }
    }
  });
  await audit({
    organizationId: (await p.mailbox.findUniqueOrThrow({ where: { id: auth.mailboxId }, select: { organizationId: true } })).organizationId,
    action: target.specialUse === "TRASH" ? "mail.trashed" : "mail.moved",
    actorUserId: auth.userId,
    mailboxId: auth.mailboxId,
    metadata: { count: moved, to: target.specialUse },
  });
  return moved;
}

/** Move to Trash. Messages already in Trash are left alone (permanent deletion needs explicit confirmation — Phase 4). */
export async function trashMessages(auth: AuthorizedMailbox, ids: string[]): Promise<number> {
  const trash = await db().mailFolder.findFirst({
    where: { mailboxId: auth.mailboxId, specialUse: "TRASH" },
    select: { id: true },
  });
  if (!trash) throw new Error("This mailbox has no Trash folder.");
  return moveMessages(auth, ids, trash.id);
}
