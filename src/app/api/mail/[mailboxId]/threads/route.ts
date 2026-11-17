import type { NextRequest } from "next/server";
import { z } from "zod";
import { json, mailboxRoute } from "@/server/api";
import { listThreads } from "@/server/mail/messages";

/**
 * Conversations in a folder, newest first.
 *   ?folder=<id>&cursor=<from previous page>&q=<search>&all=1 (search every folder)&conv=0 (one row per message)
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/mail/[mailboxId]/threads">) {
  return mailboxRoute(request, ctx.params, "read", async (auth) => {
    const sp = request.nextUrl.searchParams;
    const folder = sp.get("folder");
    const page = await listThreads(auth, {
      folderId: folder && z.uuid().safeParse(folder).success ? folder : undefined,
      q: sp.get("q")?.slice(0, 100) ?? undefined,
      cursor: sp.get("cursor"),
      allFolders: sp.get("all") === "1",
      conversations: sp.get("conv") !== "0",
    });
    return json(page);
  });
}
