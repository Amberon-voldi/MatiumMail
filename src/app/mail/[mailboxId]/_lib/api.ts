import type {
  ActionOp,
  ComposeContextDTO,
  ContactDTO,
  FolderDTO,
  MailPreferences,
  MessageBodyDTO,
  SendRequest,
  ThreadDTO,
  ThreadPageDTO,
  UploadDTO,
} from "@/lib/mail-types";
import type { SyncResult } from "@/server/mail/sync";

/**
 * Browser side of the mail API. Reads retry on network errors and 502/503/504
 * with backoff (flaky mobile connections, a mail server that was briefly slow);
 * writes never retry automatically. A 401 sends the user to sign in.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Options = Omit<RequestInit, "body"> & { body?: unknown; retries?: number; timeoutMs?: number; raw?: boolean };

const RETRYABLE = new Set([502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withTimeout(signal: AbortSignal | null | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : signal;
}

export async function api<T>(path: string, opts: Options = {}): Promise<T> {
  const method = (opts.method ?? "GET").toUpperCase();
  const retries = opts.retries ?? (method === "GET" ? 2 : 0);
  const isBinary = opts.body instanceof Blob || opts.body instanceof ArrayBuffer || ArrayBuffer.isView(opts.body);
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(path, {
        ...opts,
        method,
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          ...(opts.body !== undefined && !isBinary ? { "content-type": "application/json" } : {}),
          ...(opts.headers as Record<string, string> | undefined),
        },
        body: opts.body === undefined ? undefined : isBinary ? (opts.body as BodyInit) : JSON.stringify(opts.body),
        signal: withTimeout(opts.signal, opts.timeoutMs ?? 30_000),
      });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      if (attempt < retries) {
        await sleep(600 * 2 ** attempt);
        continue;
      }
      const offline = typeof navigator !== "undefined" && !navigator.onLine;
      const timedOut = (err as Error)?.name === "TimeoutError";
      throw new ApiError(
        offline
          ? "You're offline. Check your connection."
          : timedOut
            ? "The mail server is taking too long. Please try again."
            : "Couldn't reach Matium Mail. Check your connection and try again.",
        0,
        offline ? "offline" : "network",
      );
    }
    if (res.ok) {
      if (opts.raw) return res as T;
      return (await res.json().catch(() => ({}))) as T;
    }
    const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
    if (res.status === 401) {
      // The session ended: a full page load clears every in-memory cache along with it.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/login");
      throw new ApiError(body?.error ?? "Please sign in again.", 401, "unauthenticated");
    }
    if (RETRYABLE.has(res.status) && attempt < retries) {
      await sleep(800 * 2 ** attempt);
      continue;
    }
    throw new ApiError(body?.error ?? `Request failed (${res.status}).`, res.status, body?.code);
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.name !== "AbortError") return err.message;
  return "Something went wrong. Please try again.";
}

export type ThreadQuery = { folder?: string; q?: string; cursor?: string | null; all?: boolean; conv?: boolean };

export function mailApi(mailboxId: string) {
  const base = `/api/mail/${mailboxId}`;
  const qs = (params: Record<string, string | undefined | null | false>) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
    const s = sp.toString();
    return s ? `?${s}` : "";
  };
  return {
    base,
    folders: () => api<{ folders: FolderDTO[] }>(`${base}/folders`),
    threads: (q: ThreadQuery, signal?: AbortSignal) =>
      api<ThreadPageDTO>(
        `${base}/threads${qs({
          folder: q.folder,
          q: q.q,
          cursor: q.cursor,
          all: q.all ? "1" : null,
          conv: q.conv === false ? "0" : null,
        })}`,
        { signal },
      ),
    thread: (messageId: string, signal?: AbortSignal) => api<ThreadDTO>(`${base}/threads/${messageId}`, { signal }),
    message: (messageId: string, images: "proxy" | "block", signal?: AbortSignal) =>
      api<MessageBodyDTO>(`${base}/messages/${messageId}${images === "block" ? "?images=block" : ""}`, { signal, timeoutMs: 45_000 }),
    attachmentUrl: (messageId: string, part: string, opts: { download?: boolean; chunk?: number } = {}) =>
      `${base}/messages/${messageId}/attachments/${encodeURIComponent(part)}${qs({
        download: opts.download ? "1" : null,
        chunk: opts.chunk !== undefined ? String(opts.chunk) : null,
      })}`,
    compose: (mode: "reply" | "replyAll" | "forward" | "draft", source: string) =>
      api<ComposeContextDTO>(`${base}/compose${qs({ mode, source })}`, { timeoutMs: 45_000 }),
    contacts: (q: string, signal?: AbortSignal) => api<{ contacts: ContactDTO[] }>(`${base}/contacts${qs({ q })}`, { signal, retries: 0 }),
    sync: (scope: string) =>
      api<{ result: SyncResult; folders: FolderDTO[] }>(`${base}/sync`, { method: "POST", body: { scope }, timeoutMs: 45_000 }),
    backfill: (folderId: string) =>
      api<{ added: number; remaining: number }>(`${base}/folders/${folderId}/backfill`, { method: "POST", timeoutMs: 45_000 }),
    action: (op: ActionOp) => api<{ ok: boolean; count: number }>(`${base}/actions`, { method: "POST", body: op, timeoutMs: 45_000 }),
    createUpload: (file: { filename: string; contentType: string; size: number }) =>
      api<UploadDTO>(`${base}/uploads`, { method: "POST", body: file }),
    putChunk: (uploadId: string, seq: number, data: Blob) =>
      api<{ ok: boolean }>(`${base}/uploads/${uploadId}?seq=${seq}`, { method: "PUT", body: data, retries: 2, timeoutMs: 60_000 }),
    deleteUpload: (uploadId: string) => api<{ ok: boolean }>(`${base}/uploads/${uploadId}`, { method: "DELETE" }),
    // MilesWeb's SMTP greets after ~23 s; give sending plenty of time.
    send: (req: SendRequest) =>
      api<{ ok: boolean; messageId: string; savedToSent: boolean }>(`${base}/send`, { method: "POST", body: req, timeoutMs: 150_000 }),
    saveDraft: (req: SendRequest) => api<{ saved: boolean }>(`${base}/drafts`, { method: "POST", body: req, timeoutMs: 60_000 }),
    discardDraft: (key: string, uploads: string[]) =>
      api<{ ok: boolean }>(`${base}/drafts${qs({ key, uploads: uploads.join(",") })}`, { method: "DELETE" }),
    savePreferences: (patch: Partial<MailPreferences>) =>
      api<MailPreferences>(`${base}/preferences`, { method: "PATCH", body: patch }),
  };
}

export type MailApi = ReturnType<typeof mailApi>;
