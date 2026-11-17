import { createHash } from "node:crypto";
import type { MessageAddressObject, MessageStructureObject } from "imapflow";

/** Pure helpers that turn IMAP fetch data into `message_meta` columns. */

const MAX_ID = 512;

export function normalizeMessageId(id?: string | null): string | null {
  if (!id) return null;
  const trimmed = id.trim();
  if (!trimmed) return null;
  const wrapped = trimmed.startsWith("<") ? trimmed : `<${trimmed}>`;
  return wrapped.length > MAX_ID ? null : wrapped;
}

/** Message-IDs from a raw "References:" header block (folded lines allowed). */
export function parseReferences(headers?: Buffer | string | null): string[] {
  if (!headers) return [];
  const raw = typeof headers === "string" ? headers : headers.toString("utf8");
  // Unfold continuation lines (RFC 5322 §2.2.3), then read the single logical line.
  const text = raw.replace(/\r?\n[ \t]+/g, " ");
  const match = /^references:(.*)$/im.exec(text);
  if (!match) return [];
  const ids = match[1].match(/<[^<>\s]+>/g) ?? [];
  return [...new Set(ids)].filter((id) => id.length <= MAX_ID).slice(-50);
}

/**
 * Conversation key: the thread root's Message-ID (first reference, else the
 * parent, else the message itself), hashed to a fixed length.
 */
export function threadKeyFor(messageId: string | null, inReplyTo: string | null, references: string[]): string | null {
  const root = references[0] ?? inReplyTo ?? messageId;
  if (!root) return null;
  return createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 32);
}

/** True if any part is a real attachment (inline images with a Content-ID don't count). */
export function hasAttachments(node?: MessageStructureObject | null): boolean {
  if (!node) return false;
  if (node.childNodes?.length) return node.childNodes.some((child) => hasAttachments(child));
  const type = (node.type ?? "").toLowerCase();
  const disposition = (node.disposition ?? "").toLowerCase();
  if (disposition === "attachment") return true;
  if (type.startsWith("multipart/") || type === "text/plain" || type === "text/html") return false;
  const filename = node.dispositionParameters?.filename ?? node.parameters?.name;
  if (disposition === "inline" && node.id) return false; // embedded image referenced via cid:
  return Boolean(filename);
}

export type Address = { name: string | null; address: string | null };

export function toAddressList(list?: MessageAddressObject[] | null): Address[] {
  if (!list?.length) return [];
  return list.slice(0, 100).map((a) => ({
    name: a.name?.trim().slice(0, 255) || null,
    address: a.address?.trim().toLowerCase().slice(0, 320) || null,
  }));
}

export function flagColumns(flags?: Iterable<string> | null) {
  const list = flags ? [...flags] : [];
  const has = (f: string) => list.some((x) => x.toLowerCase() === f.toLowerCase());
  return {
    flags: list,
    isSeen: has("\\Seen"),
    isFlagged: has("\\Flagged"),
    isAnswered: has("\\Answered"),
    isDraft: has("\\Draft"),
  };
}

export function sameFlags(a: unknown, b: Iterable<string>): boolean {
  const left = Array.isArray(a) ? (a as string[]).map((x) => x.toLowerCase()).sort() : [];
  const right = [...b].map((x) => x.toLowerCase()).sort();
  return left.length === right.length && left.every((x, i) => x === right[i]);
}

export function toDate(value?: Date | string | null): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
