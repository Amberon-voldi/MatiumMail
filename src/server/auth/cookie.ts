/**
 * Session cookie name. Kept in its own dependency-free module so `src/proxy.ts`
 * can import it without pulling in the database or crypto code.
 *
 * Production uses the `__Host-` prefix: the browser then only accepts the
 * cookie if it is Secure, has Path=/ and no Domain — so no subdomain can set
 * or overwrite it.
 */
export const SESSION_COOKIE = process.env.NODE_ENV === "production" ? "__Host-mm_session" : "mm_session";
