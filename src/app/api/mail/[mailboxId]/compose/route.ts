import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, json, mailboxRoute } from "@/server/api";
import { composeContext } from "@/server/mail/messages";

const MODES = z.enum(["reply", "replyAll", "forward", "draft"]);

/** Recipients, subject and quote header for replying to / forwarding / editing a message. */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/mail/[mailboxId]/compose">) {
  return mailboxRoute(request, ctx.params, "send", async (auth) => {
    const sp = request.nextUrl.searchParams;
    const mode = MODES.safeParse(sp.get("mode"));
    const source = z.uuid().safeParse(sp.get("source"));
    if (!mode.success || !source.success) return apiError(400, "Invalid request.");
    return json(await composeContext(auth, source.data, mode.data));
  });
}
