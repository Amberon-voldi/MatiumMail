"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, MailOpen, RefreshCw, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { setFlagsAction, syncNowAction, trashAction } from "@/app/actions/mail";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const POLL_MS = 2 * 60_000;

/**
 * Near-real-time without background workers: sync when the page opens (if the
 * cache is older than a minute), every 2 minutes while the tab is visible, and
 * when the tab regains focus. Refreshes the view only when something changed.
 */
export function AutoSync({
  mailboxId,
  folderId,
  lastSyncAt,
  initial,
}: {
  mailboxId: string;
  /** The folder being viewed; it is what gets synced (any sync also refreshes all unread counts). */
  folderId?: string;
  lastSyncAt: string | null;
  initial: boolean;
}) {
  const router = useRouter();
  const running = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const target = folderId ?? "inbox";
    const run = async (scope: string) => {
      if (running.current || document.visibilityState !== "visible") return;
      running.current = true;
      try {
        const res = await syncNowAction(mailboxId, scope);
        if (!res.ok) setError(res.error);
        else {
          setError(null);
          if (res.data && (res.data.newMessages > 0 || initial)) router.refresh();
        }
      } finally {
        running.current = false;
      }
    };
    const stale = !lastSyncAt || Date.now() - new Date(lastSyncAt).getTime() > 30_000;
    if (initial) void run("all");
    else if (stale) void run(target);
    const timer = setInterval(() => void run(target), POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && void run(target);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [mailboxId, folderId, lastSyncAt, initial, router]);

  return error ? (
    <p role="status" className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-300">
      {error}
    </p>
  ) : null;
}

export function SyncButton({ mailboxId }: { mailboxId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Check for new mail"
      title="Check for new mail"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await syncNowAction(mailboxId, "all");
          router.refresh();
        })
      }
    >
      {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
    </Button>
  );
}

export function MessageActions({
  mailboxId,
  messageId,
  isFlagged,
  backHref,
}: {
  mailboxId: string;
  messageId: string;
  isFlagged: boolean;
  backHref: string;
}) {
  const router = useRouter();
  const [, startRefresh] = useTransition();
  // Optimistic: the UI changes immediately; the server catches up in the
  // background and we only interrupt the user if it fails.
  const [flagged, setFlagged] = useState(isFlagged);

  const toggleStar = () => {
    const next = !flagged;
    setFlagged(next);
    void setFlagsAction(mailboxId, [messageId], { flagged: next }).then((res) => {
      if (!res.ok) {
        setFlagged(!next);
        toast.error(res.error);
      } else startRefresh(() => router.refresh());
    });
  };

  const leaveThen = (fn: () => Promise<{ ok: boolean; error?: string }>, undoLabel: string) => {
    router.push(backHref);
    void fn().then((res) => {
      if (!res.ok) toast.error(res.error ?? `Couldn't ${undoLabel}.`);
      startRefresh(() => router.refresh());
    });
  };

  return (
    <div className="flex items-center gap-1">
      <Button variant="ghost" size="icon" aria-label={flagged ? "Unstar" : "Star"} title={flagged ? "Unstar" : "Star"} onClick={toggleStar}>
        <Star className={cn("transition-colors", flagged && "fill-amber-400 text-amber-500")} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Mark as unread"
        title="Mark as unread"
        onClick={() => leaveThen(() => setFlagsAction(mailboxId, [messageId], { seen: false }), "mark as unread")}
      >
        <MailOpen />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Move to Trash"
        title="Move to Trash"
        onClick={() => leaveThen(() => trashAction(mailboxId, [messageId]), "move to Trash")}
      >
        <Trash2 />
      </Button>
    </div>
  );
}

/** Marks the open message as read once, after it has rendered. */
export function MarkSeen({ mailboxId, messageId, isSeen }: { mailboxId: string; messageId: string; isSeen: boolean }) {
  const router = useRouter();
  const done = useRef(false);
  useEffect(() => {
    if (isSeen || done.current) return;
    done.current = true;
    void setFlagsAction(mailboxId, [messageId], { seen: true }).then((r) => r.ok && router.refresh());
  }, [mailboxId, messageId, isSeen, router]);
  return null;
}

/**
 * Untrusted email content. No allow-scripts and no allow-same-origin: the
 * frame can't run code or touch the app. Popups are allowed so links open in
 * a new tab, escaping the sandbox (so the destination site works normally).
 */
export function EmailFrame({ srcDoc, title }: { srcDoc: string; title: string }) {
  return (
    <iframe
      title={title}
      srcDoc={srcDoc}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      className="h-full w-full rounded-lg border bg-white"
    />
  );
}
