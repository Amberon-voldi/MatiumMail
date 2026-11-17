import "server-only";
import { headers } from "next/headers";

export type RequestContext = { ip: string; userAgent: string | null };

/**
 * Client IP and user agent for rate limiting and audit logs.
 *
 * On Netlify, `x-nf-client-connection-ip` is set by the platform from the TCP
 * connection and cannot be spoofed by the client, so it wins over
 * `x-forwarded-for` (which a client can pre-populate).
 */
export async function requestContext(): Promise<RequestContext> {
  const h = await headers();
  const ip =
    h.get("x-nf-client-connection-ip")?.trim() ||
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip")?.trim() ||
    "local";
  const userAgent = h.get("user-agent")?.slice(0, 512) ?? null;
  return { ip: ip.slice(0, 64), userAgent };
}
