import type { NextRequest } from "next/server";
import { json, mailboxRoute } from "@/server/api";
import { suggestContacts } from "@/server/mail/messages";

/** Recipient autocomplete: ?q=<prefix of a name or address>. */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/mail/[mailboxId]/contacts">) {
  return mailboxRoute(request, ctx.params, "send", async (auth) => {
    const q = request.nextUrl.searchParams.get("q") ?? "";
    return json({ contacts: await suggestContacts(auth, q) }, { headers: { "Cache-Control": "private, max-age=60" } });
  });
}
