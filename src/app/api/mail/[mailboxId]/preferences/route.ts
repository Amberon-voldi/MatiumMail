import { json, mailboxRoute, readJson } from "@/server/api";
import { getPreferences, preferencesPatchSchema, updatePreferences } from "@/server/preferences";

/** Mail settings of the account using this mailbox. */
export async function GET(request: Request, ctx: RouteContext<"/api/mail/[mailboxId]/preferences">) {
  return mailboxRoute(request, ctx.params, "read", async (auth) => json(await getPreferences(auth.userId)));
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/mail/[mailboxId]/preferences">) {
  return mailboxRoute(request, ctx.params, "read", async (auth) =>
    json(await updatePreferences(auth.userId, await readJson(request, preferencesPatchSchema))),
  );
}
