import { z } from "zod";
import { apiError, json, mailboxRoute } from "@/server/api";
import { getThread } from "@/server/mail/messages";

/** The conversation a message belongs to (headers only, oldest first). */
export async function GET(request: Request, ctx: RouteContext<"/api/mail/[mailboxId]/threads/[messageId]">) {
  return mailboxRoute(request, ctx.params, "read", async (auth) => {
    const { messageId } = await ctx.params;
    if (!z.uuid().safeParse(messageId).success) return apiError(404, "Not found.");
    return json(await getThread(auth, messageId));
  });
}
