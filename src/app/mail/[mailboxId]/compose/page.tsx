import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeft } from "lucide-react";
import { z } from "zod";
import { sendAction } from "@/app/actions/mail";
import { Button } from "@/components/ui/button";
import { requireMailboxAccess } from "@/server/auth/dal";
import { mailboxOverview, replyContext } from "@/server/mail/messages";
import { ComposeForm } from "./compose-form";

export const metadata: Metadata = { title: "New message" };

export default function ComposePage(props: PageProps<"/mail/[mailboxId]/compose">) {
  return (
    <div className="flex min-h-dvh flex-col">
      <Suspense fallback={<div className="m-auto text-sm text-muted-foreground">Loading…</div>}>
        <Compose params={props.params} searchParams={props.searchParams} />
      </Suspense>
    </div>
  );
}

async function Compose({ params, searchParams }: Pick<PageProps<"/mail/[mailboxId]/compose">, "params" | "searchParams">) {
  const { mailboxId } = await params;
  if (!z.uuid().safeParse(mailboxId).success) notFound();
  const sp = await searchParams;
  const auth = await requireMailboxAccess(mailboxId, "send");
  const overview = await mailboxOverview(auth);
  const replyId = typeof sp.reply === "string" && z.uuid().safeParse(sp.reply).success ? sp.reply : null;
  const defaults = replyId ? ((await replyContext(auth, replyId)) ?? {}) : {};
  const backHref = `/mail/${mailboxId}`;

  return (
    <>
      <header className="flex h-14 items-center gap-2 border-b px-4">
        <Button asChild variant="ghost" size="icon" aria-label="Back to mail">
          <Link href={backHref}>
            <ArrowLeft />
          </Link>
        </Button>
        <h1 className="text-sm font-semibold">{replyId ? "Reply" : "New message"}</h1>
      </header>
      <ComposeForm
        action={sendAction.bind(null, mailboxId)}
        from={overview.displayName ? `${overview.displayName} <${overview.address}>` : overview.address}
        defaults={defaults}
        backHref={backHref}
      />
    </>
  );
}
