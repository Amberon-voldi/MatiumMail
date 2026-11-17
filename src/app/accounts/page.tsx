import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ArrowLeft, KeyRound, LogOut, Plus } from "lucide-react";
import { signOutAction } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { hasAppPassword } from "@/server/auth/app-password";
import { MAX_ACCOUNTS } from "@/server/auth/cookie";
import { listMailboxesForUser, requireUsers } from "@/server/auth/dal";

export const metadata: Metadata = { title: "Accounts" };

/** Every account this browser is signed in to, with its password settings and sign-out. */
export default function AccountsPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-14 items-center gap-2 border-b px-4">
        <Button asChild variant="ghost" size="icon" aria-label="Back to mail">
          <Link href="/">
            <ArrowLeft />
          </Link>
        </Button>
        <h1 className="text-sm font-semibold">Accounts</h1>
      </header>
      <Suspense fallback={<div className="m-auto text-sm text-muted-foreground">Loading…</div>}>
        <Accounts />
      </Suspense>
    </div>
  );
}

async function Accounts() {
  const users = await requireUsers();
  const rows = await Promise.all(
    users.map(async (user) => {
      const [mailboxes, appPassword] = await Promise.all([listMailboxesForUser(user.id), hasAppPassword(user.id)]);
      return { user, own: mailboxes.find((m) => m.address === user.email) ?? null, appPassword };
    }),
  );

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 p-6">
      <p className="text-sm text-muted-foreground">
        {users.length === 1
          ? "You're signed in to one account in this browser."
          : `You're signed in to ${users.length} accounts in this browser. Mail from all of them is open at once.`}
      </p>

      <ul className="divide-y rounded-xl border">
        {rows.map(({ user, own, appPassword }) => (
          <li key={user.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{user.displayName ?? user.email}</p>
              {user.displayName ? <p className="truncate text-xs text-muted-foreground">{user.email}</p> : null}
              <p className="mt-1 text-xs text-muted-foreground">
                {appPassword ? "Matium Mail password set" : "Signs in with the mailbox password"}
              </p>
              {own ? (
                <p className="mt-1 text-xs">
                  <Link
                    href={`/mail/${own.id}/reconnect`}
                    className={
                      own.status === "NEEDS_REAUTH"
                        ? "font-medium text-destructive underline underline-offset-2"
                        : "text-muted-foreground underline-offset-2 hover:underline"
                    }
                  >
                    {own.status === "NEEDS_REAUTH"
                      ? "Mailbox password changed: enter the new one"
                      : "Changed the mailbox password in mPanel?"}
                  </Link>
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {own ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={`/mail/${own.id}`}>Open mail</Link>
                </Button>
              ) : null}
              <Button asChild variant="outline" size="sm">
                <Link href={`/accounts/${user.id}/password`}>
                  <KeyRound aria-hidden="true" />
                  {appPassword ? "Change password" : "Set short password"}
                </Link>
              </Button>
              <form action={signOutAction}>
                <input type="hidden" name="userId" value={user.id} />
                <Button type="submit" variant="ghost" size="sm" aria-label={`Sign out of ${user.email}`}>
                  <LogOut aria-hidden="true" />
                  Sign out
                </Button>
              </form>
            </div>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-3">
        {users.length < MAX_ACCOUNTS ? (
          <Button asChild>
            <Link href="/login/add">
              <Plus aria-hidden="true" />
              Add another account
            </Link>
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">You can be signed in to up to {MAX_ACCOUNTS} accounts at once.</p>
        )}
        {users.length > 1 ? (
          <form action={signOutAction}>
            <Button type="submit" variant="ghost">
              Sign out of all accounts
            </Button>
          </form>
        ) : null}
      </div>
    </div>
  );
}
