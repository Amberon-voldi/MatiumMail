import Link from "next/link";
import { Suspense } from "react";
import { Inbox, LogOut, Users } from "lucide-react";
import { signOutAction } from "@/app/actions/auth";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { listMailboxesForUser, requireUser, requireUsers, type MailboxSummary } from "@/server/auth/dal";

/**
 * Signed-in home. The frame is static (prerendered); everything that reads the
 * session streams in behind <Suspense>, as Cache Components requires.
 * Phase 4 replaces the placeholder pane with the inbox.
 */
export default function HomePage() {
  return (
    <div className="flex min-h-dvh">
      <aside className="hidden w-64 shrink-0 flex-col border-r bg-muted/30 md:flex">
        <div className="flex h-14 items-center gap-2.5 px-4">
          <Logo className="size-7 rounded-lg [&_svg]:size-4" />
          <span className="text-sm font-semibold tracking-tight">Matium Mail</span>
        </div>
        <Suspense fallback={<MailboxListSkeleton />}>
          <MailboxList />
        </Suspense>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between gap-3 border-b px-4">
          <div className="flex items-center gap-2.5 md:hidden">
            <Logo className="size-7 rounded-lg [&_svg]:size-4" />
            <span className="text-sm font-semibold tracking-tight">Matium Mail</span>
          </div>
          <div className="hidden md:block" />
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Suspense fallback={<div className="h-8 w-40 animate-pulse rounded-md bg-muted" />}>
              <AccountMenu />
            </Suspense>
          </div>
        </header>

        <main className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-sm text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-2xl border bg-muted/40">
              <Inbox className="size-5 text-muted-foreground" aria-hidden="true" />
            </div>
            {/* Session-dependent text streams in; the static frame says nothing about auth state. */}
            <Suspense fallback={<div className="mx-auto mt-5 h-5 w-40 animate-pulse rounded bg-muted" />}>
              <Welcome />
            </Suspense>
          </div>
        </main>
      </div>
    </div>
  );
}

async function Welcome() {
  const user = await requireUser();
  return (
    <>
      <h1 className="mt-5 text-lg font-semibold tracking-tight">
        Welcome{user.displayName ? `, ${user.displayName}` : ""}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Your mailbox is connected. The inbox, reading pane and composer arrive in the next phases.
      </p>
    </>
  );
}

async function AccountMenu() {
  const users = await requireUsers();
  return (
    <div className="flex items-center gap-2">
      <Button asChild variant="ghost" size="sm" className="max-w-56 gap-1.5">
        <Link href="/accounts" title="Manage accounts">
          <Users className="size-3.5" aria-hidden="true" />
          <span className="truncate">{users.length === 1 ? users[0].email : `${users.length} accounts`}</span>
        </Link>
      </Button>
      <form action={signOutAction}>
        <Button type="submit" variant="ghost" size="sm" className="gap-1.5">
          <LogOut className="size-3.5" aria-hidden="true" />
          {users.length === 1 ? "Sign out" : "Sign out of all"}
        </Button>
      </form>
    </div>
  );
}

/** Mailboxes of every signed-in account, each listed once. */
async function MailboxList() {
  const users = await requireUsers();
  const lists = await Promise.all(users.map((u) => listMailboxesForUser(u.id)));
  const mailboxes = [...new Map(lists.flat().map((m) => [m.id, m])).values()];
  return (
    <nav aria-label="Mailboxes" className="flex-1 overflow-y-auto px-2 py-2">
      <p className="px-2 pb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Mailboxes</p>
      <ul className="space-y-0.5">
        {mailboxes.map((m) => (
          <li key={m.id}>
            <MailboxRow mailbox={m} />
          </li>
        ))}
      </ul>
    </nav>
  );
}

function MailboxRow({ mailbox }: { mailbox: MailboxSummary }) {
  const ok = mailbox.status === "ACTIVE";
  return (
    <Link href={`/mail/${mailbox.id}`} className="flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm hover:bg-muted">
      <span
        className={ok ? "size-2 shrink-0 rounded-full bg-emerald-500" : "size-2 shrink-0 rounded-full bg-amber-500"}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{mailbox.displayName ?? mailbox.address}</span>
        {mailbox.status === "NEEDS_REAUTH" ? (
          <span className="block truncate text-xs text-destructive">Password changed: reconnect</span>
        ) : (
          <span className="block truncate text-xs text-muted-foreground">{mailbox.address}</span>
        )}
      </span>
      <span className="sr-only">{ok ? "connected" : `status ${mailbox.status.toLowerCase()}`}</span>
    </Link>
  );
}

function MailboxListSkeleton() {
  return (
    <div className="space-y-2 px-4 py-3" aria-hidden="true">
      <div className="h-3 w-20 animate-pulse rounded bg-muted" />
      <div className="h-10 animate-pulse rounded-lg bg-muted" />
    </div>
  );
}
