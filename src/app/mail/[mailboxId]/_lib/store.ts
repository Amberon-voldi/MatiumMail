import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { MessageBodyDTO, ThreadDTO, ThreadPageDTO, ThreadSummaryDTO } from "@/lib/mail-types";
import { errorMessage, type MailApi, type ThreadQuery } from "./api";

/**
 * In-memory caches for the mail app: conversation lists per folder/search,
 * conversations and message bodies. Switching back to a folder or reopening a
 * message is instant; data refreshes in the background (stale-while-revalidate),
 * and every action updates the caches optimistically.
 */

export class KeyedStore<T> {
  private values = new Map<string, T>();
  private subs = new Map<string, Set<() => void>>();

  get(key: string): T | undefined {
    return this.values.get(key);
  }
  has(key: string): boolean {
    return this.values.has(key);
  }
  keys(): string[] {
    return [...this.values.keys()];
  }
  set(key: string, value: T): void {
    this.values.set(key, value);
    this.subs.get(key)?.forEach((fn) => fn());
  }
  delete(key: string): void {
    this.values.delete(key);
    this.subs.get(key)?.forEach((fn) => fn());
  }
  subscribe(key: string, fn: () => void): () => void {
    let set = this.subs.get(key);
    if (!set) this.subs.set(key, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }
}

/**
 * Subscribe to one key. `fallback` must be referentially stable; it is also
 * what the server renders (these stores are only ever filled in the browser,
 * so nothing is shared between requests on the server).
 */
export function useStore<T>(store: KeyedStore<T>, key: string | null, fallback: T): T {
  const subscribe = useCallback((fn: () => void) => (key ? store.subscribe(key, fn) : () => {}), [store, key]);
  const get = () => (key ? store.get(key) : undefined) ?? fallback;
  return useSyncExternalStore(subscribe, get, () => fallback);
}

// ── Conversation lists ──────────────────────────────────────────────────────

export type ListState = {
  threads: ThreadSummaryDTO[];
  nextCursor: string | null;
  olderOnServer: boolean;
  status: "loading" | "ready" | "error";
  error: string | null;
  loadingMore: boolean;
  refreshing: boolean;
  fetchedAt: number;
};

export const EMPTY_LIST: ListState = {
  threads: [],
  nextCursor: null,
  olderOnServer: false,
  status: "loading",
  error: null,
  loadingMore: false,
  refreshing: false,
  fetchedAt: 0,
};

export const lists = new KeyedStore<ListState>();

export function listKey(mailboxId: string, q: ThreadQuery): string {
  return [mailboxId, q.folder ?? "", q.q ?? "", q.all ? 1 : 0, q.conv === false ? 0 : 1].join("|");
}

const listFolderOf = (key: string) => key.split("|")[1];
const listMailboxOf = (key: string) => key.split("|")[0];
const listIsSearch = (key: string) => key.split("|")[2] !== "";

export function fromPage(page: ThreadPageDTO): ListState {
  return {
    threads: page.threads,
    nextCursor: page.nextCursor,
    olderOnServer: page.olderOnServer,
    status: "ready",
    error: null,
    loadingMore: false,
    refreshing: false,
    fetchedAt: Date.now(),
  };
}

/** Server-rendered first page, used before any request is made (browser only). */
export function seedList(key: string, state: ListState | null): void {
  if (typeof window !== "undefined" && state && !lists.has(key)) lists.set(key, state);
}

function mergeFirstPage(cur: ListState | undefined, page: ThreadPageDTO): ListState {
  if (!cur || cur.status !== "ready" || cur.threads.length <= page.threads.length) return fromPage(page);
  // Keep the older pages already loaded below the refreshed first page.
  const keys = new Set(page.threads.map((t) => t.key));
  const oldest = page.threads.length ? Date.parse(page.threads[page.threads.length - 1].date) : Infinity;
  const rest = page.nextCursor ? cur.threads.filter((t) => !keys.has(t.key) && Date.parse(t.date) <= oldest) : [];
  return {
    ...fromPage(page),
    threads: [...page.threads, ...rest],
    nextCursor: page.nextCursor ? cur.nextCursor : null,
    olderOnServer: page.nextCursor ? cur.olderOnServer : page.olderOnServer,
  };
}

const inflight = new Map<string, Promise<unknown>>();

function once<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = run().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Load (or refresh) the first page of a list. Never throws; errors land in the state. */
export function loadList(api: MailApi, key: string, q: ThreadQuery): Promise<void> {
  return once(`list:${key}`, async () => {
    const prev = lists.get(key);
    if (!prev || (prev.status !== "ready" && prev.threads.length === 0)) lists.set(key, { ...EMPTY_LIST, status: "loading" });
    else lists.set(key, { ...prev, refreshing: true, error: null });
    try {
      const page = await api.threads(q);
      lists.set(key, mergeFirstPage(lists.get(key), page));
    } catch (err) {
      const cur = lists.get(key) ?? EMPTY_LIST;
      lists.set(key, {
        ...cur,
        status: cur.threads.length ? "ready" : "error",
        error: errorMessage(err),
        refreshing: false,
      });
    }
  });
}

/** Next page; when the cache is exhausted, fetch older mail from the server first. */
export function loadMore(api: MailApi, key: string, q: ThreadQuery): Promise<void> {
  return once(`more:${key}`, async () => {
    const cur = lists.get(key);
    if (!cur || cur.status !== "ready" || cur.loadingMore) return;
    const canBackfill = cur.olderOnServer && Boolean(q.folder) && !q.q;
    if (!cur.nextCursor && !canBackfill) return;
    lists.set(key, { ...cur, loadingMore: true, error: null });
    try {
      let cursor = cur.nextCursor;
      if (!cursor) {
        const res = await api.backfill(q.folder!);
        if (res.added === 0) {
          lists.set(key, { ...lists.get(key)!, loadingMore: false, olderOnServer: false });
          return;
        }
        const last = cur.threads[cur.threads.length - 1];
        cursor = last ? `${Date.parse(last.date)}.${last.latestId}` : null;
      }
      const page = await api.threads({ ...q, cursor });
      const now = lists.get(key)!;
      const seen = new Set(now.threads.map((t) => t.key));
      lists.set(key, {
        ...now,
        threads: [...now.threads, ...page.threads.filter((t) => !seen.has(t.key))],
        nextCursor: page.nextCursor,
        olderOnServer: page.olderOnServer,
        loadingMore: false,
      });
    } catch (err) {
      lists.set(key, { ...(lists.get(key) ?? EMPTY_LIST), loadingMore: false, error: errorMessage(err) });
    }
  });
}

function eachList(mailboxId: string, fn: (key: string, state: ListState) => ListState | null) {
  for (const key of lists.keys()) {
    if (listMailboxOf(key) !== mailboxId) continue;
    const state = lists.get(key);
    if (!state) continue;
    const next = fn(key, state);
    if (next && next !== state) lists.set(key, next);
  }
}

/** Optimistically change conversations everywhere they are listed. */
export function patchThreads(
  mailboxId: string,
  match: (t: ThreadSummaryDTO) => boolean,
  patch: (t: ThreadSummaryDTO) => ThreadSummaryDTO,
): void {
  eachList(mailboxId, (_key, s) => {
    let changed = false;
    const threads = s.threads.map((t) => {
      if (!match(t)) return t;
      changed = true;
      return patch(t);
    });
    return changed ? { ...s, threads } : null;
  });
}

/** Remove conversations from a folder's lists (they were moved or deleted); search lists just go stale. */
export function dropThreads(mailboxId: string, keys: Set<string>, fromFolder: string | null): void {
  eachList(mailboxId, (key, s) => {
    if (listIsSearch(key)) return { ...s, fetchedAt: 0 };
    if (fromFolder && listFolderOf(key) !== fromFolder) return { ...s, fetchedAt: 0 };
    const threads = s.threads.filter((t) => !keys.has(t.key));
    return threads.length !== s.threads.length ? { ...s, threads } : null;
  });
}

/** Mark every list of the mailbox for refresh the next time it is shown. */
export function staleLists(mailboxId: string): void {
  eachList(mailboxId, (_key, s) => ({ ...s, fetchedAt: 0 }));
}

// ── Conversations and bodies ────────────────────────────────────────────────

export type Resource<T> = { data: T | null; error: string | null; loading: boolean; at: number };
export const EMPTY_RESOURCE: Resource<never> = { data: null, error: null, loading: true, at: 0 };

export const threadStore = new KeyedStore<Resource<ThreadDTO>>();
export const bodyStore = new KeyedStore<Resource<MessageBodyDTO>>();

export function ensure<T>(
  store: KeyedStore<Resource<T>>,
  key: string,
  loader: () => Promise<T>,
  opts: { force?: boolean; staleMs?: number } = {},
): Promise<void> {
  const cur = store.get(key);
  const fresh = cur?.data && Date.now() - cur.at < (opts.staleMs ?? 60_000);
  if (!opts.force && (fresh || (cur?.loading && cur.at > 0))) return Promise.resolve();
  return once(`res:${key}`, async () => {
    const prev = store.get(key);
    store.set(key, { data: prev?.data ?? null, error: null, loading: true, at: prev?.at ?? 1 });
    try {
      const data = await loader();
      store.set(key, { data, error: null, loading: false, at: Date.now() });
    } catch (err) {
      store.set(key, { data: prev?.data ?? null, error: errorMessage(err), loading: false, at: prev?.at ?? 0 });
    }
  });
}

export function bodyKey(messageId: string, images: "proxy" | "block"): string {
  return `${messageId}|${images}`;
}

export function useThread(api: MailApi, messageId: string | null): Resource<ThreadDTO> & { reload: () => void } {
  const state = useStore(threadStore, messageId, EMPTY_RESOURCE as Resource<ThreadDTO>);
  useEffect(() => {
    if (messageId) void ensure(threadStore, messageId, () => api.thread(messageId), { staleMs: 30_000 });
  }, [api, messageId]);
  const reload = useCallback(() => {
    if (messageId) void ensure(threadStore, messageId, () => api.thread(messageId), { force: true });
  }, [api, messageId]);
  return { ...state, reload };
}

export function useBody(
  api: MailApi,
  messageId: string | null,
  images: "proxy" | "block",
): Resource<MessageBodyDTO> & { reload: () => void } {
  const key = messageId ? bodyKey(messageId, images) : null;
  const state = useStore(bodyStore, key, EMPTY_RESOURCE as Resource<MessageBodyDTO>);
  useEffect(() => {
    if (messageId && key) void ensure(bodyStore, key, () => api.message(messageId, images), { staleMs: 10 * 60_000 });
  }, [api, messageId, images, key]);
  const reload = useCallback(() => {
    if (messageId && key) void ensure(bodyStore, key, () => api.message(messageId, images), { force: true });
  }, [api, messageId, images, key]);
  return { ...state, reload };
}

/** Warm the caches when the pointer rests on a conversation, so opening it is instant. */
export function prefetchThread(api: MailApi, latestId: string, images: "proxy" | "block"): void {
  void ensure(threadStore, latestId, () => api.thread(latestId), { staleMs: 30_000 });
  void ensure(bodyStore, bodyKey(latestId, images), () => api.message(latestId, images), { staleMs: 10 * 60_000 });
}
