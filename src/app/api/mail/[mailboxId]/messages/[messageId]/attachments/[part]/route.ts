import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, mailboxRoute } from "@/server/api";
import { downloadAttachment, downloadAttachmentChunk } from "@/server/mail/messages";
import { isPartId } from "@/server/mail/structure";

/**
 * Download (or preview) one attachment.
 *   default        decoded file; images, PDFs and plain text open inline, everything else downloads
 *   ?download=1    always download
 *   ?chunk=N       raw, still-encoded piece N of a large attachment (the app reassembles and decodes;
 *                  AWS Amplify caps a response at ~5.7 MB)
 *
 * Inline content is never HTML/SVG, and is sandboxed by CSP, so an attachment
 * can't run script on this origin.
 */

const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"]);
const TOKEN = /^[\w.+-]+\/[\w.+-]+$/;

function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const utf8 = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/mail/[mailboxId]/messages/[messageId]/attachments/[part]">,
) {
  return mailboxRoute(request, ctx.params, "read", async (auth) => {
    const { messageId, part } = await ctx.params;
    if (!z.uuid().safeParse(messageId).success || !isPartId(part)) return apiError(404, "Not found.");
    const sp = request.nextUrl.searchParams;

    const chunk = sp.get("chunk");
    if (chunk !== null) {
      const index = Number(chunk);
      if (!Number.isInteger(index) || index < 0) return apiError(400, "Invalid chunk.");
      const { attachment, content, total } = await downloadAttachmentChunk(auth, messageId, part, index);
      return new Response(new Uint8Array(content), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "private, max-age=3600",
          "X-Content-Type-Options": "nosniff",
          "X-Chunk-Total": String(total),
          "X-Transfer-Encoding": attachment.encoding,
        },
      });
    }

    const { attachment, content } = await downloadAttachment(auth, messageId, part);
    const type = TOKEN.test(attachment.contentType) ? attachment.contentType : "application/octet-stream";
    const inline = sp.get("download") !== "1" && INLINE.has(type);
    const headers: Record<string, string> = {
      "Content-Type": type === "text/plain" ? "text/plain; charset=utf-8" : type,
      "Content-Length": String(content.length),
      "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", attachment.filename),
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    };
    // Browsers' PDF viewers don't work inside a CSP sandbox; PDFs can't script this origin anyway.
    if (type !== "application/pdf") headers["Content-Security-Policy"] = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";
    return new Response(new Uint8Array(content), { headers });
  });
}
