import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/server/auth/cookie";

/**
 * Optimistic gate only: visitors without a session cookie are sent to /login
 * before any rendering. It does NOT validate the session (no database here) —
 * the Data Access Layer re-checks on every request, action and route handler.
 */
export function proxy(request: NextRequest) {
  if (!request.cookies.has(SESSION_COOKIE)) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  // Everything except the login page, Next internals, static files and the
  // manifest. API routes authenticate themselves and answer 401 as JSON (the
  // image proxy is requested from the sandboxed email frame and is authorised
  // by its signature, not the cookie).
  matcher: [
    "/((?!login|api/|_next/static|_next/image|favicon\\.ico|robots\\.txt|manifest\\.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
