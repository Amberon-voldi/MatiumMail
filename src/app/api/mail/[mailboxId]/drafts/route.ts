import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, json, mailboxRoute, readJson } from "@/server/api";
import { discardDraft, saveDraft, sendRequestSchema } from "@/server/mail/compose";

/** Save (or replace) the composer's draft in the Drafts folder. */
export async function POST(request: Request, ctx: RouteContext<"/api/mail/[mailboxId]/drafts">) {
  return mailboxRoute(request, ctx.params, "send", async (auth) => json(await saveDraft(auth, await readJson(request, sendRequestSchema))));
}

/** Discard: ?key=<draft key>&uploads=<id,id> */
export async function DELETE(request: NextRequest, ctx: RouteContext<"/api/mail/[mailboxId]/drafts">) {
  return mailboxRoute(request, ctx.params, "send", async (auth) => {
    const sp = request.nextUrl.searchParams;
    const key = z.uuid().safeParse(sp.get("key"));
    const uploads = z.array(z.uuid()).max(30).safeParse((sp.get("uploads") ?? "").split(",").filter(Boolean));
    if (!key.success || !uploads.success) return apiError(400, "Invalid request.");
    await discardDraft(auth, key.data, uploads.data);
    return json({ ok: true });
  });
}
