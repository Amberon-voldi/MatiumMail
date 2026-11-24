"use client";

import { useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Check,
  FolderInput,
  Inbox,
  Loader2,
  Mail,
  MailOpen,
  Menu,
  OctagonAlert,
  Paperclip,
  RefreshCw,
  Search,
  SearchX,
  ShieldCheck,
  Star,
  Trash2,
  X,
} from "lucide-react";
import type { FolderDTO, ThreadSummaryDTO } from "@/lib/mail-types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { ThreadQuery } from "../_lib/api";
import { displayName, listDate } from "../_lib/format";
import { EMPTY_LIST, loadList, loadMore, lists, prefetchThread, prefetchTop, useStore, type ListState } from "../_lib/store";
import { Avatar, EmptyState, IconButton, ListSkeleton } from "./bits";
import { useMail, type MoveTarget } from "./mail-context";

const DISPOSABLE = new Set(["TRASH", "JUNK"]);

export function ThreadList({ listKey, query, initialState }: { listKey: string; query: ThreadQuery; initialState?: ListState | null }) {
  const mail = useMail();
  const { api, folder, nav, navigate } = mail;
  const state = useStore(lists, listKey, initialState ?? EMPTY_LIST);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [pull, setPull] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const searching = Boolean(nav.q);
  const role = folder?.role ?? "NONE";

  const refresh = () => mail.syncNow(folder?.id).then(() => loadList(api, listKey, query));
  const pullHandlers = usePullToRefresh(scrollRef, refresh, setPull);

  // First load / refresh when the list is shown and is stale.
  useEffect(() => {
    const s = lists.get(listKey);
    if (!s || Date.now() - s.fetchedAt > 20_000) void loadList(api, listKey, query);
  }, [api, listKey, query]);

  // On phones (no hover to prefetch on), load the newest few conversations in
  // the background once the list is in, so opening them is instant.
  const topIds = state.status === "ready" && !searching ? state.threads.slice(0, 5).map((t) => t.latestId).join(",") : "";
  const images = mail.prefs.remoteImages === "ask" ? "block" : "proxy";
  useEffect(() => {
    if (!topIds || !window.matchMedia("(hover: none)").matches) return;
    const run = () => void prefetchTop(api, topIds.split(","), images);
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(run, { timeout: 2_000 });
      return () => window.cancelIdleCallback(id);
    }
    const t = setTimeout(run, 500);
    return () => clearTimeout(t);
  }, [api, topIds, images]);

  // Infinite scroll (and fetching older mail from the server at the end).
  const canLoadMore = state.status === "ready" && (Boolean(state.nextCursor) || (state.olderOnServer && !searching));
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !canLoadMore) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore(api, listKey, query);
      },
      { root: scrollRef.current, rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [api, listKey, query, canLoadMore]);

  const threads = state.threads;
  const chosen = threads.filter((t) => selected.has(t.key));
  const toggle = (key: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const clear = () => setSelected(new Set());

  const bulkMove = (target: MoveTarget) => {
    const ids = chosen.flatMap((t) => t.ids);
    const keys = chosen.map((t) => t.key);
    clear();
    void mail.move(ids, target, keys);
  };

  const title = searching ? "Search" : (folder?.name ?? "Mail");
  const unread = folder && !searching ? folder.unread : 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="pt-safe shrink-0 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        {chosen.length > 0 ? (
          <BulkBar
            count={chosen.length}
            allSelected={chosen.length === threads.length}
            onSelectAll={() => setSelected(new Set(threads.map((t) => t.key)))}
            onClear={clear}
            role={role}
            anyUnread={chosen.some((t) => t.unread)}
            anyUnstarred={chosen.some((t) => !t.flagged)}
            onSeen={(seen) => {
              mail.markSeen(chosen.flatMap((t) => t.ids), seen);
              clear();
            }}
            onStar={(flagged) => {
              mail.setStar(chosen.flatMap((t) => t.ids), flagged);
              clear();
            }}
            onMove={bulkMove}
          />
        ) : (
          <div className="flex h-14 items-center gap-1 px-2 md:px-3">
            {searching ? (
              <IconButton label="Back to folder" onClick={() => navigate({ q: "", all: false, threadId: null })}>
                <ArrowLeft />
              </IconButton>
            ) : (
              <IconButton label="Open folders" className="md:hidden" onClick={mail.openSidebar}>
                <Menu />
              </IconButton>
            )}
            <h1 className="min-w-0 flex-1 truncate px-1 text-base font-semibold tracking-tight">
              {title}
              {unread > 0 ? (
                <span key={unread} className="ml-2 inline-block text-sm font-medium text-brand tabular-nums duration-300 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-75">
                  {unread}
                </span>
              ) : null}
            </h1>
            {folder && DISPOSABLE.has(role) && !searching && threads.length > 0 && mail.can.organise ? (
              <EmptyFolderButton folder={folder} />
            ) : null}
            <IconButton label="Check for new mail" onClick={() => void refresh()} disabled={mail.syncing}>
              <RefreshCw className={cn(mail.syncing && "animate-spin")} />
            </IconButton>
          </div>
        )}
        <SearchBar />
      </header>

      <div ref={scrollRef} className="scrollbar-thin relative min-h-0 flex-1 overflow-y-auto overscroll-y-contain" {...pullHandlers}>
        <PullIndicator pull={pull} />
        {state.error && state.threads.length > 0 ? (
          <p role="status" className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-800 dark:text-amber-200">
            {state.error}{" "}
            <button className="font-medium underline underline-offset-2" onClick={() => void loadList(api, listKey, query)}>
              Retry
            </button>
          </p>
        ) : null}

        {state.status === "loading" && threads.length === 0 ? (
          <ListSkeleton />
        ) : state.status === "error" ? (
          <EmptyState icon={<OctagonAlert />} title="Couldn't load your mail">
            <p>{state.error}</p>
            <button
              className="mt-3 inline-flex h-9 items-center rounded-lg border px-3 text-sm font-medium text-foreground hover:bg-muted"
              onClick={() => void loadList(api, listKey, query)}
            >
              Try again
            </button>
          </EmptyState>
        ) : threads.length === 0 ? (
          searching ? (
            <EmptyState icon={<SearchX />} title={`No results for “${nav.q}”`}>
              {nav.all ? "Try different words." : "Nothing in this folder matches."}
              {!nav.all ? (
                <button className="mt-3 block w-full font-medium text-brand" onClick={() => navigate({ all: true })}>
                  Search all folders
                </button>
              ) : null}
            </EmptyState>
          ) : (
            <EmptyState icon={role === "INBOX" ? <Inbox /> : <Mail />} title={role === "INBOX" ? "You're all caught up" : "Nothing here"}>
              {role === "INBOX" ? "New mail will show up here." : "This folder is empty."}
            </EmptyState>
          )
        ) : (
          <ul aria-label={title} className="divide-y divide-border/70">
            {threads.map((t, i) => (
              <ThreadRow
                key={t.key}
                index={i}
                thread={t}
                active={nav.threadId !== null && t.ids.includes(nav.threadId)}
                selected={selected.has(t.key)}
                selecting={selected.size > 0}
                onToggle={() => toggle(t.key)}
                role={role}
                showFolder={searching && nav.all}
              />
            ))}
          </ul>
        )}

        <div ref={sentinelRef} className="h-px" aria-hidden="true" />
        {state.loadingMore ? (
          <div className="flex items-center justify-center gap-2 py-5 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {state.nextCursor ? "Loading more…" : "Fetching older mail from the server…"}
          </div>
        ) : canLoadMore ? (
          <button
            className="block w-full py-5 text-center text-xs font-medium text-muted-foreground hover:text-foreground"
            onClick={() => void loadMore(api, listKey, query)}
          >
            Load more
          </button>
        ) : threads.length > 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground/70">
            {searching ? "End of results" : "That's everything in this folder"}
          </p>
        ) : null}
        <div className="h-24 md:hidden" aria-hidden="true" />
      </div>
    </div>
  );
}

// ── Search ──────────────────────────────────────────────────────────────────

function SearchBar() {
  const { nav, navigate, folder } = useMail();
  const [value, setValue] = useState(nav.q);
  const [prevQ, setPrevQ] = useState(nav.q);
  if (nav.q !== prevQ) {
    // The URL changed (back button, cleared search): follow it.
    setPrevQ(nav.q);
    setValue(nav.q);
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = value.trim();
    navigate({ q: q.length >= 2 ? q : "", threadId: null });
  };
  return (
    <div className="px-3 pb-2.5">
      <form role="search" onSubmit={submit} className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <input
          id="mail-search"
          type="search"
          inputMode="search"
          enterKeyHint="search"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={nav.all || !folder ? "Search all mail" : `Search ${folder.name}`}
          aria-label="Search mail"
          className="h-10 w-full rounded-full border-0 bg-muted/70 pr-9 pl-9 text-[15px] outline-none placeholder:text-muted-foreground focus:bg-background focus:ring-2 focus:ring-brand/40 md:h-9 md:text-sm [&::-webkit-search-cancel-button]:hidden"
        />
        {value ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              setValue("");
              if (nav.q) navigate({ q: "", all: false });
            }}
            className="absolute top-1/2 right-2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </form>
      {nav.q ? (
        <div className="mt-2 flex gap-1.5 text-xs" role="radiogroup" aria-label="Search scope">
          {[
            { all: false, label: folder ? `In ${folder.name}` : "This folder" },
            { all: true, label: "All folders" },
          ].map((o) => (
            <button
              key={String(o.all)}
              role="radio"
              aria-checked={nav.all === o.all}
              onClick={() => navigate({ all: o.all, threadId: null })}
              className={cn(
                "rounded-full border px-2.5 py-1 font-medium transition-colors",
                nav.all === o.all ? "border-brand/40 bg-brand-soft text-brand" : "text-muted-foreground hover:bg-muted",
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── Rows ────────────────────────────────────────────────────────────────────

function ThreadRow({
  thread: t,
  active,
  selected,
  selecting,
  onToggle,
  role,
  showFolder,
  index,
}: {
  thread: ThreadSummaryDTO;
  index: number;
  active: boolean;
  selected: boolean;
  selecting: boolean;
  onToggle: () => void;
  role: string;
  showFolder: boolean;
}) {
  const mail = useMail();
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const outgoing = role === "SENT" || role === "DRAFTS";
  const disposable = DISPOSABLE.has(role);
  const swipe = useSwipe({
    onLeft: () => void mail.move(t.ids, disposable ? "delete" : "archive", [t.key]),
    onRight: () => mail.markSeen(t.ids, t.unread),
    leftLabel: disposable ? "Delete" : "Archive",
    rightLabel: t.unread ? "Mark read" : "Mark unread",
    enabled: mail.can.organise,
  });
  const folderName = showFolder ? mail.folders.find((f) => f.id === t.folderId)?.name : null;

  const open = () => {
    if (selecting) return onToggle();
    if (t.draft || role === "DRAFTS") return mail.openComposer({ mode: "draft", sourceId: t.latestId });
    mail.navigate({ threadId: t.latestId });
  };

  return (
    <li
      className="grid transition-[grid-template-rows,opacity] duration-200 ease-out"
      style={
        {
          gridTemplateRows: t.leaving ? "0fr" : "1fr",
          opacity: t.leaving ? 0 : 1,
          pointerEvents: t.leaving ? "none" : undefined,
          "--i": index < 14 ? index : 0,
        } as React.CSSProperties
      }
    >
      <div className="relative min-h-0 overflow-hidden motion-safe:animate-fade-up" {...swipe.containerProps}>
      {swipe.background}
      <div
        role="button"
        tabIndex={0}
        aria-current={active ? "true" : undefined}
        aria-label={`${t.unread ? "Unread. " : ""}${t.participants.join(", ")}: ${t.subject ?? "(no subject)"}`}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open();
          }
        }}
        onPointerEnter={(e) => {
          if (e.pointerType !== "mouse") return;
          clearTimeout(hoverTimer.current);
          hoverTimer.current = setTimeout(
            () => void prefetchThread(mail.api, t.latestId, mail.prefs.remoteImages === "ask" ? "block" : "proxy"),
            120,
          );
        }}
        onPointerLeave={() => clearTimeout(hoverTimer.current)}
        onPointerDown={(e) => {
          // A finger resting on a row: start loading it before the tap ends.
          // Scrolling cancels the pointer, and with it the prefetch.
          if (e.pointerType === "mouse") return;
          clearTimeout(hoverTimer.current);
          hoverTimer.current = setTimeout(
            () => void prefetchThread(mail.api, t.latestId, mail.prefs.remoteImages === "ask" ? "block" : "proxy"),
            60,
          );
        }}
        onPointerCancel={() => clearTimeout(hoverTimer.current)}
        style={swipe.style}
        className={cn(
          "group relative flex cursor-pointer gap-3 bg-background px-3 py-3 outline-none select-none focus-visible:bg-muted/70 md:px-4",
          "transition-colors hover:bg-muted/50",
          active && "bg-brand-soft/70 hover:bg-brand-soft",
          selected && "bg-brand-soft hover:bg-brand-soft",
        )}
      >
        {t.unread ? (
          <span className="absolute top-1/2 left-1 size-1.5 -translate-y-1/2 rounded-full bg-brand md:left-1.5" aria-hidden="true" />
        ) : null}
        <button
          type="button"
          aria-label={selected ? "Deselect" : "Select"}
          aria-pressed={selected}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="relative mt-0.5 size-9 shrink-0 self-start rounded-full focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {selected ? (
            <span className="flex size-9 items-center justify-center rounded-full bg-brand text-brand-foreground">
              <Check className="size-4" />
            </span>
          ) : (
            <>
              <Avatar addr={t.from} className={cn(selecting && "opacity-60", "md:group-hover:opacity-0")} />
              <span className="absolute inset-0 hidden items-center justify-center rounded-full border-2 border-muted-foreground/40 bg-background md:group-hover:flex" />
            </>
          )}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className={cn("min-w-0 flex-1 truncate text-[15px] md:text-sm", t.unread ? "font-semibold" : "text-foreground/80")}>
              {outgoing ? <span className="font-normal text-muted-foreground">To: </span> : null}
              {t.participants.length ? t.participants.join(", ") : displayName(t.from)}
              {t.count > 1 ? <span className="ml-1.5 text-xs font-normal text-muted-foreground tabular-nums">{t.count}</span> : null}
            </span>
            <time
              dateTime={t.date}
              suppressHydrationWarning
              className={cn("shrink-0 text-xs tabular-nums", t.unread ? "font-semibold text-brand" : "text-muted-foreground")}
            >
              {listDate(t.date)}
            </time>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            {t.draft ? <span className="shrink-0 text-xs font-semibold text-destructive">Draft</span> : null}
            <span className={cn("min-w-0 flex-1 truncate text-sm", t.unread ? "font-medium" : "text-foreground/80")}>
              {t.subject || "(no subject)"}
            </span>
            {t.hasAttachments ? <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-label="Has attachments" /> : null}
            <StarButton thread={t} />
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">{t.preview || " "}</p>
            {folderName ? (
              <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">{folderName}</span>
            ) : null}
          </div>
        </div>

        {mail.can.organise ? (
          <div className="absolute top-1/2 right-3 hidden -translate-y-1/2 items-center gap-0.5 rounded-lg border bg-background/95 p-0.5 shadow-sm backdrop-blur md:group-hover:flex">
            <QuickAction label={t.unread ? "Mark as read" : "Mark as unread"} onClick={() => mail.markSeen(t.ids, t.unread)}>
              {t.unread ? <MailOpen /> : <Mail />}
            </QuickAction>
            {disposable ? null : (
              <QuickAction label="Archive" onClick={() => void mail.move(t.ids, "archive", [t.key])}>
                <Archive />
              </QuickAction>
            )}
            <QuickAction label={disposable ? "Delete forever" : "Delete"} onClick={() => void mail.move(t.ids, disposable ? "delete" : "trash", [t.key])}>
              <Trash2 />
            </QuickAction>
          </div>
        ) : null}
      </div>
      </div>
    </li>
  );
}

function QuickAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-4"
    >
      {children}
    </button>
  );
}

function StarButton({ thread: t }: { thread: ThreadSummaryDTO }) {
  const mail = useMail();
  if (!mail.can.organise) return t.flagged ? <Star className="size-4 shrink-0 fill-amber-400 text-amber-500" aria-label="Starred" /> : null;
  return (
    <button
      type="button"
      aria-label={t.flagged ? "Unstar" : "Star"}
      aria-pressed={t.flagged}
      onClick={(e) => {
        e.stopPropagation();
        mail.setStar(t.ids, !t.flagged);
      }}
      className={cn(
        "-my-1 -mr-1 inline-flex size-7 shrink-0 items-center justify-center rounded-full transition-[color,background-color,transform] duration-300 ease-[cubic-bezier(.34,1.56,.64,1)] hover:bg-muted active:scale-75",
        t.flagged ? "text-amber-500" : "text-muted-foreground/40 hover:text-muted-foreground",
      )}
    >
      <Star className={cn("size-4 transition-[fill,transform] duration-300", t.flagged && "scale-110 fill-amber-400")} />
    </button>
  );
}

// ── Bulk actions ────────────────────────────────────────────────────────────

function BulkBar({
  count,
  allSelected,
  onSelectAll,
  onClear,
  role,
  anyUnread,
  anyUnstarred,
  onSeen,
  onStar,
  onMove,
}: {
  count: number;
  allSelected: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  role: string;
  anyUnread: boolean;
  anyUnstarred: boolean;
  onSeen: (seen: boolean) => void;
  onStar: (flagged: boolean) => void;
  onMove: (target: MoveTarget) => void;
}) {
  const mail = useMail();
  const disposable = DISPOSABLE.has(role);
  return (
    <div className="flex h-14 animate-in items-center gap-0.5 px-2 fade-in-0 md:px-3">
      <IconButton label="Clear selection" onClick={onClear}>
        <X />
      </IconButton>
      <button className="min-w-0 truncate px-1 text-sm font-semibold" onClick={allSelected ? onClear : onSelectAll}>
        {count} selected
        <span className="ml-2 hidden text-xs font-medium text-brand sm:inline">{allSelected ? "Clear" : "Select all"}</span>
      </button>
      <div className="flex-1" />
      {mail.can.organise ? (
        <>
          <IconButton label={anyUnread ? "Mark as read" : "Mark as unread"} onClick={() => onSeen(anyUnread)}>
            {anyUnread ? <MailOpen /> : <Mail />}
          </IconButton>
          <IconButton label={anyUnstarred ? "Star" : "Unstar"} onClick={() => onStar(anyUnstarred)}>
            <Star />
          </IconButton>
          {role === "JUNK" ? (
            <IconButton label="Not spam" onClick={() => onMove("inbox")}>
              <ShieldCheck />
            </IconButton>
          ) : role === "ARCHIVE" || role === "TRASH" ? (
            <IconButton label="Move to Inbox" onClick={() => onMove("inbox")}>
              <ArchiveRestore />
            </IconButton>
          ) : (
            <IconButton label="Archive" onClick={() => onMove("archive")}>
              <Archive />
            </IconButton>
          )}
          <IconButton label={disposable ? "Delete forever" : "Delete"} onClick={() => onMove(disposable ? "delete" : "trash")}>
            <Trash2 />
          </IconButton>
          <MoveMenu onMove={onMove} spam={role !== "JUNK"} />
        </>
      ) : null}
    </div>
  );
}

export function MoveMenu({ onMove, spam }: { onMove: (t: MoveTarget) => void; spam?: boolean }) {
  const mail = useMail();
  const targets = mail.folders.filter((f) => f.id !== mail.folder?.id && f.role !== "DRAFTS" && f.role !== "SENT");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label="Move to…">
          <FolderInput />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Move to</DropdownMenuLabel>
        {targets.map((f) => (
          <DropdownMenuItem key={f.id} onSelect={() => onMove({ folderId: f.id })} style={{ paddingLeft: 10 + f.depth * 12 }}>
            {f.name}
          </DropdownMenuItem>
        ))}
        {spam ? (
          <DropdownMenuItem onSelect={() => onMove("spam")} variant="destructive">
            <OctagonAlert /> Report spam
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EmptyFolderButton({ folder }: { folder: FolderDTO }) {
  const mail = useMail();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!confirming) {
    return (
      <button
        className="mr-1 rounded-lg px-2 py-1 text-xs font-medium whitespace-nowrap text-destructive hover:bg-destructive/10"
        onClick={() => setConfirming(true)}
      >
        Empty
      </button>
    );
  }
  return (
    <span className="mr-1 flex items-center gap-1 text-xs">
      <span className="hidden text-muted-foreground lg:inline">Delete everything forever?</span>
      <button
        disabled={busy}
        className="rounded-lg bg-destructive px-2 py-1 font-medium text-white hover:bg-destructive/90 disabled:opacity-60"
        onClick={async () => {
          setBusy(true);
          await mail.emptyFolder(folder.id);
          setBusy(false);
          setConfirming(false);
        }}
      >
        {busy ? "Emptying…" : `Empty ${folder.name}`}
      </button>
      <button className="rounded-lg px-2 py-1 font-medium hover:bg-muted" onClick={() => setConfirming(false)}>
        Cancel
      </button>
    </span>
  );
}

// ── Touch gestures ──────────────────────────────────────────────────────────

const SWIPE_TRIGGER = 88;

/** Swipe a row left (archive/delete) or right (read/unread) on touch screens. */
function useSwipe({
  onLeft,
  onRight,
  leftLabel,
  rightLabel,
  enabled,
}: {
  onLeft: () => void;
  onRight: () => void;
  leftLabel: string;
  rightLabel: string;
  enabled: boolean;
}) {
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const mode = useRef<"undecided" | "swipe" | "scroll">("undecided");
  const offset = useRef(0);
  const justSwiped = useRef(false);
  const [dx, setDx] = useState(0);
  const [settling, setSettling] = useState(false);

  const end = () => {
    start.current = null;
    mode.current = "undecided";
    offset.current = 0;
    setSettling(true);
    setDx(0);
  };

  const containerProps = enabled
    ? {
        onPointerDown: (e: ReactPointerEvent) => {
          if (e.pointerType !== "touch") return;
          start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
          mode.current = "undecided";
          justSwiped.current = false;
          setSettling(false);
        },
        onPointerMove: (e: ReactPointerEvent) => {
          const s = start.current;
          if (!s || s.id !== e.pointerId || mode.current === "scroll") return;
          const x = e.clientX - s.x;
          const y = e.clientY - s.y;
          if (mode.current === "undecided") {
            if (Math.abs(y) > 10 && Math.abs(y) > Math.abs(x)) {
              mode.current = "scroll";
              return;
            }
            if (Math.abs(x) > 12 && Math.abs(x) > Math.abs(y) * 1.5) mode.current = "swipe";
            else return;
          }
          offset.current = Math.max(-160, Math.min(160, x));
          setDx(offset.current);
        },
        onPointerUp: () => {
          if (mode.current === "swipe") {
            justSwiped.current = true;
            if (offset.current <= -SWIPE_TRIGGER) onLeft();
            else if (offset.current >= SWIPE_TRIGGER) onRight();
          }
          end();
        },
        onPointerCancel: end,
        onClickCapture: (e: React.MouseEvent) => {
          // A swipe must not also open the conversation.
          if (justSwiped.current) {
            justSwiped.current = false;
            e.stopPropagation();
          }
        },
        style: { touchAction: "pan-y" as const },
      }
    : {};

  const background =
    dx !== 0 ? (
      <div
        aria-hidden="true"
        className={cn(
          "absolute inset-0 flex items-center px-6 text-sm font-medium text-white",
          dx < 0 ? (leftLabel.startsWith("Delete") ? "justify-end bg-destructive" : "justify-end bg-emerald-600") : "justify-start bg-brand",
        )}
      >
        <span className={cn("transition-opacity", Math.abs(dx) >= SWIPE_TRIGGER ? "opacity-100" : "opacity-60")}>
          {dx < 0 ? leftLabel : rightLabel}
        </span>
      </div>
    ) : null;

  return {
    containerProps,
    background,
    style: { transform: dx ? `translateX(${dx}px)` : undefined, transition: settling ? "transform 180ms ease-out" : undefined },
  };
}

// ── Pull to refresh (phones) ────────────────────────────────────────────────

function usePullToRefresh(
  ref: React.RefObject<HTMLDivElement | null>,
  refresh: () => Promise<unknown>,
  setPull: (n: number) => void,
) {
  const startY = useRef<number | null>(null);
  const pull = useRef(0);
  const busy = useRef(false);
  return {
    onTouchStart: (e: React.TouchEvent) => {
      if (busy.current || (ref.current?.scrollTop ?? 0) > 0) return;
      startY.current = e.touches[0].clientY;
    },
    onTouchMove: (e: React.TouchEvent) => {
      if (startY.current === null) return;
      const d = e.touches[0].clientY - startY.current;
      if (d <= 0 || (ref.current?.scrollTop ?? 0) > 0) {
        pull.current = 0;
        setPull(0);
        return;
      }
      pull.current = Math.min(96, d * 0.5);
      setPull(pull.current);
    },
    onTouchEnd: () => {
      startY.current = null;
      if (pull.current >= 64 && !busy.current) {
        busy.current = true;
        setPull(-1);
        void refresh().finally(() => {
          busy.current = false;
          setPull(0);
        });
      } else setPull(0);
      pull.current = 0;
    },
  };
}

function PullIndicator({ pull }: { pull: number }) {
  if (pull === 0) return null;
  const refreshing = pull < 0;
  return (
    <div
      className="pointer-events-none flex items-center justify-center overflow-hidden text-muted-foreground transition-[height]"
      style={{ height: refreshing ? 48 : pull }}
      aria-hidden="true"
    >
      <RefreshCw className={cn("size-5", refreshing && "animate-spin")} style={refreshing ? undefined : { transform: `rotate(${pull * 4}deg)` }} />
    </div>
  );
}
