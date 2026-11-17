/**
 * Session cookie name. Kept in its own dependency-free module so `src/proxy.ts`
 * can import it without pulling in the database or crypto code.
 *
 * Production uses the `__Host-` prefix: the browser then only accepts the
 * cookie if it is Secure, has Path=/ and no Domain — so no subdomain can set
 * or overwrite it.
 */
export const SESSION_COOKIE = process.env.NODE_ENV === "production" ? "__Host-mm_session" : "mm_session";

/** How many accounts one browser can be signed in to at once. */
export const MAX_ACCOUNTS = 10;

const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * The cookie holds one session token per signed-in account, most recent
 * sign-in first, joined by "." (never part of a base64url token). A cookie
 * from before multi-account support is simply a list of one.
 */
export function parseSessionCookie(value: string | undefined): string[] {
  if (!value) return [];
  const tokens = value.split(".").filter((t) => TOKEN.test(t));
  return [...new Set(tokens)].slice(0, MAX_ACCOUNTS);
}

export function serializeSessionCookie(tokens: readonly string[]): string {
  return tokens.join(".");
}
