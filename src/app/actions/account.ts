"use server";

import { z } from "zod";
import { APP_PASSWORD_MIN_LENGTH, setAppPassword, type SetAppPasswordError } from "@/server/auth/app-password";
import { requireMailboxAccess, requireSignedInUser } from "@/server/auth/dal";
import { reconnectMailbox, type ReconnectError } from "@/server/auth/mailbox-password";
import { requestContext } from "@/server/request";

/** Server Actions for the signed-in accounts' own settings. */

export type AccountFormState = {
  error?: string;
  saved?: boolean;
};

const uuid = z.uuid();

const waitHint = (seconds?: number) => (seconds ? ` (about ${Math.max(1, Math.ceil(seconds / 60))} min)` : "");

const APP_PASSWORD_MESSAGES: Record<SetAppPasswordError, string> = {
  invalid_input: "Fill in all three fields.",
  too_short: `Use at least ${APP_PASSWORD_MIN_LENGTH} characters.`,
  mismatch: "The new passwords don't match.",
  wrong_current_password: "Your current password isn't correct.",
  rate_limited: "Too many attempts. Please wait a few minutes and try again.",
};

/** Bound to one signed-in account: setAppPasswordAction.bind(null, userId). */
export async function setAppPasswordAction(
  userId: string,
  _prev: AccountFormState,
  formData: FormData,
): Promise<AccountFormState> {
  const user = await requireSignedInUser(uuid.parse(userId));
  const ctx = await requestContext();

  let result: Awaited<ReturnType<typeof setAppPassword>>;
  try {
    result = await setAppPassword(
      user,
      {
        currentPassword: formData.get("currentPassword"),
        newPassword: formData.get("newPassword"),
        confirmPassword: formData.get("confirmPassword"),
      },
      ctx,
    );
  } catch (err) {
    console.error("[account] setting the app password failed", err instanceof Error ? err.message : err);
    return { error: "Couldn't save your password. Please try again in a minute." };
  }
  if (!result.ok) return { error: APP_PASSWORD_MESSAGES[result.error] + waitHint(result.retryAfterSeconds) };
  return { saved: true };
}

const RECONNECT_MESSAGES: Record<ReconnectError, string> = {
  invalid_input: "Enter the mailbox password.",
  invalid_credentials: "The mail server didn't accept that password.",
  rate_limited: "Too many attempts. Please wait a few minutes and try again.",
  mail_server_unavailable: "Couldn't reach your mail server. Please try again shortly.",
};

/** Bound to one mailbox: reconnectAction.bind(null, mailboxId). */
export async function reconnectAction(
  mailboxId: string,
  _prev: AccountFormState,
  formData: FormData,
): Promise<AccountFormState> {
  const auth = await requireMailboxAccess(uuid.parse(mailboxId), "manage");
  const ctx = await requestContext();

  let result: Awaited<ReturnType<typeof reconnectMailbox>>;
  try {
    result = await reconnectMailbox(auth, formData.get("password"), ctx);
  } catch (err) {
    console.error("[account] reconnecting the mailbox failed", err instanceof Error ? err.message : err);
    return { error: "Couldn't save the password. Please try again in a minute." };
  }
  if (!result.ok) return { error: RECONNECT_MESSAGES[result.error] + waitHint(result.retryAfterSeconds) };
  return { saved: true };
}
