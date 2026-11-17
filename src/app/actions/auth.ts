"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { audit } from "@/server/audit";
import { createSession, destroySessions } from "@/server/auth/session";
import { signIn, type SignInError } from "@/server/auth/sign-in";
import { requestContext } from "@/server/request";

/**
 * Server Actions for authentication.
 * Next.js only accepts these as POSTs whose Origin matches the Host (CSRF
 * protection); the session cookie is SameSite=Lax and HttpOnly on top of that.
 */

export type SignInState = {
  error?: string;
  email?: string;
};

const MESSAGES: Record<SignInError, string> = {
  invalid_input: "Enter your full email address and password.",
  invalid_credentials: "That email and password don't match an account here.",
  rate_limited: "Too many attempts. Please wait a few minutes and try again.",
  mail_server_unavailable: "Couldn't reach your mail server. Please try again shortly.",
  mailbox_password_required:
    "This mailbox's password was changed. Sign in once with the new mailbox password; after that your Matium Mail password works again.",
};

export async function signInAction(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const email = String(formData.get("email") ?? "").slice(0, 320);
  const password = String(formData.get("password") ?? "");
  const ctx = await requestContext();

  let result: Awaited<ReturnType<typeof signIn>>;
  try {
    result = await signIn({ email, password }, ctx);
  } catch (err) {
    // Infrastructure failure (database down, misconfiguration…): log for us,
    // show a calm message to the user, never leak internals.
    console.error("[auth] sign-in failed unexpectedly", err instanceof Error ? err.message : err);
    return { error: "Sign-in is temporarily unavailable. Please try again in a minute.", email };
  }
  if (!result.ok) {
    const wait =
      result.error === "rate_limited" && result.retryAfterSeconds
        ? ` (about ${Math.max(1, Math.ceil(result.retryAfterSeconds / 60))} min)`
        : "";
    return { error: MESSAGES[result.error] + wait, email };
  }

  await createSession(result.userId, ctx);
  redirect("/");
}

/** Signs out the account in the form's `userId` field, or every account when it is absent. */
export async function signOutAction(formData: FormData): Promise<void> {
  const ctx = await requestContext();
  const raw = formData.get("userId");
  const userId = typeof raw === "string" && z.uuid().safeParse(raw).success ? raw : undefined;
  const { ended, remaining } = await destroySessions(userId);
  for (const session of ended) {
    await audit({
      organizationId: session.user.organizationId,
      action: "auth.logout",
      actorUserId: session.user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }
  redirect(remaining > 0 ? "/accounts" : "/login");
}
