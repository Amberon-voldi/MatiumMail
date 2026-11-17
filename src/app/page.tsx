import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Inbox } from "lucide-react";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { listMailboxesForUser, requireUsers } from "@/server/auth/dal";

/**
 * Signed-in home: goes straight to the inbox of the most recently signed-in
 * account's own mailbox (or the first one it can open). Only an account with
 * no mailbox at all stays here.
 */
export default function HomePage() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-8">
      <Suspense fallback={<OpeningInbox />}>
        <OpenInbox />
      </Suspense>
    </main>
  );
}

async function OpenInbox() {
  const users = await requireUsers();
  for (const user of users) {
    const mailboxes = await listMailboxesForUser(user.id);
    const target = mailboxes.find((m) => m.address === user.email) ?? mailboxes[0];
    if (target) redirect(`/mail/${target.id}`);
  }
  return (
    <div className="max-w-sm text-center">
      <div className="mx-auto flex size-12 items-center justify-center rounded-2xl border bg-muted/40">
        <Inbox className="size-5 text-muted-foreground" aria-hidden="true" />
      </div>
      <h1 className="mt-5 text-lg font-semibold tracking-tight">No mailbox yet</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        This account doesn&apos;t have a mailbox it can open. Ask your administrator to grant one, or sign in with
        another address.
      </p>
      <Button asChild variant="outline" className="mt-6">
        <Link href="/accounts">Manage accounts</Link>
      </Button>
    </div>
  );
}

function OpeningInbox() {
  return (
    <div className="flex flex-col items-center gap-4 text-sm text-muted-foreground" role="status">
      <Logo className="size-12 animate-pulse" />
      Opening your inbox…
    </div>
  );
}
