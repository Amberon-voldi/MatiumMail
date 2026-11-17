import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeft } from "lucide-react";
import { z } from "zod";
import { reconnectAction } from "@/app/actions/account";
import { Button } from "@/components/ui/button";
import { requireMailboxAccess } from "@/server/auth/dal";
import { mailboxOverview } from "@/server/mail/messages";
import { ReconnectForm } from "./reconnect-form";

export const metadata: Metadata = { title: "Update mailbox password" };

export default function ReconnectPage(props: PageProps<"/mail/[mailboxId]/reconnect">) {
  return (
    <div className="flex min-h-dvh flex-col">
      <Suspense fallback={<div className="m-auto text-sm text-muted-foreground">Loading…</div>}>
        <Reconnect params={props.params} />
      </Suspense>
    </div>
  );
}

async function Reconnect({ params }: Pick<PageProps<"/mail/[mailboxId]/reconnect">, "params">) {
  const { mailboxId } = await params;
  if (!z.uuid().safeParse(mailboxId).success) notFound();
  const auth = await requireMailboxAccess(mailboxId, "manage");
  const overview = await mailboxOverview(auth);
  const backHref = `/mail/${mailboxId}`;

  return (
    <>
      <header className="flex h-14 items-center gap-2 border-b px-4">
        <Button asChild variant="ghost" size="icon" aria-label="Back to mail">
          <Link href={backHref}>
            <ArrowLeft />
          </Link>
        </Button>
        <h1 className="text-sm font-semibold">Update mailbox password</h1>
      </header>
      <div className="mx-auto w-full max-w-md space-y-6 p-6">
        <div className="space-y-2 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">{overview.address}</p>
          <p>
            {overview.status === "NEEDS_REAUTH"
              ? "The mail server no longer accepts the saved password, so new mail can't be fetched or sent."
              : "Changed this mailbox's password in mPanel? Enter the new one so Matium Mail stays connected."}
          </p>
          <p>Your Matium Mail password, if you set one, stays the same and works again once this is saved.</p>
        </div>
        <ReconnectForm action={reconnectAction.bind(null, mailboxId)} address={overview.address} backHref={backHref} />
      </div>
    </>
  );
}
