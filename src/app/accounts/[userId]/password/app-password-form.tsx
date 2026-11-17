"use client";

import Link from "next/link";
import { useActionState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import type { AccountFormState } from "@/app/actions/account";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AppPasswordForm({
  action,
  email,
  minLength,
}: {
  action: (prev: AccountFormState, form: FormData) => Promise<AccountFormState>;
  email: string;
  minLength: number;
}) {
  const [state, formAction, pending] = useActionState(action, {});

  if (state.saved) {
    return (
      <div className="pt-10 text-center">
        <CheckCircle2 className="mx-auto size-10 text-emerald-500" aria-hidden="true" />
        <h2 className="mt-4 text-lg font-semibold">Password saved</h2>
        <p className="mt-1 text-sm text-muted-foreground">Next time, sign in with {email} and this password.</p>
        <Button asChild className="mt-6" variant="outline">
          <Link href="/accounts">Back to accounts</Link>
        </Button>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-5" aria-describedby={state.error ? "password-error" : undefined}>
      {/* Lets password managers file the new password under the right account. */}
      <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />

      <div className="space-y-2">
        <Label htmlFor="currentPassword">Current password</Label>
        <Input
          id="currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          autoFocus
          aria-describedby="currentPassword-hint"
          className="h-10"
        />
        <p id="currentPassword-hint" className="text-xs text-muted-foreground">
          The mailbox password, or the current Matium Mail password.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="newPassword">New Matium Mail password</Label>
        <Input
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={minLength}
          maxLength={128}
          required
          aria-describedby="newPassword-hint"
          className="h-10"
        />
        <p id="newPassword-hint" className="text-xs text-muted-foreground">
          At least {minLength} characters.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirmPassword">Confirm new password</Label>
        <Input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          minLength={minLength}
          maxLength={128}
          required
          className="h-10"
        />
      </div>

      {state.error ? (
        <p
          id="password-error"
          role="alert"
          className="rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
        >
          {state.error}
        </p>
      ) : null}

      <Button type="submit" className="h-10 w-full" disabled={pending}>
        {pending ? (
          <>
            <Loader2 className="animate-spin" aria-hidden="true" />
            Saving…
          </>
        ) : (
          "Save password"
        )}
      </Button>
    </form>
  );
}
