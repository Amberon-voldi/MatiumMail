import type { NextRequest } from "next/server";
import { fetchRemoteImage, normaliseRemoteUrl, verifyImageUrl } from "@/server/mail/image-proxy";

/**
 * Image privacy proxy for email content (see src/server/mail/image-proxy.ts).
 * Authorised by the URL's signature, not the session: the request comes from
 * the sandboxed email frame. The response can never run as a page here.
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("u") ?? "";
  const sig = request.nextUrl.searchParams.get("s") ?? "";
  const expires = Number(request.nextUrl.searchParams.get("e"));
  if (!url || normaliseRemoteUrl(url) !== url || !verifyImageUrl(url, expires, sig)) {
    return new Response("Invalid image link.", { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const image = await fetchRemoteImage(url);
  if (!image.ok) {
    // Brief negative caching so a broken image isn't re-fetched on every render.
    return new Response(null, { status: image.status, headers: { "Cache-Control": "private, max-age=300" } });
  }
  return new Response(new Uint8Array(image.body), {
    headers: {
      "Content-Type": image.contentType,
      "Content-Length": String(image.body.length),
      "Cache-Control": "private, max-age=86400",
      "Content-Disposition": "inline",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
