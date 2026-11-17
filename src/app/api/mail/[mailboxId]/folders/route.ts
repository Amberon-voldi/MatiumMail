import { json, mailboxRoute } from "@/server/api";
import { listFolders } from "@/server/mail/messages";

/** Folders with unread/total counts. */
export async function GET(request: Request, ctx: RouteContext<"/api/mail/[mailboxId]/folders">) {
  return mailboxRoute(request, ctx.params, "read", async (auth) => json({ folders: await listFolders(auth) }));
}
