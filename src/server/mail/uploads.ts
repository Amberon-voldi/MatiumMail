import "server-only";
import { MAX_ATTACHMENTS_BYTES, UPLOAD_CHUNK_BYTES, type UploadDTO } from "@/lib/mail-types";
import type { AuthorizedMailbox } from "../auth/dal";
import { roleAllows } from "../auth/dal";
import { db } from "../db";
import type { OutgoingAttachment } from "./smtp";

/**
 * Composer attachments. Files arrive in chunks of at most UPLOAD_CHUNK_BYTES
 * (AWS Amplify's serverless functions can't take large request bodies), are
 * stored in MariaDB until the message is sent, and are scoped to the mailbox
 * and the user who uploaded them. Anything older than a day is purged.
 */

const STALE_MS = 24 * 60 * 60_000;

export class UploadError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "UploadError";
  }
}

/** True when the uploads tables are missing (the compose_uploads migration hasn't been applied). */
export function isMissingTable(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === "P2021" || /compose_upload(s|_chunks).*doesn't exist|does not exist in the current database/i.test(e?.message ?? "");
}

function assertSend(auth: AuthorizedMailbox) {
  if (!roleAllows(auth.role, "send")) throw new UploadError("Not permitted.", 403);
}

export function cleanFilename(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f\\/]/g, "_").trim().slice(0, 200);
  return cleaned || "attachment";
}

export function cleanContentType(type: string): string {
  return /^[\w.+-]+\/[\w.+-]+$/.test(type) && type.length <= 100 ? type.toLowerCase() : "application/octet-stream";
}

export async function createUpload(
  auth: AuthorizedMailbox,
  input: { filename: string; contentType: string; size: number },
): Promise<UploadDTO> {
  assertSend(auth);
  if (!Number.isInteger(input.size) || input.size < 0 || input.size > MAX_ATTACHMENTS_BYTES) {
    throw new UploadError(`Attachments can be up to ${Math.round(MAX_ATTACHMENTS_BYTES / 1024 / 1024)} MB in total.`, 413);
  }
  const p = db();
  // Opportunistic clean-up of abandoned uploads (no background workers here).
  await p.composeUpload.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - STALE_MS) } } }).catch(() => {});
  const row = await p.composeUpload.create({
    data: {
      mailboxId: auth.mailboxId,
      userId: auth.userId,
      filename: cleanFilename(input.filename),
      contentType: cleanContentType(input.contentType),
      size: input.size,
    },
    select: { id: true, filename: true, contentType: true, size: true },
  });
  return row;
}

async function ownUpload(auth: AuthorizedMailbox, uploadId: string) {
  const row = await db().composeUpload.findFirst({
    where: { id: uploadId, mailboxId: auth.mailboxId, userId: auth.userId },
    select: { id: true, size: true },
  });
  if (!row) throw new UploadError("Upload not found.", 404);
  return row;
}

export async function putChunk(auth: AuthorizedMailbox, uploadId: string, seq: number, data: Buffer): Promise<void> {
  assertSend(auth);
  const upload = await ownUpload(auth, uploadId);
  const chunks = Math.max(1, Math.ceil(upload.size / UPLOAD_CHUNK_BYTES));
  if (!Number.isInteger(seq) || seq < 0 || seq >= chunks) throw new UploadError("Unexpected chunk.");
  const expected = seq === chunks - 1 ? upload.size - seq * UPLOAD_CHUNK_BYTES : UPLOAD_CHUNK_BYTES;
  if (data.length !== expected) throw new UploadError("Chunk size doesn't match the file.");
  const bytes = new Uint8Array(data);
  await db().composeUploadChunk.upsert({
    where: { uploadId_seq: { uploadId, seq } },
    create: { uploadId, seq, data: bytes },
    update: { data: bytes },
  });
}

export async function deleteUploads(auth: AuthorizedMailbox, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db().composeUpload.deleteMany({ where: { id: { in: ids }, mailboxId: auth.mailboxId, userId: auth.userId } });
}

/** The complete files, in the order given; fails if any is missing or incomplete. */
export async function loadUploads(auth: AuthorizedMailbox, ids: string[]): Promise<OutgoingAttachment[]> {
  if (ids.length === 0) return [];
  const rows = await db().composeUpload.findMany({
    where: { id: { in: ids }, mailboxId: auth.mailboxId, userId: auth.userId },
    select: { id: true, filename: true, contentType: true, size: true, chunks: { orderBy: { seq: "asc" }, select: { seq: true, data: true } } },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => {
    const r = byId.get(id);
    if (!r) throw new UploadError("An attachment is missing. Please attach it again.");
    const content = Buffer.concat(r.chunks.map((c) => Buffer.from(c.data)));
    if (content.length !== r.size || r.chunks.some((c, i) => c.seq !== i)) {
      throw new UploadError(`"${r.filename}" didn't finish uploading. Please attach it again.`);
    }
    return { filename: r.filename, contentType: r.contentType, content };
  });
}
