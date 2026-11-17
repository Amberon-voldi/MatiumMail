"use client";

import { useActionState } from "react";
import { Loader2 } from "lucide-react";
import { signInAction, type SignInState } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LoginForm() {
  const [state, formAction, pending] = useActionState<SignInState, FormData>(signInAction, {});

  return (
    <form action={formAction} className="space-y-5" aria-describedby={state.error ? "login-error" : undefined}>
      <div className="space-y-2">
        <Label htmlFor="email">Email address</Label>
        <Input
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="you@company.com"
          defaultValue={state.email}
          required
          autoFocus
          className="h-10"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="h-10"
        />
      </div>

      {state.error ? (
        <p
          id="login-error"
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
          "Sign in"
        )}
      </Button>
    </form>
  );
}
