import type { MessageStructureObject } from "imapflow";

/**
 * Pure helpers over an IMAP BODYSTRUCTURE tree: which parts are attachments
 * (with the part numbers needed to download just that part), which parts hold
 * the readable body, and how to rebuild a small message from those parts so a
 * huge email can be shown without downloading its attachments.
 */

export type AttachmentPart = {
  /** IMAP body part number, e.g. "2" or "1.3". */
  part: string;
  filename: string;
  contentType: string;
  /** Content transfer encoding on the server (base64, quoted-printable, 7bit…). */
  encoding: string;
  /** Size of the encoded part on the server, in bytes. */
  encodedSize: number;
  /** Approximate decoded size, in bytes (what the user downloads). */
  size: number;
};

const PART_ID = /^\d{1,4}(\.\d{1,4}){0,9}$/;

export function isPartId(value: string): boolean {
  return PART_ID.test(value);
}

const lower = (v?: string | null) => (v ?? "").toLowerCase();

/** Bytes after removing the transfer encoding (base64 lines are 76 chars + CRLF → 57 bytes). */
export function decodedSize(encodedSize: number, encoding?: string | null): number {
  const enc = lower(encoding);
  if (enc === "base64") return Math.floor((encodedSize * 57) / 78);
  if (enc === "quoted-printable") return Math.floor(encodedSize * 0.9);
  return encodedSize;
}

/** A filename that is safe to show and to put in Content-Disposition. */
export function safeFilename(name: string | null | undefined, fallback: string): string {
  const cleaned = (name ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]/g, "_")
    .trim()
    .slice(0, 200);
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : fallback;
}

const EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "text/calendar": "ics",
  "text/csv": "csv",
  "text/plain": "txt",
  "text/html": "html",
  "application/zip": "zip",
  "message/rfc822": "eml",
};

function nameOf(node: MessageStructureObject): string | undefined {
  return node.dispositionParameters?.filename || node.parameters?.name || undefined;
}

function fallbackName(node: MessageStructureObject): string {
  const type = lower(node.type);
  if (type === "message/rfc822") {
    const subject = node.envelope?.subject?.trim();
    return `${safeFilename(subject, "message").slice(0, 80)}.eml`;
  }
  return `attachment.${EXTENSIONS[type] ?? "bin"}`;
}

/** True when a leaf part is something the user would call an attachment. */
export function isAttachmentLeaf(node: MessageStructureObject, parentType: string | null): boolean {
  const type = lower(node.type);
  const disposition = lower(node.disposition);
  const filename = nameOf(node);
  if (disposition === "attachment") return true;
  if ((type === "text/plain" || type === "text/html") && !filename) return false; // the message body
  if (node.id && parentType === "multipart/related") return false; // embedded via cid:
  if (node.id && disposition === "inline" && type.startsWith("image/")) return false;
  return Boolean(filename) || !type.startsWith("text/");
}

/** Every attachment in the message, in the order it appears. */
export function attachmentParts(root?: MessageStructureObject | null): AttachmentPart[] {
  const out: AttachmentPart[] = [];
  const walk = (node: MessageStructureObject, parentType: string | null) => {
    const type = lower(node.type);
    const part = node.part || "1";
    if (type.startsWith("multipart/")) {
      for (const child of node.childNodes ?? []) walk(child, type);
      return;
    }
    // A forwarded message is one attachment; don't list what is inside it.
    if (type !== "message/rfc822" && !isAttachmentLeaf(node, parentType)) return;
    const encodedSize = node.size ?? 0;
    out.push({
      part,
      filename: safeFilename(nameOf(node), fallbackName(node)),
      contentType: type || "application/octet-stream",
      encoding: lower(node.encoding) || "7bit",
      encodedSize,
      size: decodedSize(encodedSize, node.encoding),
    });
  };
  if (root) walk(root, null);
  return out;
}

export type BodyLeaves = {
  html: MessageStructureObject | null;
  text: MessageStructureObject | null;
  /** Images referenced by cid: from the HTML body. */
  inline: MessageStructureObject[];
};

/** The parts needed to render the message body (first HTML, first plain text, embedded images). */
export function bodyLeaves(root?: MessageStructureObject | null, maxInlineBytes = 2 * 1024 * 1024): BodyLeaves {
  const out: BodyLeaves = { html: null, text: null, inline: [] };
  const walk = (node: MessageStructureObject, parentType: string | null) => {
    const type = lower(node.type);
    if (type.startsWith("multipart/")) {
      for (const child of node.childNodes ?? []) walk(child, type);
      return;
    }
    if (type === "message/rfc822") return;
    if (!isAttachmentLeaf(node, parentType)) {
      if (type === "text/html") out.html ??= node;
      else if (type === "text/plain") out.text ??= node;
      else if (node.id && type.startsWith("image/") && (node.size ?? 0) <= maxInlineBytes) out.inline.push(node);
    }
  };
  if (root) walk(root, null);
  return out;
}

/**
 * Header block with the top-level Content-Type / Content-Transfer-Encoding
 * removed (folded continuation lines included), so a new body can follow.
 */
export function stripContentHeaders(headers: string): string {
  const lines = headers.replace(/\r?\n/g, "\r\n").replace(/(\r\n)+$/, "").split("\r\n");
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^[ \t]/.test(line)) {
      if (!skipping) kept.push(line);
      continue;
    }
    skipping = /^content-(type|transfer-encoding)\s*:/i.test(line);
    if (!skipping) kept.push(line);
  }
  return kept.join("\r\n");
}

const headerValue = (v: string) => v.replace(/[\r\n"\\]/g, "").slice(0, 200);

/**
 * MIME headers for one leaf part, rebuilt from BODYSTRUCTURE. (Fetching
 * BODY[n.MIME] would be the alternative, but some servers answer it with the
 * parent's headers.) Only what a parser needs to decode and link the part.
 */
export function partHeaders(node: MessageStructureObject): string {
  const params = Object.entries(node.parameters ?? {})
    .filter(([k]) => /^[a-z0-9-]+$/i.test(k) && k.toLowerCase() !== "name")
    .map(([k, v]) => `; ${k}="${headerValue(v)}"`)
    .join("");
  const lines = [`Content-Type: ${lower(node.type) || "application/octet-stream"}${params}`];
  if (node.encoding) lines.push(`Content-Transfer-Encoding: ${headerValue(lower(node.encoding))}`);
  if (node.id) lines.push(`Content-ID: ${headerValue(node.id)}`);
  if (node.disposition) lines.push(`Content-Disposition: ${headerValue(lower(node.disposition))}`);
  return lines.join("\r\n");
}

/**
 * A minimal multipart/related message made of the original headers and the
 * given parts (MIME headers + still-encoded body). A MIME parser renders it
 * exactly like the original body, without downloading the attachments.
 * Header bytes are handled as latin1 so 8-bit header bytes pass unchanged.
 */
export function syntheticMessage(headers: Buffer, parts: Array<{ mime: string; body: Buffer }>, boundary: string): Buffer {
  const bytes = (s: string) => Buffer.from(s, "latin1");
  const chunks: Buffer[] = [
    bytes(`${stripContentHeaders(headers.toString("latin1"))}\r\nContent-Type: multipart/related; boundary="${boundary}"\r\n\r\n`),
  ];
  for (const p of parts) {
    const mime = p.mime.replace(/\r?\n/g, "\r\n").replace(/(\r\n)+$/, "");
    chunks.push(bytes(`--${boundary}\r\n${mime}\r\n\r\n`), p.body, bytes("\r\n"));
  }
  chunks.push(bytes(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}
