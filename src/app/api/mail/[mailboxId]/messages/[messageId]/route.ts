import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, json, mailboxRoute } from "@/server/api";
import { openMessage } from "@/server/mail/messages";

/**
 * A message's sanitised body document, attachments and addresses.
 *   ?images=block keeps remote images hidden; otherwise they load through the privacy proxy.
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/mail/[mailboxId]/messages/[messageId]">) {
  return mailboxRoute(request, ctx.params, "read", async (auth) => {
    const { messageId } = await ctx.params;
    if (!z.uuid().safeParse(messageId).success) return apiError(404, "Not found.");
    const images = request.nextUrl.searchParams.get("images") === "block" ? "block" : "proxy";
    return json(await openMessage(auth, messageId, { images }));
  });
}
