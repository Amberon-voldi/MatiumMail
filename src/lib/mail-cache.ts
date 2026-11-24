/**
 * On-device copy of recently seen mail (IndexedDB), so the app opens straight
 * into the inbox and recently read messages show instantly — even right after
 * launch, before the network answers — the way a native mail app does.
 *
 * Everything here is best-effort: private windows, blocked storage or a full
 * disk just mean nothing is remembered. Entries are tagged with their mailbox
 * so signing an account out can forget exactly its mail (forgetMailboxesExcept),
 * and signing out of everything forgets all of it (forgetAllMail).
 */

type Kind = "list" | "thread" | "body";
type Entry = { k: string; mailbox: string; kind: Kind; savedAt: number; value: unknown };

const DB_NAME = "matium-mail";
const STORE = "entries";
/** Per mailbox and kind; the oldest are dropped first. */
const KEEP: Record<Kind, number> = { list: 40, thread: 300, body: 300 };
/** Bodies with large inline images aren't worth the space. */
const MAX_BODY_CHARS = 400_000;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  dbPromise ??= new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: "k" });
        store.createIndex("mailbox", "mailbox");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

const entryKey = (kind: Kind, key: string) => `${kind}:${key}`;

/** A saved value and when it was saved, or null. */
export async function readSaved<T>(kind: Kind, key: string): Promise<{ value: T; savedAt: number } | null> {
  const pendingEntry = pending.get(entryKey(kind, key));
  if (pendingEntry) return { value: pendingEntry.value as T, savedAt: pendingEntry.savedAt };
  const db = await open();
  if (!db) return null;
  try {
    return await new Promise((resolve) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(entryKey(kind, key));
      req.onsuccess = () => {
        const e = req.result as Entry | undefined;
        resolve(e ? { value: e.value as T, savedAt: e.savedAt } : null);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

// Writes are batched into one transaction shortly after they happen.
const pending = new Map<string, Entry>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const touched = new Set<string>();

export function save(mailbox: string, kind: Kind, key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  if (kind === "body" && JSON.stringify(value).length > MAX_BODY_CHARS) return;
  const k = entryKey(kind, key);
  pending.set(k, { k, mailbox, kind, savedAt: Date.now(), value });
  touched.add(`${mailbox}|${kind}`);
  flushTimer ??= setTimeout(() => void flush(), 400);
}

async function flush(): Promise<void> {
  flushTimer = null;
  const batch = [...pending.values()];
  pending.clear();
  const db = await open();
  if (!db || batch.length === 0) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const e of batch) store.put(e);
    await done(tx);
  } catch {
    return;
  }
  const groups = [...touched];
  touched.clear();
  for (const g of groups) {
    const [mailbox, kind] = g.split("|") as [string, Kind];
    await prune(db, mailbox, kind);
  }
}

/** Keep only the newest KEEP[kind] entries of one kind for a mailbox. */
async function prune(db: IDBDatabase, mailbox: string, kind: Kind): Promise<void> {
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.index("mailbox").getAll(IDBKeyRange.only(mailbox));
    req.onsuccess = () => {
      const mine = (req.result as Entry[]).filter((e) => e.kind === kind);
      if (mine.length <= KEEP[kind]) return;
      mine.sort((a, b) => b.savedAt - a.savedAt);
      for (const e of mine.slice(KEEP[kind])) store.delete(e.k);
    };
    await done(tx);
  } catch {
    // best effort
  }
}

/** Forget every mailbox not in `keep` (accounts signed out of this browser). */
export async function forgetMailboxesExcept(keep: readonly string[]): Promise<void> {
  const db = await open();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const allowed = new Set(keep);
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      if (!allowed.has((cursor.value as Entry).mailbox)) cursor.delete();
      cursor.continue();
    };
    await done(tx);
  } catch {
    // best effort
  }
}

/** Forget all saved mail (signed out of everything). */
export async function forgetAllMail(): Promise<void> {
  pending.clear();
  const db = await open();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    await done(tx);
  } catch {
    // best effort
  }
}
