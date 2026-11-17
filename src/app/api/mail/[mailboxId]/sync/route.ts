import { z } from "zod";
import { json, mailboxRoute, readJson } from "@/server/api";
import { listFolders } from "@/server/mail/messages";
import { syncMailbox, type SyncScope } from "@/server/mail/sync";

const body = z.object({ scope: z.union([z.literal("inbox"), z.literal("all"), z.uuid()]).default("inbox") });

/**
 * Check the mail server for changes: "inbox", "all", or one folder id.
 * Answers with the result and the folders' fresh counts.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/mail/[mailboxId]/sync">) {
  return mailboxRoute(request, ctx.params, "read", async (auth) => {
    const { scope } = await readJson(request, body);
    const resolved: SyncScope = scope === "all" || scope === "inbox" ? scope : { folderId: scope };
    const result = await syncMailbox(auth.mailboxId, { scope: resolved });
    return json({ result, folders: await listFolders(auth) });
  });
}
