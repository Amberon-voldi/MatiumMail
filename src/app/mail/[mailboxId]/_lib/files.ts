import { UPLOAD_CHUNK_BYTES, type AttachmentDTO, type UploadDTO } from "@/lib/mail-types";
import { api, type MailApi } from "./api";

/**
 * Attachment transfer in the browser. Big files move in pieces because the
 * hosting platform caps each request/response at a few MB:
 *   - downloads over the cap arrive as raw (still base64/QP-encoded) pieces,
 *     reassembled and decoded here;
 *   - uploads are sliced into UPLOAD_CHUNK_BYTES pieces.
 */

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function decodeBase64(raw: Uint8Array): Uint8Array {
  // Base64 text is ASCII; drop line breaks and anything else that isn't base64.
  let text = "";
  const STEP = 1 << 16;
  for (let i = 0; i < raw.length; i += STEP) text += String.fromCharCode(...raw.subarray(i, i + STEP));
  text = text.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let written = 0;
  const SLICE = 4 * 262_144; // decode in slices to keep memory flat
  for (let i = 0; i < text.length; i += SLICE) {
    let piece = text.slice(i, i + SLICE);
    if (i + SLICE >= text.length && piece.length % 4) piece += "=".repeat(4 - (piece.length % 4));
    const bin = atob(piece);
    for (let j = 0; j < bin.length; j++) out[written++] = bin.charCodeAt(j);
  }
  return out.subarray(0, written);
}

function decodeQuotedPrintable(raw: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== 0x3d) {
      out.push(c);
      continue;
    }
    // "=\r\n" / "=\n" soft line break, "=XX" byte
    if (raw[i + 1] === 0x0d && raw[i + 2] === 0x0a) i += 2;
    else if (raw[i + 1] === 0x0a) i += 1;
    else {
      const hex = String.fromCharCode(raw[i + 1] ?? 0, raw[i + 2] ?? 0);
      if (/^[0-9a-f]{2}$/i.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
      } else out.push(c);
    }
  }
  return Uint8Array.from(out);
}

/** The whole attachment as a Blob (chunked transfer for large files). */
export async function fetchAttachment(
  mail: MailApi,
  messageId: string,
  att: AttachmentDTO,
  onProgress?: (fraction: number) => void,
): Promise<Blob> {
  if (!att.chunked) {
    const res = await api<Response>(mail.attachmentUrl(messageId, att.part, { download: true }), { raw: true, timeoutMs: 120_000 });
    const blob = await res.blob();
    onProgress?.(1);
    return new Blob([blob], { type: att.contentType || "application/octet-stream" });
  }
  const parts: Uint8Array[] = [];
  for (let i = 0; i < att.chunks; i++) {
    const res = await api<Response>(mail.attachmentUrl(messageId, att.part, { chunk: i }), { raw: true, timeoutMs: 120_000 });
    parts.push(new Uint8Array(await res.arrayBuffer()));
    onProgress?.((i + 1) / att.chunks);
  }
  const raw = concat(parts);
  const bytes = att.encoding === "base64" ? decodeBase64(raw) : att.encoding === "quoted-printable" ? decodeQuotedPrintable(raw) : raw;
  return new Blob([bytes as BlobPart], { type: att.contentType || "application/octet-stream" });
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Types the browser can show by itself (opened in a new tab instead of downloaded). */
export const PREVIEWABLE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"]);

/** Upload a file in chunks; returns the server's upload record. */
export async function uploadFile(
  mail: MailApi,
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<UploadDTO> {
  const upload = await mail.createUpload({ filename: file.name, contentType: file.type || "application/octet-stream", size: file.size });
  const chunks = Math.max(1, Math.ceil(file.size / UPLOAD_CHUNK_BYTES));
  for (let seq = 0; seq < chunks; seq++) {
    if (signal?.aborted) throw new DOMException("Upload cancelled", "AbortError");
    await mail.putChunk(upload.id, seq, file.slice(seq * UPLOAD_CHUNK_BYTES, (seq + 1) * UPLOAD_CHUNK_BYTES));
    onProgress((seq + 1) / chunks);
  }
  return upload;
}
