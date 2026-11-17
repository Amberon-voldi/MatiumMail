"use client";

import Link from "next/link";
import { useActionState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import type { AccountFormState } from "@/app/actions/account";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ReconnectForm({
  action,
  address,
  backHref,
}: {
  action: (prev: AccountFormState, form: FormData) => Promise<AccountFormState>;
  address: string;
  backHref: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});

  if (state.saved) {
    return (
      <div className="pt-10 text-center">
        <CheckCircle2 className="mx-auto size-10 text-emerald-500" aria-hidden="true" />
        <h2 className="mt-4 text-lg font-semibold">Mailbox reconnected</h2>
        <p className="mt-1 text-sm text-muted-foreground">The new password is saved.</p>
        <Button asChild className="mt-6" variant="outline">
          <Link href={backHref}>Back to mail</Link>
        </Button>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-5" aria-describedby={state.error ? "reconnect-error" : undefined}>
      <input type="email" name="username" autoComplete="username" value={address} readOnly hidden />

      <div className="space-y-2">
        <Label htmlFor="password">New mailbox password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          autoFocus
          className="h-10"
        />
      </div>

      {state.error ? (
        <p
          id="reconnect-error"
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
            Checking with your mail server…
          </>
        ) : (
          "Save and reconnect"
        )}
      </Button>
    </form>
  );
}
