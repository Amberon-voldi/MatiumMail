import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeft, ImageOff, Paperclip, PenSquare, Star } from "lucide-react";
import { z } from "zod";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { requireMailboxAccess, type AuthorizedMailbox } from "@/server/auth/dal";
import { listFolders, listMessages, mailboxOverview, openMessage } from "@/server/mail/messages";
import { AutoSync, EmailFrame, MarkSeen, MessageActions, SyncButton } from "./mail-client";

export const metadata: Metadata = { title: "Mail" };

const dateFmt = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const shortFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

export default function MailPage(props: PageProps<"/mail/[mailboxId]">) {
  return (
    <div className="flex h-dvh overflow-hidden">
      <Suspense fallback={<div className="m-auto text-sm text-muted-foreground">Loading mailbox…</div>}>
        <Mail params={props.params} searchParams={props.searchParams} />
      </Suspense>
    </div>
  );
}

async function Mail({ params, searchParams }: Pick<PageProps<"/mail/[mailboxId]">, "params" | "searchParams">) {
  const { mailboxId } = await params;
  if (!z.uuid().safeParse(mailboxId).success) notFound();
  const sp = await searchParams;
  const pick = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);

  const auth = await requireMailboxAccess(mailboxId, "read");
  // When the folder is in the URL, load its messages in parallel with the rest
  // (listMessages is scoped to this mailbox, so a foreign id just returns []).
  const requested = pick("folder");
  const requestedOk = requested && z.uuid().safeParse(requested).success ? requested : undefined;
  const q = pick("q")?.slice(0, 100) ?? "";
  const [overview, folders, early] = await Promise.all([
    mailboxOverview(auth),
    listFolders(auth),
    requestedOk ? listMessages(auth, requestedOk, { q }) : Promise.resolve(null),
  ]);
  const folder = folders.find((f) => f.id === requestedOk) ?? folders.find((f) => f.specialUse === "INBOX") ?? folders[0];
  const { messages } =
    early && folder?.id === requestedOk ? early : folder ? await listMessages(auth, folder.id, { q }) : { messages: [] };
  const selectedId = pick("message");
  const base = `/mail/${mailboxId}?folder=${folder?.id ?? ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`;

  return (
    <>
      {/* Folders */}
      <aside className="hidden w-56 shrink-0 flex-col border-r bg-muted/30 md:flex">
        <Link href="/" className="flex h-14 items-center gap-2.5 px-4">
          <Logo className="size-7 rounded-lg [&_svg]:size-4" />
          <span className="text-sm font-semibold tracking-tight">Matium Mail</span>
        </Link>
        <div className="px-3 pb-3">
          <Button asChild className="w-full justify-start gap-2" size="sm">
            <Link href={`/mail/${mailboxId}/compose`}>
              <PenSquare className="size-4" /> Compose
            </Link>
          </Button>
        </div>
        <nav aria-label="Folders" className="flex-1 overflow-y-auto px-2">
          {folders.map((f) => (
            <Link
              key={f.id}
              href={`/mail/${mailboxId}?folder=${f.id}`}
              prefetch={false}
              className={cn(
                "flex items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-muted",
                f.id === folder?.id && "bg-muted font-medium",
              )}
            >
              <span className="truncate">{f.specialUse === "INBOX" ? "Inbox" : f.name}</span>
              {f.unreadCount > 0 ? <span className="text-xs tabular-nums text-muted-foreground">{f.unreadCount}</span> : null}
            </Link>
          ))}
        </nav>
        <p className="truncate px-4 py-3 text-xs text-muted-foreground" title={overview.address}>
          {overview.address}
        </p>
      </aside>

      {/* Message list */}
      <section className={cn("flex w-full min-w-0 flex-col border-r md:w-96", selectedId && "hidden md:flex")}>
        <header className="flex h-14 items-center justify-between border-b px-4">
          <h1 className="truncate text-sm font-semibold">{folder ? (folder.specialUse === "INBOX" ? "Inbox" : folder.name) : "Mail"}</h1>
          <SyncButton mailboxId={mailboxId} />
        </header>
        <AutoSync
          key={folder?.id ?? "none"}
          mailboxId={mailboxId}
          folderId={folder?.id}
          lastSyncAt={folder?.lastSyncedAt?.toISOString() ?? null}
          initial={folders.length === 0}
        />
        {overview.status === "NEEDS_REAUTH" ? (
          <p className="border-b bg-destructive/5 px-4 py-2 text-xs text-destructive">
            The mail server rejected the saved password (was it changed in mPanel?).{" "}
            {auth.role === "OWNER" ? (
              <Link href={`/mail/${mailboxId}/reconnect`} className="font-medium underline underline-offset-2">
                Enter the new password
              </Link>
            ) : (
              "Ask the mailbox owner to reconnect it."
            )}
          </p>
        ) : null}
        <form action={`/mail/${mailboxId}`} className="border-b px-3 py-2" role="search">
          <input type="hidden" name="folder" value={folder?.id ?? ""} />
          <Input
            name="q"
            type="search"
            defaultValue={q}
            placeholder={`Search ${folder ? (folder.specialUse === "INBOX" ? "Inbox" : folder.name) : "mail"}…`}
            aria-label="Search messages in this folder"
            className="h-8"
          />
        </form>
        <ul className="flex-1 divide-y overflow-y-auto">
          {folders.length === 0 ? (
            <li className="p-6 text-center text-sm text-muted-foreground">Setting up your mailbox…</li>
          ) : messages.length === 0 ? (
            <li className="p-6 text-center text-sm text-muted-foreground">{q ? `No messages match “${q}”.` : "No messages here."}</li>
          ) : (
            messages.map((m) => (
              <li key={m.id}>
                <Link
                  href={`${base}&message=${m.id}`}
                  prefetch={false}
                  className={cn("block px-4 py-3 hover:bg-muted/60", m.id === selectedId && "bg-muted")}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className={cn("truncate text-sm", !m.isSeen ? "font-semibold" : "text-muted-foreground")}>
                      {m.fromName || m.fromAddress || "(unknown sender)"}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{shortFmt.format(m.internalDate)}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5">
                    {m.isFlagged ? <Star className="size-3 shrink-0 fill-amber-400 text-amber-500" aria-label="Starred" /> : null}
                    {m.hasAttachments ? <Paperclip className="size-3 shrink-0 text-muted-foreground" aria-label="Has attachments" /> : null}
                    <span className={cn("truncate text-sm", !m.isSeen && "font-medium")}>{m.subject || "(no subject)"}</span>
                  </div>
                  {m.preview ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{m.preview}</p> : null}
                </Link>
              </li>
            ))
          )}
        </ul>
      </section>

      {/* Reader */}
      <section className={cn("min-w-0 flex-1 flex-col", selectedId ? "flex" : "hidden md:flex")}>
        {selectedId && z.uuid().safeParse(selectedId).success ? (
          <Suspense key={selectedId} fallback={<div className="m-auto text-sm text-muted-foreground">Opening message…</div>}>
            <Reader auth={auth} messageId={selectedId} backHref={base} allowImages={pick("images") === "1"} />
          </Suspense>
        ) : (
          <div className="m-auto text-sm text-muted-foreground">Select a message to read it.</div>
        )}
      </section>
    </>
  );
}

async function Reader({
  auth,
  messageId,
  backHref,
  allowImages,
}: {
  auth: AuthorizedMailbox;
  messageId: string;
  backHref: string;
  allowImages: boolean;
}) {
  let msg;
  try {
    msg = await openMessage(auth, messageId, { allowRemoteImages: allowImages });
  } catch (err) {
    return (
      <div className="m-auto max-w-sm p-6 text-center text-sm text-muted-foreground">
        {err instanceof Error ? err.message : "This message couldn't be opened."}
      </div>
    );
  }
  return (
    <>
      <MarkSeen mailboxId={auth.mailboxId} messageId={msg.id} isSeen={msg.isSeen} />
      <header className="flex h-14 items-center justify-between gap-2 border-b px-4">
        <Button asChild variant="ghost" size="icon" className="md:hidden" aria-label="Back to list">
          <Link href={backHref}>
            <ArrowLeft />
          </Link>
        </Button>
        <div className="flex-1" />
        <Button asChild variant="outline" size="sm">
          <Link href={`/mail/${auth.mailboxId}/compose?reply=${msg.id}`}>Reply</Link>
        </Button>
        <MessageActions mailboxId={auth.mailboxId} messageId={msg.id} isFlagged={msg.isFlagged} backHref={backHref} />
      </header>
      <div className="space-y-1 border-b px-6 py-4">
        <h2 className="text-lg font-semibold tracking-tight">{msg.subject}</h2>
        <p className="text-sm">{msg.from}</p>
        <p className="text-xs text-muted-foreground">
          To {msg.to}
          {msg.cc ? ` · Cc ${msg.cc}` : ""}
          {msg.date ? ` · ${dateFmt.format(new Date(msg.date))}` : ""}
        </p>
        {msg.attachments.length ? (
          <p className="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted-foreground">
            <Paperclip className="size-3" aria-hidden="true" />
            {msg.attachments.map((a, i) => (
              <span key={i} className="rounded border px-1.5 py-0.5">
                {a.filename} · {Math.max(1, Math.round(a.size / 1024))} KB
              </span>
            ))}
          </p>
        ) : null}
        {msg.hasBlockedImages && !allowImages ? (
          <p className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
            <ImageOff className="size-3.5" aria-hidden="true" />
            Remote images are hidden to protect your privacy.
            <Link className="underline underline-offset-2" href={`${backHref}&message=${msg.id}&images=1`} prefetch={false}>
              Show images
            </Link>
          </p>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 p-4">
        <EmailFrame srcDoc={msg.document} title={msg.subject} />
      </div>
    </>
  );
}
