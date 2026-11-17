import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";
import { listMailboxesForUser, requireMailboxAccess, requireUsers } from "@/server/auth/dal";
import { listFolders, listThreads, mailboxOverview } from "@/server/mail/messages";
import { getPreferences } from "@/server/preferences";
import { MailApp } from "./_components/mail-app";

export const metadata: Metadata = { title: "Mail" };

/**
 * The mail app. The server renders the first screen (folders + the first page
 * of the folder in the URL); after that the app runs in the browser and talks
 * to /api/mail/<mailboxId>/… (see src/app/api/mail).
 */
export default function MailPage(props: PageProps<"/mail/[mailboxId]">) {
  return (
    <Suspense fallback={<MailSkeleton />}>
      <Mail params={props.params} searchParams={props.searchParams} />
    </Suspense>
  );
}

async function Mail({ params, searchParams }: Pick<PageProps<"/mail/[mailboxId]">, "params" | "searchParams">) {
  const { mailboxId } = await params;
  if (!z.uuid().safeParse(mailboxId).success) notFound();
  const auth = await requireMailboxAccess(mailboxId, "read");
  const sp = await searchParams;
  const pick = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);

  const users = await requireUsers();
  const [overview, folders, preferences, grants] = await Promise.all([
    mailboxOverview(auth),
    listFolders(auth),
    getPreferences(auth.userId),
    Promise.all(users.map((u) => listMailboxesForUser(u.id))),
  ]);
  const mailboxes = [...new Map(grants.flat().map((m) => [m.id, m])).values()].map((m) => ({
    id: m.id,
    address: m.address,
    displayName: m.displayName,
    status: m.status,
  }));

  const requested = pick("folder");
  const folder = folders.find((f) => f.id === requested) ?? folders.find((f) => f.role === "INBOX") ?? folders[0] ?? null;
  const q = (pick("q") ?? "").slice(0, 100);
  const all = pick("all") === "1";
  const everywhere = Boolean(q) && all;
  const page =
    folder || everywhere
      ? await listThreads(auth, {
          folderId: everywhere ? undefined : folder?.id,
          q,
          allFolders: all,
          conversations: preferences.conversationView,
        })
      : null;

  return (
    <MailApp
      mailbox={{
        id: overview.id,
        address: overview.address,
        displayName: overview.displayName,
        status: overview.status,
        role: auth.role,
      }}
      folders={folders}
      preferences={preferences}
      mailboxes={mailboxes}
      accounts={users.map((u) => ({ id: u.id, email: u.email, displayName: u.displayName }))}
      initial={{ folderId: folder?.id ?? null, q, all, page }}
    />
  );
}

/** First paint while the session and mailbox load: the app's frame, in shimmer. */
function MailSkeleton() {
  return (
    <div className="flex h-dvh overflow-hidden" aria-busy="true" aria-label="Loading mail">
      <div className="hidden w-64 shrink-0 flex-col gap-2 border-r bg-sidebar p-4 md:flex xl:w-72">
        <div className="h-8 w-36 animate-pulse rounded-lg bg-muted" />
        <div className="mt-3 h-10 animate-pulse rounded-2xl bg-muted" />
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-8 animate-pulse rounded-lg bg-muted/70" />
        ))}
      </div>
      <div className="flex w-full flex-col border-r md:w-[360px] lg:w-[400px] xl:w-[440px]">
        <div className="h-14 border-b" />
        <div className="space-y-px">
          {Array.from({ length: 9 }, (_, i) => (
            <div key={i} className="flex gap-3 px-4 py-3.5">
              <div className="size-9 shrink-0 animate-pulse rounded-full bg-muted" />
              <div className="flex-1 space-y-2">
                <div className="h-3.5 w-1/3 animate-pulse rounded bg-muted" />
                <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="hidden flex-1 bg-muted/20 md:block" />
    </div>
  );
}
