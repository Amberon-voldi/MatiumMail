import type { NextRequest } from "next/server";
import { z } from "zod";
import { UPLOAD_CHUNK_BYTES } from "@/lib/mail-types";
import { apiError, json, mailboxRoute } from "@/server/api";
import { deleteUploads, putChunk } from "@/server/mail/uploads";

/** One chunk of an attachment upload: raw bytes, ?seq=N (0-based). */
export async function PUT(request: NextRequest, ctx: RouteContext<"/api/mail/[mailboxId]/uploads/[uploadId]">) {
  return mailboxRoute(request, ctx.params, "send", async (auth) => {
    const { uploadId } = await ctx.params;
    if (!z.uuid().safeParse(uploadId).success) return apiError(404, "Not found.");
    const seq = Number(request.nextUrl.searchParams.get("seq"));
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > UPLOAD_CHUNK_BYTES) return apiError(413, "Chunk too large.");
    const data = Buffer.from(await request.arrayBuffer());
    if (data.length > UPLOAD_CHUNK_BYTES) return apiError(413, "Chunk too large.");
    await putChunk(auth, uploadId, seq, data);
    return json({ ok: true });
  });
}

/** Remove an attachment the user took off the message. */
export async function DELETE(request: Request, ctx: RouteContext<"/api/mail/[mailboxId]/uploads/[uploadId]">) {
  return mailboxRoute(request, ctx.params, "send", async (auth) => {
    const { uploadId } = await ctx.params;
    if (!z.uuid().safeParse(uploadId).success) return apiError(404, "Not found.");
    await deleteUploads(auth, [uploadId]);
    return json({ ok: true });
  });
}
