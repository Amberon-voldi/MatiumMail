import { z } from "zod";
import { apiError, json, mailboxRoute } from "@/server/api";
import { backfillFolder } from "@/server/mail/sync";

/** Fetch the next batch of older messages of a folder from the mail server. */
export async function POST(request: Request, ctx: RouteContext<"/api/mail/[mailboxId]/folders/[folderId]/backfill">) {
  return mailboxRoute(request, ctx.params, "read", async (auth) => {
    const { folderId } = await ctx.params;
    if (!z.uuid().safeParse(folderId).success) return apiError(404, "Not found.");
    return json(await backfillFolder(auth.mailboxId, folderId));
  });
}
