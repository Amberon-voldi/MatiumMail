import { z } from "zod";
import { json, mailboxRoute, readJson } from "@/server/api";
import { createUpload } from "@/server/mail/uploads";

const body = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().max(255),
  size: z.number().int().min(0),
});

/** Start an attachment upload; the file then arrives in chunks (PUT …/uploads/<id>?seq=N). */
export async function POST(request: Request, ctx: RouteContext<"/api/mail/[mailboxId]/uploads">) {
  return mailboxRoute(request, ctx.params, "send", async (auth) => json(await createUpload(auth, await readJson(request, body))));
}
