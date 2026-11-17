"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  CornerUpLeft,
  CornerUpRight,
  Forward,
  ImageOff,
  Mail,
  MailMinus,
  MoreVertical,
  OctagonAlert,
  Pencil,
  ReplyAll,
  ShieldCheck,
  Star,
  Trash2,
} from "lucide-react";
import type { ThreadMessageDTO } from "@/lib/mail-types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { displayName, formatAddress, fullDate, listDate } from "../_lib/format";
import { useBody, useThread } from "../_lib/store";
import { AttachmentList } from "./attachments";
import { Avatar, EmptyState, IconButton, Spinner } from "./bits";
import { EmailFrame } from "./email-frame";
import { useMail, type MoveTarget } from "./mail-context";
import { MoveMenu } from "./thread-list";

const DISPOSABLE = new Set(["TRASH", "JUNK"]);

export function ThreadView({ messageId, onClose }: { messageId: string; onClose: () => void }) {
  const mail = useMail();
  const thread = useThread(mail.api, messageId);
  const data = thread.data;
  const role = mail.folder?.role ?? "NONE";

  // Default: the newest message, the ones that were unread when the conversation
  // opened (they stay open after being marked read) and the one clicked are expanded.
  const [toggled, setToggled] = useState<Set<string>>(() => new Set());
  const [unreadAtOpen, setUnreadAtOpen] = useState<Set<string> | null>(null);
  if (data && unreadAtOpen === null) setUnreadAtOpen(new Set(data.messages.filter((m) => !m.isSeen).map((m) => m.id)));
  const isExpanded = (m: ThreadMessageDTO, i: number, total: number) =>
    toggled.has(m.id) !== (i === total - 1 || Boolean(unreadAtOpen?.has(m.id)) || m.id === messageId);
  const toggle = (id: string) =>
    setToggled((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Opening a conversation marks it read.
  const unseen = useMemo(() => data?.messages.filter((m) => !m.isSeen).map((m) => m.id) ?? [], [data]);
  const { markSeen, can } = mail;
  useEffect(() => {
    if (unseen.length && can.organise) markSeen(unseen, true);
  }, [unseen, markSeen, can.organise]);

  if (!data) {
    return (
      <div className="flex h-full flex-col">
        <ReaderBar onClose={onClose} />
        {thread.error ? (
          <EmptyState icon={<OctagonAlert />} title="Couldn't open this conversation">
            <p>{thread.error}</p>
            <button className="mt-3 font-medium text-brand" onClick={thread.reload}>
              Try again
            </button>
          </EmptyState>
        ) : (
          <ReaderSkeleton />
        )}
      </div>
    );
  }

  const messages = data.messages;
  const folderId = mail.folder?.id;
  const inView = messages.filter((m) => m.folderId === folderId).map((m) => m.id);
  const actionIds = inView.length
    ? inView
    : messages.filter((m) => m.folderRole !== "SENT" && m.folderRole !== "DRAFTS").map((m) => m.id);
  const ids = actionIds.length ? actionIds : [messageId];
  const keys = [data.key, ...ids.map((id) => `m:${id}`)];
  const flagged = messages.some((m) => m.isFlagged);
  const latest = [...messages].reverse().find((m) => !m.isDraft) ?? messages[messages.length - 1];
  const multipleRecipients = latest ? latest.to.length + latest.cc.length > 1 : false;
  const doMove = (target: MoveTarget) => void mail.move(ids, target, keys);
  const disposable = DISPOSABLE.has(role);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ReaderBar onClose={onClose}>
        {mail.can.organise ? (
          <>
            {role === "JUNK" ? (
              <IconButton label="Not spam" onClick={() => doMove("inbox")}>
                <ShieldCheck />
              </IconButton>
            ) : role === "ARCHIVE" || role === "TRASH" ? (
              <IconButton label="Move to Inbox" onClick={() => doMove("inbox")}>
                <ArchiveRestore />
              </IconButton>
            ) : (
              <IconButton label="Archive (e)" onClick={() => doMove("archive")}>
                <Archive />
              </IconButton>
            )}
            <IconButton label={disposable ? "Delete forever" : "Delete (#)"} onClick={() => doMove(disposable ? "delete" : "trash")}>
              <Trash2 />
            </IconButton>
            <IconButton
              label="Mark as unread (Shift+U)"
              onClick={() => {
                mail.markSeen(ids, false);
                onClose();
              }}
            >
              <Mail />
            </IconButton>
            <MoveMenu onMove={doMove} spam={role !== "JUNK"} />
            <IconButton label={flagged ? "Unstar (s)" : "Star (s)"} onClick={() => mail.setStar(ids, !flagged)}>
              <Star className={cn(flagged && "fill-amber-400 text-amber-500")} />
            </IconButton>
          </>
        ) : null}
      </ReaderBar>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
        <div className="mx-auto w-full max-w-4xl px-3 pt-4 pb-28 md:px-6 md:pt-6 md:pb-10">
          <h2 className="px-1 text-xl leading-snug font-semibold tracking-tight text-balance md:text-[22px]">
            {data.subject || "(no subject)"}
            {messages.length > 1 ? (
              <span className="ml-2 align-middle text-sm font-medium text-muted-foreground tabular-nums">{messages.length}</span>
            ) : null}
          </h2>

          <ol className="mt-4 space-y-2.5">
            {messages.map((m, i) => (
              <li key={m.id}>
                <MessageCard message={m} expanded={isExpanded(m, i, messages.length)} onToggle={() => toggle(m.id)} />
              </li>
            ))}
          </ol>

          {mail.can.send && latest ? (
            <div className="mt-5 hidden flex-wrap gap-2 md:flex">
              <Button variant="outline" className="h-9 gap-2 rounded-full px-4" onClick={() => mail.openComposer({ mode: "reply", sourceId: latest.id })}>
                <CornerUpLeft className="size-4" /> Reply
              </Button>
              {multipleRecipients ? (
                <Button
                  variant="outline"
                  className="h-9 gap-2 rounded-full px-4"
                  onClick={() => mail.openComposer({ mode: "replyAll", sourceId: latest.id })}
                >
                  <ReplyAll className="size-4" /> Reply all
                </Button>
              ) : null}
              <Button variant="outline" className="h-9 gap-2 rounded-full px-4" onClick={() => mail.openComposer({ mode: "forward", sourceId: latest.id })}>
                <Forward className="size-4" /> Forward
              </Button>
            </div>
          ) : null}
        </div>
      </div>

      {/* Phone: thumb-reachable reply bar */}
      {mail.can.send && latest ? (
        <div className="pb-safe shrink-0 border-t bg-background/95 backdrop-blur md:hidden">
          <div className="flex gap-2 p-2">
            <Button variant="secondary" className="h-11 flex-1 gap-2 rounded-full" onClick={() => mail.openComposer({ mode: "reply", sourceId: latest.id })}>
              <CornerUpLeft className="size-4" /> Reply
            </Button>
            {multipleRecipients ? (
              <Button
                variant="secondary"
                className="h-11 flex-1 gap-2 rounded-full"
                onClick={() => mail.openComposer({ mode: "replyAll", sourceId: latest.id })}
              >
                <ReplyAll className="size-4" /> All
              </Button>
            ) : null}
            <Button variant="secondary" className="h-11 flex-1 gap-2 rounded-full" onClick={() => mail.openComposer({ mode: "forward", sourceId: latest.id })}>
              <CornerUpRight className="size-4" /> Forward
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ReaderBar({ onClose, children }: { onClose: () => void; children?: ReactNode }) {
  return (
    <header className="pt-safe shrink-0 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="flex h-14 items-center gap-0.5 px-2 md:px-3">
        <IconButton label="Back to list (u)" onClick={onClose}>
          <ArrowLeft />
        </IconButton>
        <div className="flex-1" />
        {children}
      </div>
    </header>
  );
}

function ReaderSkeleton() {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 px-4 py-6 md:px-6" aria-hidden="true">
      <div className="h-6 w-2/3 animate-pulse rounded bg-muted" />
      <div className="rounded-2xl border p-4">
        <div className="flex gap-3">
          <div className="size-10 animate-pulse rounded-full bg-muted" />
          <div className="flex-1 space-y-2 pt-1">
            <div className="h-3.5 w-40 animate-pulse rounded bg-muted" />
            <div className="h-3 w-24 animate-pulse rounded bg-muted" />
          </div>
        </div>
        <div className="mt-6 space-y-2.5">
          <div className="h-3 w-full animate-pulse rounded bg-muted" />
          <div className="h-3 w-11/12 animate-pulse rounded bg-muted" />
          <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
        </div>
      </div>
    </div>
  );
}

// ── One message in a conversation ───────────────────────────────────────────

function MessageCard({ message: m, expanded, onToggle }: { message: ThreadMessageDTO; expanded: boolean; onToggle: () => void }) {
  if (!expanded) {
    return (
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 rounded-2xl border bg-card px-3 py-3 text-left transition-colors hover:bg-muted/40 md:px-4"
      >
        <Avatar addr={m.from} className="size-8 text-xs" />
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-sm", !m.isSeen && "font-semibold")}>
            {displayName(m.from)}
            {m.isDraft ? <span className="ml-2 text-xs font-semibold text-destructive">Draft</span> : null}
          </span>
          <span className="block truncate text-[13px] text-muted-foreground">{m.preview || " "}</span>
        </span>
        <time dateTime={m.date} suppressHydrationWarning className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {listDate(m.date)}
        </time>
      </button>
    );
  }
  return <ExpandedMessage message={m} onCollapse={onToggle} />;
}

function ExpandedMessage({ message: m, onCollapse }: { message: ThreadMessageDTO; onCollapse: () => void }) {
  const mail = useMail();
  const prefImages = mail.prefs.remoteImages === "ask" ? "block" : "proxy";
  const [showImages, setShowImages] = useState(false);
  const images = showImages ? "proxy" : prefImages;
  const body = useBody(mail.api, m.id, images);
  const [details, setDetails] = useState(false);
  const recipients = [...m.to, ...m.cc];
  const me = mail.mailbox.address.toLowerCase();
  const toSummary = recipients.length
    ? recipients
        .slice(0, 3)
        .map((a) => (a.address?.toLowerCase() === me ? "me" : displayName(a)))
        .join(", ") + (recipients.length > 3 ? ` +${recipients.length - 3}` : "")
    : "undisclosed recipients";
  const b = body.data;
  const unsubscribe = b?.unsubscribe ?? null;

  return (
    <article className="overflow-hidden rounded-2xl border bg-card shadow-[0_1px_2px_rgb(0_0_0/0.03)]">
      <header className="flex items-start gap-3 px-3 pt-3.5 md:px-4">
        <button type="button" onClick={onCollapse} aria-label="Collapse message" className="rounded-full">
          <Avatar addr={m.from} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <p className="min-w-0 flex-1 truncate text-sm">
              <span className="font-semibold">{displayName(m.from)}</span>
              {m.from.address && m.from.name ? (
                <span className="ml-1.5 hidden text-xs text-muted-foreground sm:inline">&lt;{m.from.address}&gt;</span>
              ) : null}
            </p>
            <time
              dateTime={m.date}
              suppressHydrationWarning
              className="shrink-0 text-xs text-muted-foreground tabular-nums"
              title={fullDate(m.date)}
            >
              {listDate(m.date)}
            </time>
          </div>
          <button
            type="button"
            onClick={() => setDetails((d) => !d)}
            className="mt-0.5 inline-flex max-w-full items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"
            aria-expanded={details}
          >
            <span className="truncate">to {toSummary}</span>
            {details ? <ChevronUp className="size-3.5 shrink-0" /> : <ChevronDown className="size-3.5 shrink-0" />}
          </button>
          {details ? (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-muted/50 p-2.5 text-xs">
              <dt className="text-muted-foreground">From</dt>
              <dd className="break-all">{formatAddress(m.from)}</dd>
              {m.to.length ? (
                <>
                  <dt className="text-muted-foreground">To</dt>
                  <dd className="break-all">{m.to.map(formatAddress).join(", ")}</dd>
                </>
              ) : null}
              {m.cc.length ? (
                <>
                  <dt className="text-muted-foreground">Cc</dt>
                  <dd className="break-all">{m.cc.map(formatAddress).join(", ")}</dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">Date</dt>
              <dd>{fullDate(b?.date ?? m.date)}</dd>
              <dt className="text-muted-foreground">Folder</dt>
              <dd>{m.folderName}</dd>
            </dl>
          ) : null}
        </div>
        <div className="-mt-1 -mr-1 flex shrink-0 items-center">
          {m.isDraft && mail.can.send ? (
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => mail.openComposer({ mode: "draft", sourceId: m.id })}>
              <Pencil className="size-3.5" /> Edit draft
            </Button>
          ) : mail.can.send ? (
            <IconButton label="Reply" className="hidden sm:inline-flex" onClick={() => mail.openComposer({ mode: "reply", sourceId: m.id })}>
              <CornerUpLeft />
            </IconButton>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label="More">
                <MoreVertical />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {mail.can.send ? (
                <>
                  <DropdownMenuItem onSelect={() => mail.openComposer({ mode: "reply", sourceId: m.id })}>
                    <CornerUpLeft /> Reply
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => mail.openComposer({ mode: "replyAll", sourceId: m.id })}>
                    <ReplyAll /> Reply all
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => mail.openComposer({ mode: "forward", sourceId: m.id })}>
                    <Forward /> Forward
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              ) : null}
              {mail.can.organise ? (
                <>
                  <DropdownMenuItem onSelect={() => mail.markSeen([m.id], false)}>
                    <Mail /> Mark as unread
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => mail.setStar([m.id], !m.isFlagged)}>
                    <Star /> {m.isFlagged ? "Unstar" : "Star"} this message
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => void mail.move([m.id], DISPOSABLE.has(m.folderRole) ? "delete" : "trash", [`m:${m.id}`])}
                  >
                    <Trash2 /> Delete this message
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="px-3 pt-3 pb-4 md:px-4">
        {b?.remoteImages === "blocked" ? (
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            <ImageOff className="size-4 shrink-0" aria-hidden="true" />
            <span className="flex-1">Images are hidden to protect your privacy.</span>
            <button className="font-medium text-brand hover:underline" onClick={() => setShowImages(true)}>
              Show images
            </button>
          </div>
        ) : null}

        {b ? (
          <div className="overflow-hidden rounded-xl ring-1 ring-black/5 dark:ring-white/10">
            <EmailFrame
              html={b.document}
              title={`Message from ${displayName(m.from)}`}
              onMailto={mail.can.send ? (to) => mail.openComposer({ mode: "new", to: [to] }) : undefined}
            />
          </div>
        ) : body.error ? (
          <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            <p>{body.error}</p>
            <button className="mt-2 font-medium text-brand" onClick={body.reload}>
              Try again
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Spinner /> Loading message…
          </div>
        )}

        {b ? <AttachmentList messageId={m.id} attachments={b.attachments} /> : null}

        {unsubscribe ? (
          <p className="mt-3 text-xs text-muted-foreground">
            <MailMinus className="mr-1 inline size-3.5 align-[-2px]" aria-hidden="true" />
            Mailing list.{" "}
            {unsubscribe.url ? (
              <a href={unsubscribe.url} target="_blank" rel="noopener noreferrer" className="font-medium text-brand hover:underline">
                Unsubscribe
              </a>
            ) : unsubscribe.mailto && mail.can.send ? (
              <button
                className="font-medium text-brand hover:underline"
                onClick={() => mail.openComposer({ mode: "new", to: [unsubscribe.mailto!.split("?")[0]], subject: "Unsubscribe" })}
              >
                Unsubscribe
              </button>
            ) : null}
          </p>
        ) : null}
      </div>
    </article>
  );
}
