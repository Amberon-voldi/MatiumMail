"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { KeyRound, PenSquare, WifiOff } from "lucide-react";
import { toast } from "sonner";
import type { ActionOp, FolderDTO, MailPreferences, ThreadMessageDTO, ThreadPageDTO } from "@/lib/mail-types";
import { InstallPrompt } from "@/components/install-prompt";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { ApiError, errorMessage, mailApi, type ThreadQuery } from "../_lib/api";
import { dropThreads, fromPage, listKey, lists, loadList, patchThreads, seedList, staleLists, threadStore } from "../_lib/store";
import { clearSavedCompose, Composer, savedComposeFor } from "./composer";
import {
  MailContext,
  type ComposerInit,
  type MailboxInfo,
  type MailCtx,
  type MoveTarget,
  type Nav,
  type OtherMailbox,
  type SignedInAccount,
} from "./mail-context";
import { SettingsDialog, ShortcutsDialog } from "./settings";
import { Sidebar } from "./sidebar";
import { ThreadList } from "./thread-list";
import { ThreadView } from "./thread-view";
import { forgetMailboxesExcept, save as saveToDevice } from "@/lib/mail-cache";

const POLL_MS = 60_000;

export type MailAppProps = {
  mailbox: MailboxInfo;
  folders: FolderDTO[];
  preferences: MailPreferences;
  mailboxes: OtherMailbox[];
  accounts: SignedInAccount[];
  initial: { folderId: string | null; q: string; all: boolean; page: ThreadPageDTO | null };
};

function queryFor(nav: Nav, conv: boolean): ThreadQuery {
  return {
    folder: nav.q && nav.all ? undefined : (nav.folderId ?? undefined),
    q: nav.q || undefined,
    all: nav.q ? nav.all : false,
    conv,
  };
}

/** Optimistically change messages in every open conversation, here and in the copy saved on the device. */
function patchThreadMessages(mailboxId: string, ids: Set<string>, patch: Partial<ThreadMessageDTO>) {
  for (const key of threadStore.keys()) {
    const r = threadStore.get(key);
    if (!r?.data) continue;
    let changed = false;
    const messages = r.data.messages.map((m) => {
      if (!ids.has(m.id)) return m;
      changed = true;
      return { ...m, ...patch };
    });
    if (!changed) continue;
    const data = { ...r.data, messages };
    threadStore.set(key, { ...r, data });
    saveToDevice(mailboxId, "thread", key, data);
  }
}

const subscribeOnline = (fn: () => void) => {
  window.addEventListener("online", fn);
  window.addEventListener("offline", fn);
  return () => {
    window.removeEventListener("online", fn);
    window.removeEventListener("offline", fn);
  };
};

const DONE: Record<string, string> = {
  archive: "Archived",
  trash: "Moved to Trash",
  spam: "Reported as spam",
  inbox: "Moved to Inbox",
  delete: "Deleted forever",
};

export function MailApp(props: MailAppProps) {
  const { mailbox } = props;
  const api = useMemo(() => mailApi(mailbox.id), [mailbox.id]);
  const params = useSearchParams();
  const [folders, setFolders] = useState(props.folders);
  const [prefs, setPrefsState] = useState(props.preferences);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [needsReauth, setNeedsReauth] = useState(mailbox.status === "NEEDS_REAUTH");
  const [composer, setComposer] = useState<(ComposerInit & { id: number }) | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ count: number; resolve: (ok: boolean) => void } | null>(null);
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const can = useMemo(() => ({ organise: mailbox.role !== "READ_ONLY", send: mailbox.role !== "READ_ONLY" }), [mailbox.role]);

  // Mail saved on this device for accounts that have since been signed out goes too.
  const reachable = [mailbox.id, ...props.mailboxes.map((m) => m.id)].join(",");
  useEffect(() => {
    void forgetMailboxesExcept(reachable.split(","));
  }, [reachable]);

  // ── URL state ────────────────────────────────────────────────────────────
  const inbox = folders.find((f) => f.role === "INBOX") ?? folders[0] ?? null;
  const folderParam = params.get("folder");
  const threadParam = params.get("thread");
  const qParam = params.get("q") ?? "";
  const allParam = params.get("all") === "1";
  const nav: Nav = useMemo(
    () => ({
      folderId: folders.some((f) => f.id === folderParam) ? folderParam : (inbox?.id ?? null),
      threadId: threadParam,
      q: qParam,
      all: allParam,
    }),
    [folders, folderParam, inbox?.id, threadParam, qParam, allParam],
  );
  const folder = folders.find((f) => f.id === nav.folderId) ?? null;
  const navRef = useRef(nav);
  const convRef = useRef(prefs.conversationView);
  useEffect(() => {
    navRef.current = nav;
    convRef.current = prefs.conversationView;
  }, [nav, prefs.conversationView]);

  const navigate = useCallback((patch: Partial<Nav>, opts: { replace?: boolean } = {}) => {
    const url = new URL(window.location.href);
    const set = (k: string, v: string | null | undefined) => (v ? url.searchParams.set(k, v) : url.searchParams.delete(k));
    if ("folderId" in patch) set("folder", patch.folderId);
    if ("threadId" in patch) set("thread", patch.threadId);
    if ("q" in patch) set("q", patch.q);
    if ("all" in patch) set("all", patch.all ? "1" : null);
    const next = url.pathname + url.search;
    if (next === window.location.pathname + window.location.search) return;
    window.history[opts.replace ? "replaceState" : "pushState"](null, "", next);
  }, []);

  // ── Current list ─────────────────────────────────────────────────────────
  const query = useMemo(() => queryFor(nav, prefs.conversationView), [nav, prefs.conversationView]);
  const currentKey = listKey(mailbox.id, query);
  const currentKeyRef = useRef(currentKey);
  useEffect(() => {
    currentKeyRef.current = currentKey;
  }, [currentKey]);

  // The server-rendered first page: shown on first paint, and seeded into the
  // browser cache so it isn't fetched again.
  const [initial] = useState(() => {
    const { folderId, q, all, page } = props.initial;
    const key = listKey(mailbox.id, queryFor({ folderId, threadId: null, q, all }, props.preferences.conversationView));
    const state = page ? fromPage(page) : null;
    seedList(key, state); // browser only; once
    return { key, state };
  });

  const reloadCurrent = useCallback(() => {
    const q = queryFor(navRef.current, convRef.current);
    void loadList(api, listKey(mailbox.id, q), q);
  }, [api, mailbox.id]);

  const refreshFolders = useCallback(() => {
    void api
      .folders()
      .then((r) => setFolders(r.folders))
      .catch(() => {});
  }, [api]);

  // ── Sync ─────────────────────────────────────────────────────────────────
  const syncingRef = useRef(false);
  // Inbox unread count as last shown, to announce mail that arrives by sync.
  const inboxUnreadRef = useRef<number | null>(null);
  useEffect(() => {
    inboxUnreadRef.current = inbox ? inbox.unread : null;
  }, [inbox]);
  const syncNow = useCallback(
    async (scope?: string) => {
      if (syncingRef.current) return;
      syncingRef.current = true;
      setSyncing(true);
      try {
        const res = await api.sync(scope ?? navRef.current.folderId ?? "inbox");
        const before = inboxUnreadRef.current;
        const now = res.folders.find((f) => f.role === "INBOX")?.unread ?? 0;
        if (before !== null && now > before && document.visibilityState === "visible") {
          const added = now - before;
          toast(`${added} new message${added === 1 ? "" : "s"}`, { id: "new-mail", description: "Just arrived in your Inbox." });
        }
        setFolders(res.folders);
        setSyncError(null);
        setNeedsReauth(false);
        if (res.result.newMessages > 0) {
          staleLists(mailbox.id);
          reloadCurrent();
        }
      } catch (err) {
        if (err instanceof ApiError && err.code === "needs_reauth") setNeedsReauth(true);
        else if (!(err instanceof ApiError && err.code === "offline")) setSyncError(errorMessage(err));
      } finally {
        syncingRef.current = false;
        setSyncing(false);
      }
    },
    [api, mailbox.id, reloadCurrent],
  );

  // On open (first sign-in: everything), every minute while visible, and when coming back.
  const firstSync = useRef({ empty: props.folders.length === 0, stale: props.folders.every((f) => !f.lastSyncedAt) });
  useEffect(() => {
    const { empty } = firstSync.current;
    const stale = props.folders.every((f) => !f.lastSyncedAt || Date.now() - Date.parse(f.lastSyncedAt) > 30_000);
    if (empty) void syncNow("all");
    else if (stale) void syncNow();
    const tick = () => {
      if (document.visibilityState === "visible" && navigator.onLine) void syncNow();
    };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("online", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("online", tick);
    };
  }, [syncNow, props.folders]);

  // ── Actions (optimistic) ─────────────────────────────────────────────────
  const run = useCallback(
    async (op: ActionOp): Promise<boolean> => {
      try {
        await api.action(op);
        refreshFolders();
        return true;
      } catch (err) {
        toast.error("That didn't work", { description: errorMessage(err) });
        staleLists(mailbox.id);
        reloadCurrent();
        const open = navRef.current.threadId;
        if (open) threadStore.delete(open);
        return false;
      }
    },
    [api, mailbox.id, refreshFolders, reloadCurrent],
  );

  const markSeen = useCallback(
    (ids: string[], seen: boolean) => {
      if (!ids.length || !can.organise) return;
      const set = new Set(ids);
      patchThreads(
        mailbox.id,
        (t) => t.ids.some((id) => set.has(id)),
        (t) => ({ ...t, unread: seen ? t.unread && !t.ids.every((id) => set.has(id)) : true }),
      );
      patchThreadMessages(mailbox.id, set, { isSeen: seen });
      void run({ op: "flags", ids, seen });
    },
    [can.organise, mailbox.id, run],
  );

  const setStar = useCallback(
    (ids: string[], flagged: boolean) => {
      if (!ids.length || !can.organise) return;
      const set = new Set(ids);
      patchThreads(mailbox.id, (t) => t.ids.some((id) => set.has(id)), (t) => ({ ...t, flagged }));
      patchThreadMessages(mailbox.id, set, { isFlagged: flagged });
      void run({ op: "flags", ids, flagged });
    },
    [can.organise, mailbox.id, run],
  );

  const move = useCallback(
    async (ids: string[], target: MoveTarget, keys: string[]): Promise<boolean> => {
      if (!ids.length || !can.organise) return false;
      if (target === "delete") {
        const ok = await new Promise<boolean>((resolve) => setConfirm({ count: ids.length, resolve }));
        if (!ok) return false;
      }
      const n = navRef.current;
      const idSet = new Set(ids);
      const keySet = new Set(keys);
      for (const key of lists.keys()) {
        lists.get(key)?.threads.forEach((t) => {
          if (t.ids.some((id) => idSet.has(id))) keySet.add(t.key);
        });
      }
      // Leaving the open conversation: show the next one (desktop) or go back to the list (phone).
      if (n.threadId && (idSet.has(n.threadId) || keys.length)) {
        const list = lists.get(currentKeyRef.current)?.threads ?? [];
        const at = list.findIndex((t) => t.ids.includes(n.threadId!));
        if (at < 0 || keySet.has(list[at].key)) {
          const after = list.slice(at + 1).find((t) => !keySet.has(t.key));
          const before = list.slice(0, Math.max(0, at)).reverse().find((t) => !keySet.has(t.key));
          const wide = window.matchMedia("(min-width: 768px)").matches;
          const next = at >= 0 ? (after ?? before) : undefined;
          navigate({ threadId: wide && next ? next.latestId : null }, { replace: true });
        }
      }
      const conversations = (lists.get(currentKeyRef.current)?.threads ?? []).filter((t) => keySet.has(t.key)).length;
      // Let the rows fold away first, then drop them from every list.
      const shown = lists.get(currentKeyRef.current);
      if (shown) {
        lists.set(currentKeyRef.current, {
          ...shown,
          threads: shown.threads.map((t) => (keySet.has(t.key) ? { ...t, leaving: true } : t)),
        });
      }
      const fromFolder = n.q && n.all ? null : n.folderId;
      setTimeout(() => dropThreads(mailbox.id, keySet, fromFolder), 220);
      const op: ActionOp =
        typeof target === "object"
          ? { op: "move", ids, folderId: target.folderId }
          : target === "inbox"
            ? { op: "notSpam", ids }
            : { op: target, ids };
      const label =
        typeof target === "object" ? `Moved to ${folders.find((f) => f.id === target.folderId)?.name ?? "folder"}` : DONE[target];
      const ok = await run(op);
      if (ok) {
        toast.success(conversations > 1 ? `${label} · ${conversations} conversations` : label);
        staleLists(mailbox.id);
        // The messages now live in another folder; cache it so search and that folder show them.
        void syncNow("all");
      }
      return ok;
    },
    [can.organise, folders, mailbox.id, navigate, run, syncNow],
  );

  const emptyFolder = useCallback(
    async (folderId: string) => {
      const ok = await run({ op: "emptyFolder", folderId });
      if (!ok) return;
      for (const key of lists.keys()) if (key.split("|")[1] === folderId) lists.delete(key);
      staleLists(mailbox.id);
      reloadCurrent();
      toast.success("Emptied");
    },
    [mailbox.id, reloadCurrent, run],
  );

  const setPrefs = useCallback(
    (patch: Partial<MailPreferences>) => {
      setPrefsState((p) => ({ ...p, ...patch }));
      void api.savePreferences(patch).catch((err) => toast.error("Couldn't save the setting", { description: errorMessage(err) }));
    },
    [api],
  );

  const composerId = useRef(0);
  const openComposer = useCallback((init: ComposerInit) => {
    composerId.current += 1;
    setComposer({ ...init, id: composerId.current });
  }, []);

  // Offer to bring back a message that was being written when the page closed.
  useEffect(() => {
    const saved = savedComposeFor(mailbox.id);
    if (!saved || !can.send) return;
    const hasText = saved.to.length || saved.subject.trim() || saved.html.replace(/<[^>]+>/g, "").trim();
    if (!hasText) {
      clearSavedCompose(mailbox.id);
      return;
    }
    toast("You have an unsent message", {
      id: "restore-compose",
      description: saved.subject || saved.to.join(", ") || "Restore it to keep writing.",
      duration: 15_000,
      action: { label: "Restore", onClick: () => openComposer({ mode: saved.mode, sourceId: saved.sourceId, restore: saved }) },
    });
  }, [mailbox.id, can.send, openComposer]);

  // The folder drawer (phones) closes with Escape like any other overlay.
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  // Unread count in the tab title.
  useEffect(() => {
    const unread = inbox?.unread ?? 0;
    document.title = `${unread ? `(${unread}) ` : ""}${nav.q ? "Search" : (folder?.name ?? "Mail")} · Matium Mail`;
  }, [inbox?.unread, folder?.name, nav.q]);

  const ctx: MailCtx = useMemo(
    () => ({
      mailbox,
      api,
      folders,
      folder: nav.q && nav.all ? null : folder,
      prefs,
      setPrefs,
      nav,
      navigate,
      openComposer,
      markSeen,
      setStar,
      move,
      emptyFolder,
      syncNow,
      syncing,
      can,
      openSidebar: () => setDrawer(true),
    }),
    [mailbox, api, folders, folder, prefs, setPrefs, nav, navigate, openComposer, markSeen, setStar, move, emptyFolder, syncNow, syncing, can],
  );

  useShortcuts(ctx, currentKey, composer !== null, () => setShortcutsOpen(true));

  const closeThread = useCallback(() => navigate({ threadId: null }), [navigate]);

  return (
    <MailContext.Provider value={ctx}>
      <div className="flex h-dvh overflow-hidden bg-background">
        {/* Folders: a column on desktop, a drawer on phones */}
        <aside className="hidden w-64 shrink-0 border-r md:block xl:w-72">
          <Sidebar
            mailboxes={props.mailboxes}
            accounts={props.accounts}
            onNavigate={() => {}}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenShortcuts={() => setShortcutsOpen(true)}
          />
        </aside>
        {drawer ? (
          <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Folders">
            <button className="absolute inset-0 animate-in bg-black/40 fade-in-0" aria-label="Close folders" onClick={() => setDrawer(false)} />
            <aside className="absolute inset-y-0 left-0 w-[84vw] max-w-80 animate-in border-r shadow-2xl duration-200 slide-in-from-left">
              <Sidebar
                mailboxes={props.mailboxes}
                accounts={props.accounts}
                onNavigate={() => setDrawer(false)}
                onOpenSettings={() => {
                  setDrawer(false);
                  setSettingsOpen(true);
                }}
                onOpenShortcuts={() => setShortcutsOpen(true)}
              />
            </aside>
          </div>
        ) : null}

        {/* Conversation list */}
        <section
          className={cn(
            "min-w-0 shrink-0 flex-col border-r md:flex md:w-[360px] lg:w-[400px] xl:w-[440px]",
            nav.threadId ? "hidden" : "flex w-full max-md:motion-safe:animate-in max-md:motion-safe:fade-in-0",
          )}
        >
          <Banners online={online} needsReauth={needsReauth} syncError={syncError} onRetry={() => void syncNow()} mailbox={mailbox} />
          <ThreadList
            key={currentKey}
            listKey={currentKey}
            query={query}
            initialState={currentKey === initial.key ? initial.state : null}
          />
        </section>

        {/* Reader */}
        <main className={cn("min-w-0 flex-1 flex-col bg-muted/20", nav.threadId ? "flex" : "hidden md:flex")}>
          {nav.threadId ? (
            <div key={nav.threadId} className="flex h-full min-h-0 animate-in flex-col duration-200 fade-in-0 max-md:slide-in-from-right-6">
              <ThreadView messageId={nav.threadId} onClose={closeThread} />
            </div>
          ) : (
            <ReaderPlaceholder unread={inbox?.unread ?? 0} />
          )}
        </main>

        {/* Phones: floating compose button */}
        {can.send && !nav.threadId && !composer ? (
          <Button
            onClick={() => openComposer({ mode: "new" })}
            className="bottom-safe fixed right-4 z-30 h-14 gap-2 rounded-2xl bg-brand px-5 text-base font-semibold text-brand-foreground shadow-lg shadow-brand/30 hover:bg-brand/90 md:hidden"
          >
            <PenSquare className="size-5" /> Compose
          </Button>
        ) : null}

        {composer ? <Composer key={composer.id} init={composer} onClose={() => setComposer(null)} /> : null}

        {/* Phones and tablets: offer "Add to Home Screen" once signed in */}
        <InstallPrompt suppressed={composer !== null || drawer} />

        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
        <Dialog
          open={confirm !== null}
          onOpenChange={(open) => {
            if (!open && confirm) {
              confirm.resolve(false);
              setConfirm(null);
            }
          }}
        >
          <DialogContent showClose={false}>
            <DialogTitle>Delete forever?</DialogTitle>
            <DialogDescription>
              {confirm?.count === 1 ? "This message" : `These ${confirm?.count} messages`} will be permanently deleted from the mail server. This
              can&apos;t be undone.
            </DialogDescription>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  confirm?.resolve(false);
                  setConfirm(null);
                }}
              >
                Cancel
              </Button>
              <Button
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={() => {
                  confirm?.resolve(true);
                  setConfirm(null);
                }}
              >
                Delete forever
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </MailContext.Provider>
  );
}

function Banners({
  online,
  needsReauth,
  syncError,
  onRetry,
  mailbox,
}: {
  online: boolean;
  needsReauth: boolean;
  syncError: string | null;
  onRetry: () => void;
  mailbox: MailboxInfo;
}) {
  if (!online) {
    return (
      <p role="status" className="flex shrink-0 items-center gap-2 bg-foreground px-4 py-2 text-xs text-background">
        <WifiOff className="size-3.5" aria-hidden="true" /> You&apos;re offline. Showing mail already loaded.
      </p>
    );
  }
  if (needsReauth) {
    return (
      <p role="alert" className="flex shrink-0 items-center gap-2 bg-destructive/10 px-4 py-2 text-xs text-destructive">
        <KeyRound className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="flex-1">The mail server rejected the saved password (was it changed in mPanel?).</span>
        {mailbox.role === "OWNER" ? (
          <Link href={`/mail/${mailbox.id}/reconnect`} className="shrink-0 font-semibold underline underline-offset-2">
            Reconnect
          </Link>
        ) : null}
      </p>
    );
  }
  if (syncError) {
    return (
      <p role="status" className="flex shrink-0 items-center gap-2 bg-amber-500/10 px-4 py-2 text-xs text-amber-800 dark:text-amber-200">
        <span className="flex-1">{syncError}</span>
        <button className="shrink-0 font-semibold underline underline-offset-2" onClick={onRetry}>
          Retry
        </button>
      </p>
    );
  }
  return null;
}

function ReaderPlaceholder({ unread }: { unread: number }) {
  return (
    <div className="m-auto flex max-w-sm flex-col items-center px-6 text-center motion-safe:animate-fade-up">
      <div className="relative isolate">
        <div aria-hidden="true" className="absolute inset-0 -z-10 scale-[1.8] rounded-full bg-brand/20 blur-2xl motion-safe:animate-pulse" />
        <Logo className="size-14 rounded-2xl motion-safe:animate-float" />
      </div>
      <p className="mt-5 text-base font-semibold tracking-tight">Select a conversation to read</p>
      <p className="mt-1.5 text-sm text-muted-foreground">
        {unread > 0 ? `You have ${unread} unread message${unread === 1 ? "" : "s"} in your Inbox.` : "Your Inbox is all caught up."}
      </p>
      <p className="mt-6 hidden text-xs text-muted-foreground md:block">
        Tip: press <kbd className="rounded border bg-muted px-1 font-mono">?</kbd> for keyboard shortcuts.
      </p>
    </div>
  );
}

// ── Keyboard shortcuts (desktop) ────────────────────────────────────────────

function useShortcuts(mail: MailCtx, currentKey: string, composerOpen: boolean, openShortcuts: () => void) {
  const latest = useRef({ mail, currentKey, composerOpen, openShortcuts });
  useEffect(() => {
    latest.current = { mail, currentKey, composerOpen, openShortcuts };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { mail: m, currentKey: key, composerOpen: composing, openShortcuts: help } = latest.current;
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (composing || document.querySelector("[data-slot=dialog-content], [data-slot=dropdown-menu-content]")) return;

      const threads = lists.get(key)?.threads ?? [];
      const openId = m.nav.threadId;
      const index = openId ? threads.findIndex((x) => x.ids.includes(openId)) : -1;
      const open = index >= 0 ? threads[index] : null;
      const thread = openId ? threadStore.get(openId)?.data : null;
      const latestMsg = thread ? [...thread.messages].reverse().find((x) => !x.isDraft) : null;
      const ids = open?.ids ?? (openId ? [openId] : []);
      const keys = open ? [open.key] : [];

      const handled = (() => {
        switch (e.key) {
          case "c":
            if (m.can.send) m.openComposer({ mode: "new" });
            return true;
          case "/":
            document.getElementById("mail-search")?.focus();
            return true;
          case "?":
            help();
            return true;
          case "j":
          case "k": {
            const next = threads[index < 0 ? 0 : Math.max(0, Math.min(threads.length - 1, index + (e.key === "j" ? 1 : -1)))];
            if (next) m.navigate({ threadId: next.latestId }, { replace: Boolean(openId) });
            return true;
          }
          case "o":
          case "Enter":
            if (!openId && threads[0]) m.navigate({ threadId: threads[0].latestId });
            return !openId;
          case "u":
          case "Escape":
            if (openId) m.navigate({ threadId: null });
            return Boolean(openId);
        }
        if (!openId) return false;
        switch (e.key) {
          case "r":
          case "a":
          case "f":
            if (latestMsg && m.can.send) {
              m.openComposer({ mode: e.key === "r" ? "reply" : e.key === "a" ? "replyAll" : "forward", sourceId: latestMsg.id });
            }
            return true;
          case "e":
            void m.move(ids, "archive", keys);
            return true;
          case "#":
            void m.move(ids, "trash", keys);
            return true;
          case "s":
            m.setStar(ids, !(open?.flagged ?? thread?.messages.some((x) => x.isFlagged)));
            return true;
          case "I":
            m.markSeen(ids, true);
            return true;
          case "U":
            m.markSeen(ids, false);
            m.navigate({ threadId: null });
            return true;
        }
        return false;
      })();
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
