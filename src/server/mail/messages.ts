import "server-only";
import { randomBytes } from "node:crypto";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import type { FolderSpecialUse, Prisma } from "@/generated/prisma/client";
import {
  ATTACHMENT_CHUNK_BYTES,
  ATTACHMENT_DIRECT_MAX,
  type Addr,
  type AttachmentDTO,
  type ComposeContextDTO,
  type ContactDTO,
  type FolderDTO,
  type MessageBodyDTO,
  type ThreadDTO,
  type ThreadPageDTO,
  type ThreadSummaryDTO,
} from "@/lib/mail-types";
import { audit, type AuditAction } from "../audit";
import type { AuthorizedMailbox } from "../auth/dal";
import { roleAllows, type MailboxPermission } from "../auth/dal";
import { db } from "../db";
import { withImap } from "./client";
import { sanitizeOutgoingHtml } from "./compose-html";
import { imageProxyUrl } from "./image-proxy";
import { emailDocument, escapeHtml, hasBlockedRemoteImages, previewFromHtml, sanitizeEmailHtml } from "./sanitize";
import { attachmentParts, bodyLeaves, partHeaders, syntheticMessage, type AttachmentPart } from "./structure";
import {
  conversationKey,
  decodeCursor,
  dedupeCopies,
  encodeCursor,
  groupByConversation,
  participantsOf,
  toAddrList,
} from "./threads";

/**
 * Reading and organising messages. Every function takes an AuthorizedMailbox
 * (from requireMailboxAccess / checkMailboxAccess) and scopes every query to
 * that mailbox, so a message id from another mailbox simply isn't found.
 */

const MAX_PARSE_BYTES = 30 * 1024 * 1024;
/** Above this size only the body parts are fetched (not the attachments). */
const FULL_FETCH_MAX = 1536 * 1024;
const ROLE_ORDER: FolderSpecialUse[] = ["INBOX", "DRAFTS", "SENT", "ARCHIVE", "JUNK", "TRASH", "FLAGGED", "ALL", "NONE"];
/** Conversations don't pull in copies from these folders unless you are looking at them. */
const HIDDEN_ROLES: ReadonlySet<FolderSpecialUse> = new Set(["TRASH", "JUNK"]);

export class MessageNotFoundError extends Error {
  constructor() {
    super("That message no longer exists on the server.");
    this.name = "MessageNotFoundError";
  }
}

/** An action that can't be done, with a message meant for the user. */
export class MailActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailActionError";
  }
}

export class AttachmentTooLargeError extends Error {
  constructor() {
    super("This attachment is too large to download in one piece.");
    this.name = "AttachmentTooLargeError";
  }
}

function assertPermission(auth: AuthorizedMailbox, permission: MailboxPermission) {
  if (!roleAllows(auth.role, permission)) throw new Error(`Not permitted: ${permission}`);
}

// ── Mailbox & folders ───────────────────────────────────────────────────────

export async function mailboxOverview(auth: AuthorizedMailbox) {
  return db().mailbox.findUniqueOrThrow({
    where: { id: auth.mailboxId },
    select: { id: true, address: true, displayName: true, status: true, statusReason: true, lastSyncAt: true },
  });
}

export async function listFolders(auth: AuthorizedMailbox): Promise<FolderDTO[]> {
  const rows = await db().mailFolder.findMany({
    where: { mailboxId: auth.mailboxId, selectable: true },
    select: {
      id: true,
      name: true,
      path: true,
      delimiter: true,
      specialUse: true,
      totalCount: true,
      unreadCount: true,
      lastSyncedAt: true,
    },
  });
  rows.sort((a, b) => ROLE_ORDER.indexOf(a.specialUse) - ROLE_ORDER.indexOf(b.specialUse) || a.path.localeCompare(b.path));
  return rows.map((f) => {
    // MilesWeb (Dovecot) keeps every folder under "INBOX."; those count as top level.
    const segments = f.delimiter ? f.path.split(f.delimiter) : [f.path];
    const underInbox = segments.length > 1 && segments[0].toUpperCase() === "INBOX";
    return {
      id: f.id,
      name: f.specialUse === "INBOX" ? "Inbox" : f.name,
      path: f.path,
      role: f.specialUse,
      depth: f.specialUse === "NONE" ? Math.max(0, segments.length - 1 - (underInbox ? 1 : 0)) : 0,
      total: f.totalCount,
      unread: f.unreadCount,
      lastSyncedAt: f.lastSyncedAt?.toISOString() ?? null,
    };
  });
}

// ── Conversation list ───────────────────────────────────────────────────────

const ROW_SELECT = {
  id: true,
  folderId: true,
  threadKey: true,
  subject: true,
  fromName: true,
  fromAddress: true,
  toAddrs: true,
  internalDate: true,
  isSeen: true,
  isFlagged: true,
  isAnswered: true,
  isDraft: true,
  hasAttachments: true,
  preview: true,
} satisfies Prisma.MessageMetaSelect;

export async function listThreads(
  auth: AuthorizedMailbox,
  opts: { folderId?: string; q?: string; cursor?: string | null; take?: number; allFolders?: boolean; conversations?: boolean },
): Promise<ThreadPageDTO> {
  const p = db();
  const take = Math.min(Math.max(opts.take ?? 40, 1), 100);
  const [mailbox, folders] = await Promise.all([
    p.mailbox.findUniqueOrThrow({ where: { id: auth.mailboxId }, select: { address: true } }),
    p.mailFolder.findMany({ where: { mailboxId: auth.mailboxId }, select: { id: true, specialUse: true, totalCount: true } }),
  ]);
  const folder = folders.find((f) => f.id === opts.folderId);
  const q = opts.q?.trim().slice(0, 100) ?? "";
  const searching = q.length >= 2;
  const everywhere = searching && (opts.allFolders || !folder);
  if (!folder && !everywhere) return { threads: [], nextCursor: null, olderOnServer: false };

  const hidden = folders.filter((f) => HIDDEN_ROLES.has(f.specialUse) && f.id !== folder?.id).map((f) => f.id);
  const cursor = decodeCursor(opts.cursor);
  const and: Prisma.MessageMetaWhereInput[] = [];
  // Case-insensitive match (utf8mb4_unicode_ci) on subject, sender and preview.
  if (searching) {
    and.push({
      OR: [
        { subject: { contains: q } },
        { fromName: { contains: q } },
        { fromAddress: { contains: q } },
        { preview: { contains: q } },
      ],
    });
  }
  if (cursor) {
    and.push({ OR: [{ internalDate: { lt: cursor.date } }, { internalDate: cursor.date, id: { lt: cursor.id } }] });
  }
  const where: Prisma.MessageMetaWhereInput = {
    mailboxId: auth.mailboxId,
    ...(everywhere ? { folderId: { notIn: hidden } } : { folderId: folder!.id }),
    ...(and.length ? { AND: and } : {}),
  };

  const windowSize = Math.min(take * 6, 400);
  const rows = await p.messageMeta.findMany({
    where,
    orderBy: [{ internalDate: "desc" }, { id: "desc" }],
    take: windowSize,
    select: ROW_SELECT,
  });
  const conversations = opts.conversations !== false;
  const { groups, truncated } = groupByConversation(conversations ? rows : rows.map((r) => ({ ...r, threadKey: null })), take);

  // Whole-conversation facts (count, participants) come from every folder but Trash/Junk.
  const keys = conversations ? [...new Set(groups.map((g) => g[0].threadKey).filter((k): k is string => Boolean(k)))] : [];
  const members = keys.length
    ? await p.messageMeta.findMany({
        where: { mailboxId: auth.mailboxId, threadKey: { in: keys }, folderId: { notIn: hidden } },
        orderBy: [{ internalDate: "asc" }, { id: "asc" }],
        take: 5000,
        select: { id: true, folderId: true, threadKey: true, messageIdHeader: true, fromName: true, fromAddress: true, hasAttachments: true },
      })
    : [];
  const byKey = new Map<string, typeof members>();
  for (const m of members) {
    const list = byKey.get(m.threadKey!) ?? [];
    list.push(m);
    byKey.set(m.threadKey!, list);
  }

  const outgoing = folder?.specialUse === "SENT" || folder?.specialUse === "DRAFTS";
  const threads: ThreadSummaryDTO[] = groups.map((g) => {
    const latest = g[0];
    const all = latest.threadKey ? dedupeCopies(byKey.get(latest.threadKey) ?? [], folder?.id) : [];
    const recipients = toAddrList(latest.toAddrs);
    return {
      key: conversationKey(latest),
      latestId: latest.id,
      ids: g.map((r) => r.id),
      folderId: latest.folderId,
      subject: latest.subject,
      from: outgoing && recipients[0] ? recipients[0] : { name: latest.fromName, address: latest.fromAddress },
      participants: outgoing
        ? participantsOf(recipients.map((r) => ({ fromName: r.name, fromAddress: r.address })), mailbox.address)
        : participantsOf(all.length ? all : [...g].reverse(), mailbox.address),
      preview: latest.preview,
      date: latest.internalDate.toISOString(),
      count: Math.max(all.length, g.length),
      unread: g.some((r) => !r.isSeen),
      flagged: g.some((r) => r.isFlagged),
      answered: latest.isAnswered,
      draft: latest.isDraft,
      hasAttachments: g.some((r) => r.hasAttachments) || all.some((m) => m.hasAttachments),
    };
  });

  let nextCursor: string | null = null;
  if (truncated) {
    const last = groups[groups.length - 1][0];
    nextCursor = encodeCursor(last.internalDate, last.id);
  } else if (rows.length === windowSize) {
    const last = rows[rows.length - 1];
    nextCursor = encodeCursor(last.internalDate, last.id);
  }
  let olderOnServer = false;
  if (!nextCursor && folder && !searching) {
    const cached = await p.messageMeta.count({ where: { folderId: folder.id } });
    olderOnServer = folder.totalCount > cached;
  }
  return { threads, nextCursor, olderOnServer };
}

// ── One conversation ────────────────────────────────────────────────────────

export async function getThread(auth: AuthorizedMailbox, messageId: string): Promise<ThreadDTO> {
  const p = db();
  const anchor = await p.messageMeta.findFirst({
    where: { id: messageId, mailboxId: auth.mailboxId },
    select: { threadKey: true, folderId: true, folder: { select: { specialUse: true } } },
  });
  if (!anchor) throw new MessageNotFoundError();
  const showHidden = HIDDEN_ROLES.has(anchor.folder.specialUse);
  const rows = await p.messageMeta.findMany({
    where: anchor.threadKey ? { mailboxId: auth.mailboxId, threadKey: anchor.threadKey } : { id: messageId },
    orderBy: [{ internalDate: "desc" }, { id: "desc" }],
    take: 100,
    select: {
      id: true,
      folderId: true,
      messageIdHeader: true,
      subject: true,
      fromName: true,
      fromAddress: true,
      toAddrs: true,
      ccAddrs: true,
      internalDate: true,
      preview: true,
      isSeen: true,
      isFlagged: true,
      isAnswered: true,
      isDraft: true,
      hasAttachments: true,
      folder: { select: { specialUse: true, name: true } },
    },
  });
  rows.reverse();
  const visible = rows.filter((r) => r.id === messageId || showHidden || !HIDDEN_ROLES.has(r.folder.specialUse));
  const messages = dedupeCopies(visible, anchor.folderId);
  if (!messages.some((m) => m.id === messageId)) {
    const self = visible.find((r) => r.id === messageId);
    if (self) messages.push(self);
  }
  return {
    key: anchor.threadKey ?? `m:${messageId}`,
    subject: messages.find((m) => m.subject)?.subject ?? null,
    messages: messages.map((m) => ({
      id: m.id,
      folderId: m.folderId,
      folderRole: m.folder.specialUse,
      folderName: m.folder.specialUse === "INBOX" ? "Inbox" : m.folder.name,
      subject: m.subject,
      from: { name: m.fromName, address: m.fromAddress },
      to: toAddrList(m.toAddrs),
      cc: toAddrList(m.ccAddrs),
      date: m.internalDate.toISOString(),
      preview: m.preview,
      isSeen: m.isSeen,
      isFlagged: m.isFlagged,
      isAnswered: m.isAnswered,
      isDraft: m.isDraft,
      hasAttachments: m.hasAttachments,
    })),
  };
}

// ── Opening a message (IMAP fetch + parse + sanitise) ───────────────────────

type MessageLocation = { id: string; uid: bigint; uidValidity: bigint; sizeBytes: number; path: string };

async function locate(auth: AuthorizedMailbox, messageId: string) {
  const meta = await db().messageMeta.findFirst({
    where: { id: messageId, mailboxId: auth.mailboxId },
    select: {
      id: true,
      uid: true,
      uidValidity: true,
      sizeBytes: true,
      preview: true,
      folder: { select: { path: true } },
    },
  });
  if (!meta) throw new MessageNotFoundError();
  return { ...meta, path: meta.folder.path };
}

/** The message's MIME source: everything when small, otherwise headers + body parts only. */
async function fetchSource(auth: AuthorizedMailbox, loc: MessageLocation, opts: { full?: boolean } = {}) {
  return withImap(auth.mailboxId, async (client) => {
    const lock = await client.getMailboxLock(loc.path, { readOnly: true });
    try {
      if (!client.mailbox || BigInt(client.mailbox.uidValidity) !== loc.uidValidity) return null;
      const uid = String(loc.uid);
      // BODY.PEEK[] — reading never sets \Seen implicitly.
      if (opts.full || loc.sizeBytes <= FULL_FETCH_MAX) {
        const msg = await client.fetchOne(uid, { source: true, bodyStructure: true }, { uid: true });
        return msg && msg.source ? { source: msg.source, structure: msg.bodyStructure ?? null } : null;
      }
      const head = await client.fetchOne(uid, { headers: true, bodyStructure: true }, { uid: true });
      if (!head || !head.headers) return null;
      const structure = head.bodyStructure ?? null;
      const leaves = bodyLeaves(structure);
      const main = leaves.html ?? leaves.text;
      if (!structure?.childNodes?.length || !main?.part) {
        // A single huge part: nothing to skip, fetch it all.
        if (loc.sizeBytes > MAX_PARSE_BYTES) throw new MailActionError("This message is too large to display here (over 30 MB).");
        const msg = await client.fetchOne(uid, { source: true }, { uid: true });
        return msg && msg.source ? { source: msg.source, structure } : null;
      }
      const wanted = [main, ...(leaves.html ? leaves.inline : [])].filter((n) => n.part);
      const res = await client.fetchOne(uid, { bodyParts: wanted.map((n) => n.part!) }, { uid: true });
      const parts = wanted
        .map((n) => ({ mime: partHeaders(n), body: res ? res.bodyParts?.get(n.part!.toLowerCase()) : undefined }))
        .filter((x): x is { mime: string; body: Buffer } => Boolean(x.body));
      if (parts.length === 0) return null;
      const boundary = `mm-${randomBytes(12).toString("hex")}`;
      return { source: syntheticMessage(head.headers, parts, boundary), structure };
    } finally {
      lock.release();
    }
  });
}

const flatAddrs = (v: AddressObject | AddressObject[] | undefined) => (Array.isArray(v) ? v.flatMap((x) => x.value) : (v?.value ?? []));
const addrs = (v: AddressObject | AddressObject[] | undefined): Addr[] =>
  flatAddrs(v)
    .filter((a) => a.address || a.name)
    .map((a) => ({ name: a.name || null, address: a.address?.toLowerCase() || null }));

function unsubscribeOf(parsed: ParsedMail): MessageBodyDTO["unsubscribe"] {
  const list = parsed.headers.get("list") as { unsubscribe?: { url?: string; mail?: string; id?: string; name?: string } } | undefined;
  const u = list?.unsubscribe;
  if (!u) return null;
  // mailparser files "<https://…>" under `id` (no "@"), a bare URL under `url` or `name`.
  const url = [u.url, u.id, u.name].find((v): v is string => typeof v === "string" && /^https:\/\/[^\s"'<>]+$/i.test(v)) ?? null;
  const mailto = u.mail && /^[^\s@<>"]+@[^\s@<>"]+$/.test(u.mail.split("?")[0]) ? u.mail : null;
  return url || mailto ? { url, mailto } : null;
}

export function attachmentDTO(a: AttachmentPart): AttachmentDTO {
  const chunked = a.size > ATTACHMENT_DIRECT_MAX;
  return {
    part: a.part,
    filename: a.filename,
    contentType: a.contentType,
    encoding: a.encoding,
    size: a.size,
    chunked,
    chunks: chunked ? Math.max(1, Math.ceil(a.encodedSize / ATTACHMENT_CHUNK_BYTES)) : 1,
  };
}

export async function openMessage(
  auth: AuthorizedMailbox,
  messageId: string,
  opts: { images: "proxy" | "block" },
): Promise<MessageBodyDTO> {
  assertPermission(auth, "read");
  const p = db();
  const meta = await locate(auth, messageId);

  // Re-opening (or re-rendering after an action) shouldn't hit the mail server
  // again: parsed + sanitised bodies are cached briefly per server instance.
  const cacheKey = `${meta.id}:${meta.uidValidity}:${opts.images}`;
  const cached = bodyCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.message;

  const fetched = await fetchSource(auth, meta);
  if (!fetched) {
    await p.messageMeta.delete({ where: { id: meta.id } }).catch(() => {});
    throw new MessageNotFoundError();
  }

  // mailparser inlines cid: images as data: URLs; the sanitiser keeps only raster ones.
  const parsed = await simpleParser(fetched.source, { skipHtmlToText: true });
  const rawHtml = parsed.html || parsed.textAsHtml || `<pre>${escapeHtml(parsed.text ?? "")}</pre>`;
  const clean = sanitizeEmailHtml(rawHtml);
  const remote = hasBlockedRemoteImages(clean);

  // Preview from the visible text (mailparser's text version can include <style> contents).
  const preview = parsed.html ? previewFromHtml(parsed.html) : (parsed.text ?? "").replace(/\s+/g, " ").trim().slice(0, 280);
  if (preview && meta.preview !== preview) {
    await p.messageMeta.update({ where: { id: meta.id }, data: { preview } }).catch(() => {});
  }

  const opened: MessageBodyDTO = {
    id: meta.id,
    subject: parsed.subject ?? "(no subject)",
    from: addrs(parsed.from)[0] ?? null,
    to: addrs(parsed.to),
    cc: addrs(parsed.cc),
    replyTo: addrs(parsed.replyTo),
    date: parsed.date ? parsed.date.toISOString() : null,
    document: emailDocument(clean, opts.images === "proxy" ? { proxyImages: imageProxyUrl } : {}),
    remoteImages: !remote ? "none" : opts.images === "proxy" ? "loaded" : "blocked",
    attachments: attachmentParts(fetched.structure).map(attachmentDTO),
    unsubscribe: unsubscribeOf(parsed),
  };
  bodyCache.delete(cacheKey);
  bodyCache.set(cacheKey, { message: opened, expires: Date.now() + BODY_TTL_MS });
  while (bodyCache.size > BODY_MAX) bodyCache.delete(bodyCache.keys().next().value!);
  return opened;
}

// Small in-memory LRU of opened messages (per server instance).
const BODY_TTL_MS = 10 * 60_000;
const BODY_MAX = 100;
type BodyEntry = { message: MessageBodyDTO; expires: number };
const gb = globalThis as unknown as { __matiumBodiesV6?: Map<string, BodyEntry> };
const bodyCache = (gb.__matiumBodiesV6 ??= new Map());

/** The parsed original, for quoting and forwarding (cid: links kept so inline images can travel along). */
export async function parseSourceForCompose(auth: AuthorizedMailbox, messageId: string) {
  const meta = await locate(auth, messageId);
  if (meta.sizeBytes > MAX_PARSE_BYTES) throw new MailActionError("The original message is too large to quote or forward.");
  const fetched = await fetchSource(auth, meta, { full: true });
  if (!fetched) throw new MessageNotFoundError();
  return { parsed: await simpleParser(fetched.source, { keepCidLinks: true }), structure: fetched.structure };
}

// ── Attachments ─────────────────────────────────────────────────────────────

type ImapClient = Parameters<Parameters<typeof withImap>[1]>[0];

async function withAttachment<T>(
  auth: AuthorizedMailbox,
  messageId: string,
  part: string,
  fn: (ctx: { client: ImapClient; uid: string; attachment: AttachmentPart }) => Promise<T>,
): Promise<T> {
  assertPermission(auth, "read");
  const loc = await locate(auth, messageId);
  const result = await withImap(auth.mailboxId, async (client) => {
    const lock = await client.getMailboxLock(loc.path, { readOnly: true });
    try {
      if (!client.mailbox || BigInt(client.mailbox.uidValidity) !== loc.uidValidity) return null;
      const uid = String(loc.uid);
      const msg = await client.fetchOne(uid, { bodyStructure: true }, { uid: true });
      const attachment = msg ? attachmentParts(msg.bodyStructure).find((a) => a.part === part) : undefined;
      if (!attachment) return null;
      return { value: await fn({ client, uid, attachment }) };
    } finally {
      lock.release();
    }
  });
  if (!result) throw new MessageNotFoundError();
  return result.value;
}

/** A whole attachment, decoded. Only for attachments up to ATTACHMENT_DIRECT_MAX. */
export async function downloadAttachment(auth: AuthorizedMailbox, messageId: string, part: string) {
  return withAttachment(auth, messageId, part, async ({ client, uid, attachment }) => {
    if (attachment.size > ATTACHMENT_DIRECT_MAX * 1.05) throw new AttachmentTooLargeError();
    const dl = await client.download(uid, part, {
      uid: true,
      decodeText: false,
      chunkSize: 2 * 1024 * 1024,
      maxBytes: Math.ceil(ATTACHMENT_DIRECT_MAX * 1.2),
    });
    if (!("content" in dl) || !dl.content) throw new MessageNotFoundError();
    const chunks: Buffer[] = [];
    for await (const chunk of dl.content) chunks.push(chunk as Buffer);
    return { attachment, content: Buffer.concat(chunks) };
  });
}

/** One raw (still transfer-encoded) piece of a large attachment; the browser decodes. */
export async function downloadAttachmentChunk(auth: AuthorizedMailbox, messageId: string, part: string, index: number) {
  return withAttachment(auth, messageId, part, async ({ client, uid, attachment }) => {
    const total = Math.max(1, Math.ceil(attachment.encodedSize / ATTACHMENT_CHUNK_BYTES));
    if (index < 0 || index >= total) throw new MessageNotFoundError();
    const res = await client.fetchOne(
      uid,
      { bodyParts: [{ key: part, start: index * ATTACHMENT_CHUNK_BYTES, maxLength: ATTACHMENT_CHUNK_BYTES }] },
      { uid: true },
    );
    const content = res ? (res.bodyParts?.get(part.toLowerCase()) ?? [...(res.bodyParts?.values() ?? [])][0]) : undefined;
    return { attachment, content: content ?? Buffer.alloc(0), total };
  });
}

/** Full contents of some of a message's attachments (for forwarding), in one IMAP session. */
export async function fetchAttachmentContents(
  auth: AuthorizedMailbox,
  messageId: string,
  parts: string[],
  maxTotalBytes: number,
): Promise<Array<{ filename: string; contentType: string; content: Buffer }>> {
  assertPermission(auth, "read");
  if (parts.length === 0) return [];
  const loc = await locate(auth, messageId);
  const out = await withImap(auth.mailboxId, async (client) => {
    const lock = await client.getMailboxLock(loc.path, { readOnly: true });
    try {
      if (!client.mailbox || BigInt(client.mailbox.uidValidity) !== loc.uidValidity) return null;
      const uid = String(loc.uid);
      const msg = await client.fetchOne(uid, { bodyStructure: true }, { uid: true });
      const available = msg ? attachmentParts(msg.bodyStructure) : [];
      const files: Array<{ filename: string; contentType: string; content: Buffer }> = [];
      let total = 0;
      for (const part of parts) {
        const a = available.find((x) => x.part === part);
        if (!a) continue;
        const dl = await client.download(uid, part, { uid: true, decodeText: false, chunkSize: 2 * 1024 * 1024, maxBytes: maxTotalBytes + 1 });
        if (!("content" in dl) || !dl.content) continue;
        const chunks: Buffer[] = [];
        for await (const chunk of dl.content) chunks.push(chunk as Buffer);
        const content = Buffer.concat(chunks);
        total += content.length;
        if (total > maxTotalBytes) throw new AttachmentTooLargeError();
        files.push({ filename: a.filename, contentType: a.contentType, content });
      }
      return files;
    } finally {
      lock.release();
    }
  });
  if (!out) throw new MessageNotFoundError();
  return out;
}

// ── Organising (IMAP first, then mirror into the cache) ─────────────────────

type Grouped = Map<string, { path: string; role: FolderSpecialUse; ids: string[]; uids: number[]; unseen: number }>;

async function groupByFolder(auth: AuthorizedMailbox, ids: string[]): Promise<Grouped> {
  const rows = await db().messageMeta.findMany({
    where: { id: { in: ids.slice(0, 500) }, mailboxId: auth.mailboxId },
    select: { id: true, uid: true, isSeen: true, folder: { select: { id: true, path: true, specialUse: true } } },
  });
  const groups: Grouped = new Map();
  for (const r of rows) {
    const g = groups.get(r.folder.id) ?? { path: r.folder.path, role: r.folder.specialUse, ids: [], uids: [], unseen: 0 };
    g.ids.push(r.id);
    g.uids.push(Number(r.uid));
    if (!r.isSeen) g.unseen++;
    groups.set(r.folder.id, g);
  }
  return groups;
}

/** Keep a folder's unread badge and total right until the next sync reads them from the server. */
async function adjustCounts(folderId: string, unreadDelta: number, totalDelta = 0): Promise<void> {
  if (unreadDelta === 0 && totalDelta === 0) return;
  await db().$executeRaw`UPDATE mail_folders
    SET unread_count = GREATEST(0, unread_count + ${unreadDelta}), total_count = GREATEST(0, total_count + ${totalDelta})
    WHERE id = ${folderId}`;
}

async function organizationOf(auth: AuthorizedMailbox): Promise<string> {
  const mb = await db().mailbox.findUniqueOrThrow({ where: { id: auth.mailboxId }, select: { organizationId: true } });
  return mb.organizationId;
}

export async function setFlags(
  auth: AuthorizedMailbox,
  ids: string[],
  change: { seen?: boolean; flagged?: boolean; answered?: boolean },
): Promise<void> {
  assertPermission(auth, "organise");
  const groups = await groupByFolder(auth, ids);
  if (groups.size === 0) return;
  const p = db();
  // How many become read/unread, per folder, for the unread badges.
  const seenBefore = new Map<string, number>();
  if (change.seen === false) {
    for (const [folderId, g] of groups) {
      seenBefore.set(folderId, await p.messageMeta.count({ where: { id: { in: g.ids }, isSeen: true } }));
    }
  }
  await withImap(auth.mailboxId, async (client) => {
    for (const g of groups.values()) {
      const lock = await client.getMailboxLock(g.path);
      try {
        const range = g.uids.join(",");
        const apply = async (on: boolean | undefined, flag: string) => {
          if (on === undefined) return;
          await (on ? client.messageFlagsAdd : client.messageFlagsRemove).call(client, range, [flag], { uid: true });
        };
        await apply(change.seen, "\\Seen");
        await apply(change.flagged, "\\Flagged");
        await apply(change.answered, "\\Answered");
      } finally {
        lock.release();
      }
    }
  });
  if (change.seen !== undefined) {
    for (const [folderId, g] of groups) {
      await adjustCounts(folderId, change.seen ? -g.unseen : (seenBefore.get(folderId) ?? 0));
    }
  }
  const data = {
    ...(change.seen !== undefined ? { isSeen: change.seen } : {}),
    ...(change.flagged !== undefined ? { isFlagged: change.flagged } : {}),
    ...(change.answered !== undefined ? { isAnswered: change.answered } : {}),
  };
  await p.messageMeta.updateMany({ where: { id: { in: [...groups.values()].flatMap((g) => g.ids) } }, data });
}

export async function moveMessages(
  auth: AuthorizedMailbox,
  ids: string[],
  targetFolderId: string,
  action: AuditAction = "mail.moved",
): Promise<number> {
  assertPermission(auth, "organise");
  const p = db();
  const target = await p.mailFolder.findFirst({
    where: { id: targetFolderId, mailboxId: auth.mailboxId, selectable: true },
    select: { path: true, specialUse: true },
  });
  if (!target) throw new MailActionError("Unknown destination folder.");
  const groups = await groupByFolder(auth, ids);
  let moved = 0;
  let movedUnseen = 0;
  await withImap(auth.mailboxId, async (client) => {
    for (const [folderId, g] of groups) {
      if (folderId === targetFolderId) continue;
      const lock = await client.getMailboxLock(g.path);
      try {
        // UID MOVE (or COPY + flag + UID EXPUNGE of exactly these UIDs) via ImapFlow.
        await client.messageMove(g.uids.join(","), target.path, { uid: true });
        await p.messageMeta.deleteMany({ where: { id: { in: g.ids } } });
        await adjustCounts(folderId, -g.unseen, -g.ids.length);
        moved += g.ids.length;
        movedUnseen += g.unseen;
      } finally {
        lock.release();
      }
    }
  });
  await adjustCounts(targetFolderId, movedUnseen, moved);
  await audit({
    organizationId: await organizationOf(auth),
    action: target.specialUse === "TRASH" ? "mail.trashed" : action,
    actorUserId: auth.userId,
    mailboxId: auth.mailboxId,
    metadata: { count: moved, to: target.specialUse },
  });
  return moved;
}

async function folderWithRole(auth: AuthorizedMailbox, role: FolderSpecialUse) {
  return db().mailFolder.findFirst({ where: { mailboxId: auth.mailboxId, specialUse: role, selectable: true }, select: { id: true } });
}

/** Move to Trash. Messages already in Trash are left alone (use deleteMessages for those). */
export async function trashMessages(auth: AuthorizedMailbox, ids: string[]): Promise<number> {
  const trash = await folderWithRole(auth, "TRASH");
  if (!trash) throw new MailActionError("This mailbox has no Trash folder.");
  return moveMessages(auth, ids, trash.id);
}

export async function spamMessages(auth: AuthorizedMailbox, ids: string[], spam: boolean): Promise<number> {
  const target = await folderWithRole(auth, spam ? "JUNK" : "INBOX");
  if (!target) throw new MailActionError(spam ? "This mailbox has no Junk folder." : "This mailbox has no Inbox.");
  return moveMessages(auth, ids, target.id);
}

/** The Archive folder, created on the server the first time it's needed. */
async function ensureArchiveFolder(auth: AuthorizedMailbox): Promise<string> {
  const existing = await folderWithRole(auth, "ARCHIVE");
  if (existing) return existing.id;
  const p = db();
  const inbox = await p.mailFolder.findFirst({
    where: { mailboxId: auth.mailboxId, specialUse: "INBOX" },
    select: { delimiter: true },
  });
  const delimiter = inbox?.delimiter ?? ".";
  // Dovecot setups like MilesWeb keep every folder below "INBOX."; follow the existing layout.
  const nested = await p.mailFolder.count({ where: { mailboxId: auth.mailboxId, path: { startsWith: `INBOX${delimiter}` } } });
  const path = nested > 0 ? `INBOX${delimiter}Archive` : "Archive";
  await withImap(auth.mailboxId, async (client) => {
    try {
      await client.mailboxCreate(path);
    } catch (err) {
      const text = String((err as { responseText?: string }).responseText ?? (err as Error).message);
      if (!/ALREADYEXISTS|already exists/i.test(text)) throw err;
    }
    await client.mailboxSubscribe(path).catch(() => {});
  });
  const row = await p.mailFolder.upsert({
    where: { mailboxId_path: { mailboxId: auth.mailboxId, path } },
    create: { mailboxId: auth.mailboxId, path, delimiter, name: "Archive", specialUse: "ARCHIVE" },
    update: { specialUse: "ARCHIVE", selectable: true },
    select: { id: true },
  });
  return row.id;
}

export async function archiveMessages(auth: AuthorizedMailbox, ids: string[]): Promise<number> {
  assertPermission(auth, "organise");
  return moveMessages(auth, ids, await ensureArchiveFolder(auth), "mail.archived");
}

/**
 * Permanent deletion, only for messages already in Trash or Junk (anything
 * else goes to Trash first, so nothing disappears in one click).
 */
export async function deleteMessages(auth: AuthorizedMailbox, ids: string[]): Promise<number> {
  assertPermission(auth, "organise");
  const groups = await groupByFolder(auth, ids);
  const p = db();
  let deleted = 0;
  const elsewhere: string[] = [];
  await withImap(auth.mailboxId, async (client) => {
    for (const [folderId, g] of groups) {
      if (!HIDDEN_ROLES.has(g.role)) {
        elsewhere.push(...g.ids);
        continue;
      }
      const lock = await client.getMailboxLock(g.path);
      try {
        await client.messageDelete(g.uids.join(","), { uid: true });
        await p.messageMeta.deleteMany({ where: { id: { in: g.ids } } });
        await adjustCounts(folderId, -g.unseen, -g.ids.length);
        deleted += g.ids.length;
      } finally {
        lock.release();
      }
    }
  });
  if (elsewhere.length) return deleted + (await trashMessages(auth, elsewhere));
  await audit({
    organizationId: await organizationOf(auth),
    action: "mail.deleted",
    actorUserId: auth.userId,
    mailboxId: auth.mailboxId,
    metadata: { count: deleted },
  });
  return deleted;
}

/** Empty Trash or Junk. */
export async function emptyFolder(auth: AuthorizedMailbox, folderId: string): Promise<void> {
  assertPermission(auth, "organise");
  const p = db();
  const folder = await p.mailFolder.findFirst({
    where: { id: folderId, mailboxId: auth.mailboxId },
    select: { path: true, specialUse: true },
  });
  if (!folder || !HIDDEN_ROLES.has(folder.specialUse)) throw new MailActionError("Only Trash and Junk can be emptied.");
  await withImap(auth.mailboxId, async (client) => {
    const lock = await client.getMailboxLock(folder.path);
    try {
      if (client.mailbox && client.mailbox.exists > 0) await client.messageDelete("1:*");
    } finally {
      lock.release();
    }
  });
  await p.messageMeta.deleteMany({ where: { folderId } });
  await p.mailFolder.update({ where: { id: folderId }, data: { unreadCount: 0, totalCount: 0 } });
  await audit({
    organizationId: await organizationOf(auth),
    action: "mail.deleted",
    actorUserId: auth.userId,
    mailboxId: auth.mailboxId,
    metadata: { emptied: folder.specialUse },
  });
}

// ── Composing ───────────────────────────────────────────────────────────────

const RE = /^\s*(re|aw|sv|antw)\s*:/i;
const FWD = /^\s*(fwd?|wg|tr)\s*:/i;

export function replySubject(subject: string | null): string {
  const s = subject?.trim() ?? "";
  return RE.test(s) ? s : `Re: ${s}`;
}

export function forwardSubject(subject: string | null): string {
  const s = subject?.trim() ?? "";
  return FWD.test(s) ? s : `Fwd: ${s}`;
}

export const formatAddr = (a: Addr) => (a.name && a.address ? `${a.name} <${a.address}>` : (a.address ?? ""));

export const quoteDateFormat = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Kolkata",
});

export async function composeContext(
  auth: AuthorizedMailbox,
  messageId: string,
  mode: "reply" | "replyAll" | "forward" | "draft",
): Promise<ComposeContextDTO> {
  const p = db();
  const [mailbox, meta] = await Promise.all([
    p.mailbox.findUniqueOrThrow({ where: { id: auth.mailboxId }, select: { address: true } }),
    p.messageMeta.findFirst({
      where: { id: messageId, mailboxId: auth.mailboxId },
      select: {
        subject: true,
        fromName: true,
        fromAddress: true,
        toAddrs: true,
        ccAddrs: true,
        bccAddrs: true,
        replyTo: true,
        internalDate: true,
        sentAt: true,
      },
    }),
  ]);
  if (!meta) throw new MessageNotFoundError();
  const me = mailbox.address.toLowerCase();
  const from: Addr = { name: meta.fromName, address: meta.fromAddress };
  const to = toAddrList(meta.toAddrs);
  const cc = toAddrList(meta.ccAddrs);
  const replyTo = toAddrList(meta.replyTo);
  const isMine = from.address?.toLowerCase() === me;
  const uniq = (list: Addr[], exclude: Set<string>) => {
    const out: string[] = [];
    for (const a of list) {
      const key = a.address?.toLowerCase();
      if (!key || exclude.has(key)) continue;
      exclude.add(key);
      out.push(formatAddr(a));
    }
    return out;
  };
  const dateText = quoteDateFormat.format(meta.sentAt ?? meta.internalDate);

  if (mode === "draft") {
    const [opened, { parsed }] = await Promise.all([
      openMessage(auth, messageId, { images: "block" }),
      parseSourceForCompose(auth, messageId),
    ]);
    return {
      mode,
      sourceId: messageId,
      to: uniq(to, new Set()),
      cc: uniq(cc, new Set()),
      bcc: uniq(toAddrList(meta.bccAddrs), new Set()),
      subject: meta.subject ?? "",
      html: sanitizeOutgoingHtml(parsed.html || parsed.textAsHtml || escapeHtml(parsed.text ?? "")),
      quoteLabel: null,
      attachments: opened.attachments,
    };
  }

  if (mode === "forward") {
    const opened = await openMessage(auth, messageId, { images: "block" });
    return {
      mode,
      sourceId: messageId,
      to: [],
      cc: [],
      bcc: [],
      subject: forwardSubject(meta.subject),
      html: "",
      quoteLabel: `Forwarded message from ${formatAddr(from) || "unknown sender"}, ${dateText}`,
      attachments: opened.attachments,
    };
  }

  // Replying to your own message (e.g. from Sent) goes to its original recipients.
  const primary = isMine ? to : replyTo.length ? replyTo : [from];
  const exclude = new Set<string>([me]);
  const toList = uniq(primary, exclude);
  const ccList = mode === "replyAll" ? uniq([...(isMine ? [] : to), ...cc], exclude) : [];
  return {
    mode,
    sourceId: messageId,
    to: toList.length ? toList : isMine ? uniq(to, new Set()) : [],
    cc: ccList,
    bcc: [],
    subject: replySubject(meta.subject),
    html: "",
    quoteLabel: `On ${dateText}, ${formatAddr(from) || "unknown sender"} wrote:`,
    attachments: [],
  };
}

/** Address suggestions: saved/auto contacts first, then people who wrote to this mailbox. */
export async function suggestContacts(auth: AuthorizedMailbox, q: string): Promise<ContactDTO[]> {
  const term = q.trim().toLowerCase().slice(0, 100);
  if (term.length < 1) return [];
  const p = db();
  const [contacts, senders] = await Promise.all([
    p.contact.findMany({
      where: {
        mailboxId: auth.mailboxId,
        OR: [{ email: { startsWith: term } }, { name: { startsWith: term } }, { name: { contains: ` ${term}` } }],
      },
      orderBy: [{ useCount: "desc" }, { lastUsedAt: "desc" }],
      take: 8,
      select: { email: true, name: true },
    }),
    p.messageMeta.groupBy({
      by: ["fromAddress", "fromName"],
      where: {
        mailboxId: auth.mailboxId,
        fromAddress: { not: null },
        OR: [{ fromAddress: { startsWith: term } }, { fromName: { startsWith: term } }],
      },
      _max: { internalDate: true },
      orderBy: { _max: { internalDate: "desc" } },
      take: 12,
    }),
  ]);
  const out = new Map<string, ContactDTO>();
  for (const c of contacts) out.set(c.email, { name: c.name, address: c.email });
  for (const s of senders) {
    if (s.fromAddress && !out.has(s.fromAddress)) out.set(s.fromAddress, { name: s.fromName, address: s.fromAddress });
  }
  return [...out.values()].slice(0, 8);
}

/** Remember everyone the user writes to (powers autocomplete). Never throws. */
export async function rememberRecipients(mailboxId: string, recipients: string[]): Promise<void> {
  const now = new Date();
  const seen = new Set<string>();
  for (const raw of recipients.slice(0, 100)) {
    const m = /^(?:"?([^"<]*?)"?\s*)?<?([^\s<>]+@[^\s<>]+?)>?$/.exec(raw.trim());
    if (!m) continue;
    const email = m[2].toLowerCase().slice(0, 320);
    if (seen.has(email)) continue;
    seen.add(email);
    const name = m[1]?.trim().slice(0, 255) || null;
    await db()
      .contact.upsert({
        where: { mailboxId_email: { mailboxId, email } },
        create: { mailboxId, email, name, source: "AUTO", useCount: 1, lastUsedAt: now },
        update: { useCount: { increment: 1 }, lastUsedAt: now },
      })
      .catch(() => {});
  }
}
