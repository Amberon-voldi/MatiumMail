import { apiError, json, mailboxRoute, readJson } from "@/server/api";
import { consume } from "@/server/auth/rate-limit";
import { sendFromRequest, sendRequestSchema } from "@/server/mail/compose";

/** Send a message (new, reply, reply-all, forward or edited draft). */
export async function POST(request: Request, ctx: RouteContext<"/api/mail/[mailboxId]/send">) {
  return mailboxRoute(request, ctx.params, "send", async (auth) => {
    const req = await readJson(request, sendRequestSchema);
    // Guard against runaway sending from a compromised session or a bug.
    const limit = await consume({ key: `send:${auth.mailboxId}`, max: 30, windowMs: 10 * 60_000, blockMs: 10 * 60_000 });
    if (!limit.allowed) return apiError(429, "Sending limit reached. Please wait a few minutes.", "rate_limited");
    const result = await sendFromRequest(auth, req);
    return json({ ok: true, messageId: result.messageId, savedToSent: result.savedToSent });
  });
}
