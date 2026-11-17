import type { Metadata } from "next";
import Link from "next/link";
import { LoginForm } from "../login-form";
import { LoginShell } from "../login-shell";

export const metadata: Metadata = { title: "Add another account" };

/** Signing in here keeps the accounts this browser is already signed in to. */
export default function AddAccountPage() {
  return (
    <LoginShell
      title="Add another account"
      subtitle="Sign in with another work email address. You'll stay signed in to your other accounts."
    >
      <LoginForm />
      <p className="mt-4 text-center text-sm">
        <Link href="/accounts" className="text-muted-foreground underline-offset-4 hover:underline">
          Back to your accounts
        </Link>
      </p>
    </LoginShell>
  );
}
