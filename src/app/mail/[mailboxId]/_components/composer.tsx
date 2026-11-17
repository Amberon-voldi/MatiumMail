"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowLeft, ChevronUp, Loader2, Maximize2, Minimize2, Minus, MoreHorizontal, Paperclip, Send, Trash2, Type, X } from "lucide-react";
import { toast } from "sonner";
import { MAX_ATTACHMENTS_BYTES, type AttachmentDTO, type ComposeContextDTO, type SendRequest } from "@/lib/mail-types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { errorMessage } from "../_lib/api";
import { uploadFile } from "../_lib/files";
import { formatBytes, isValidAddress } from "../_lib/format";
import { staleLists, useBody } from "../_lib/store";
import { fileIcon } from "./attachments";
import { EmailFrame } from "./email-frame";
import { useMail, type ComposerInit, type SavedCompose } from "./mail-context";
import { RecipientField } from "./recipient-field";
import { RichEditor, type RichEditorHandle } from "./rich-editor";

type Upload = {
  localId: string;
  name: string;
  size: number;
  type: string;
  progress: number;
  uploadId: string | null;
  error: string | null;
  controller: AbortController;
};

export const composeStorageKey = (mailboxId: string) => `mm:compose:${mailboxId}`;

/** Content of a composer that was open when the page was closed or crashed (kept a week). */
export function savedComposeFor(mailboxId: string): SavedCompose | null {
  try {
    const raw = localStorage.getItem(composeStorageKey(mailboxId));
    const s = raw ? (JSON.parse(raw) as SavedCompose) : null;
    return s && Date.now() - s.savedAt < 7 * 86_400_000 ? s : null;
  } catch {
    return null;
  }
}

export function clearSavedCompose(mailboxId: string) {
  try {
    localStorage.removeItem(composeStorageKey(mailboxId));
  } catch {
    /* storage unavailable */
  }
}

const TITLES: Record<string, string> = { new: "New message", reply: "Reply", replyAll: "Reply all", forward: "Forward", draft: "Draft" };

export function Composer({ init, onClose }: { init: ComposerInit; onClose: () => void }) {
  const mail = useMail();
  const { api, mailbox } = mail;
  const needsContext = init.mode !== "new" && Boolean(init.sourceId);
  const [ctx, setCtx] = useState<ComposeContextDTO | null>(null);
  const [ctxError, setCtxError] = useState<string | null>(null);
  const [to, setToState] = useState<string[]>(init.restore?.to ?? init.to ?? []);
  const [cc, setCcState] = useState<string[]>(init.restore?.cc ?? []);
  const [bcc, setBccState] = useState<string[]>(init.restore?.bcc ?? []);
  const [subject, setSubject] = useState(init.restore?.subject ?? init.subject ?? "");
  const [showCc, setShowCc] = useState(Boolean(init.restore?.cc.length || init.restore?.bcc.length));
  const [includeQuote, setIncludeQuote] = useState(true);
  const [showQuote, setShowQuote] = useState(false);
  const [forwarded, setForwarded] = useState<AttachmentDTO[]>([]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [toolbar, setToolbar] = useState(false);
  const [draftKey] = useState(() => crypto.randomUUID());
  const editor = useRef<RichEditorHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const fields = useRef({ to, cc, bcc, subject });
  const dirty = useRef(false);
  const savedToServer = useRef(false);
  const localTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Reply / forward / draft: recipients, subject and the quote come from the server.
  useEffect(() => {
    if (!needsContext) return;
    let cancelled = false;
    api
      .compose(init.mode as "reply" | "replyAll" | "forward" | "draft", init.sourceId!)
      .then((c) => {
        if (cancelled) return;
        setCtx(c);
        if (!init.restore) {
          fields.current = { to: c.to, cc: c.cc, bcc: c.bcc, subject: c.subject };
          setToState(c.to);
          setCcState(c.cc);
          setBccState(c.bcc);
          setSubject(c.subject);
          if (c.cc.length || c.bcc.length) setShowCc(true);
        }
        setForwarded(c.attachments);
      })
      .catch((err) => {
        if (!cancelled) setCtxError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [api, needsContext, init.mode, init.sourceId, init.restore]);

  /** Local safety copy, a moment after every change. */
  const touch = useCallback(() => {
    dirty.current = true;
    clearTimeout(localTimer.current);
    localTimer.current = setTimeout(() => {
      const saved: SavedCompose = {
        mode: init.mode,
        sourceId: init.sourceId ?? null,
        ...fields.current,
        html: editor.current?.html() ?? "",
        savedAt: Date.now(),
      };
      try {
        localStorage.setItem(composeStorageKey(mailbox.id), JSON.stringify(saved));
      } catch {
        /* storage full or blocked: the server draft still covers it */
      }
    }, 600);
  }, [init.mode, init.sourceId, mailbox.id]);

  const onTo = (v: string[]) => {
    fields.current.to = v;
    setToState(v);
    touch();
  };
  const onCc = (v: string[]) => {
    fields.current.cc = v;
    setCcState(v);
    touch();
  };
  const onBcc = (v: string[]) => {
    fields.current.bcc = v;
    setBccState(v);
    touch();
  };

  const request = useCallback(
    (): SendRequest => ({
      mode: init.mode,
      sourceId: init.sourceId ?? null,
      draftKey,
      to: fields.current.to,
      cc: fields.current.cc,
      bcc: fields.current.bcc,
      subject: fields.current.subject,
      html: editor.current?.html() ?? "",
      includeQuote,
      forwardParts: forwarded.map((a) => a.part),
      uploadIds: uploads.filter((u) => u.uploadId).map((u) => u.uploadId!),
    }),
    [init.mode, init.sourceId, draftKey, includeQuote, forwarded, uploads],
  );

  const hasContent = useCallback(
    () =>
      fields.current.to.length + fields.current.cc.length + fields.current.bcc.length > 0 ||
      fields.current.subject.trim() !== "" ||
      !(editor.current?.isEmpty() ?? true) ||
      uploads.length > 0,
    [uploads.length],
  );

  // Server draft every minute while there are unsaved changes.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!dirty.current || sending || !hasContent()) return;
      dirty.current = false;
      api
        .saveDraft(request())
        .then(() => {
          savedToServer.current = true;
        })
        .catch(() => {
          dirty.current = true;
        });
    }, 60_000);
    return () => clearInterval(timer);
  }, [api, request, sending, hasContent]);

  const addFiles = (files: File[]) => {
    const current = uploads.reduce((n, u) => n + u.size, 0) + forwarded.reduce((n, a) => n + a.size, 0);
    const incoming = files.reduce((n, f) => n + f.size, 0);
    if (current + incoming > MAX_ATTACHMENTS_BYTES) {
      toast.error(`Attachments can be up to ${Math.round(MAX_ATTACHMENTS_BYTES / 1024 / 1024)} MB in total.`);
      return;
    }
    touch();
    for (const file of files) {
      const item: Upload = {
        localId: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        type: file.type,
        progress: 0,
        uploadId: null,
        error: null,
        controller: new AbortController(),
      };
      setUploads((u) => [...u, item]);
      const update = (patch: Partial<Upload>) =>
        setUploads((list) => list.map((u) => (u.localId === item.localId ? { ...u, ...patch } : u)));
      uploadFile(api, file, (progress) => update({ progress }), item.controller.signal)
        .then((up) => update({ uploadId: up.id, progress: 1 }))
        .catch((err) => {
          if ((err as Error).name !== "AbortError") update({ error: errorMessage(err) });
        });
    }
  };

  const removeUpload = (u: Upload) => {
    u.controller.abort();
    if (u.uploadId) void api.deleteUpload(u.uploadId).catch(() => {});
    setUploads((list) => list.filter((x) => x.localId !== u.localId));
    touch();
  };

  const send = async () => {
    // Let a recipient still being typed turn into a chip first.
    (document.activeElement as HTMLElement | null)?.blur?.();
    await new Promise((r) => setTimeout(r, 200));
    const all = [...fields.current.to, ...fields.current.cc, ...fields.current.bcc];
    if (all.length === 0) return setError("Add at least one recipient.");
    const bad = all.find((a) => !isValidAddress(a));
    if (bad) return setError(`“${bad}” isn't a valid email address.`);
    if (uploads.some((u) => !u.uploadId && !u.error)) return setError("Wait for attachments to finish uploading.");
    if (uploads.some((u) => u.error)) return setError("Remove the attachments that failed to upload, or attach them again.");
    if (needsContext && !ctx) return setError("Still loading the original message…");

    const req = request();
    setError(null);
    setSending(true);
    setMinimized(true);
    const id = toast.loading("Sending…", { description: "The mail server can take up to half a minute." });
    try {
      const res = await api.send(req);
      toast.success("Message sent", {
        id,
        description: res.savedToSent ? undefined : "Sent, but it couldn't be copied to your Sent folder.",
      });
      clearSavedCompose(mailbox.id);
      staleLists(mailbox.id);
      void mail.syncNow("all");
      onClose();
    } catch (err) {
      toast.error("Not sent", { id, description: errorMessage(err) });
      setError(errorMessage(err));
      setSending(false);
      setMinimized(false);
    }
  };

  const close = () => {
    if (sending) return;
    clearTimeout(localTimer.current);
    if (hasContent() && (dirty.current || !savedToServer.current)) {
      void api
        .saveDraft(request())
        .then(() => {
          toast.success("Draft saved");
          clearSavedCompose(mailbox.id);
          staleLists(mailbox.id);
        })
        .catch((err) => toast.error("Couldn't save the draft", { description: `${errorMessage(err)} It's kept on this device.` }));
    } else clearSavedCompose(mailbox.id);
    onClose();
  };

  const discard = () => {
    clearTimeout(localTimer.current);
    uploads.forEach((u) => u.controller.abort());
    const ids = uploads.filter((u) => u.uploadId).map((u) => u.uploadId!);
    if (savedToServer.current || ids.length) void api.discardDraft(draftKey, ids).catch(() => {});
    clearSavedCompose(mailbox.id);
    onClose();
    toast("Draft discarded");
  };

  const quoteBody = useBody(api, showQuote && init.sourceId ? init.sourceId : null, "block");
  const title = subject.trim() || TITLES[init.mode] || "New message";
  const quoting = (init.mode === "reply" || init.mode === "replyAll" || init.mode === "forward") && ctx?.quoteLabel;
  const ready = !needsContext || ctx !== null || init.restore !== undefined;

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void send();
    } else if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      close();
    }
  };

  return (
    <section
      role="dialog"
      aria-label={title}
      onKeyDown={onKeyDown}
      className={cn(
        "fixed z-40 flex animate-in flex-col overflow-hidden border bg-background shadow-2xl fade-in-0 slide-in-from-bottom-4",
        // Phones: full screen. Desktop: docked window, minimised bar, or large window.
        "inset-0 md:inset-auto",
        minimized
          ? "max-md:top-auto max-md:h-14 md:right-6 md:bottom-0 md:h-12 md:w-80 md:rounded-t-xl"
          : maximized
            ? "md:top-[6dvh] md:right-[6vw] md:bottom-[6dvh] md:left-[6vw] md:rounded-2xl"
            : "md:right-6 md:bottom-0 md:h-[min(640px,calc(100dvh-5rem))] md:w-[580px] md:rounded-t-xl",
      )}
    >
      <header className="pt-safe flex shrink-0 items-center gap-1 border-b bg-background px-2 md:h-12 md:border-0 md:bg-foreground md:pt-0 md:pl-4 md:text-background">
        <button className="inline-flex size-10 items-center justify-center rounded-full md:hidden" aria-label="Save and close" onClick={close}>
          <ArrowLeft className="size-5" />
        </button>
        <button
          className="min-w-0 flex-1 truncate py-3 text-left text-[15px] font-medium md:text-sm"
          onClick={() => setMinimized((m) => !m)}
          aria-label={minimized ? "Restore" : "Minimise"}
        >
          {sending ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" /> Sending…
            </span>
          ) : (
            title
          )}
        </button>
        <div className="hidden items-center md:flex">
          <TitleButton label={minimized ? "Restore" : "Minimise"} onClick={() => setMinimized((m) => !m)}>
            {minimized ? <ChevronUp className="size-4" /> : <Minus className="size-4" />}
          </TitleButton>
          {!minimized ? (
            <TitleButton label={maximized ? "Exit full screen" : "Full screen"} onClick={() => setMaximized((m) => !m)}>
              {maximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
            </TitleButton>
          ) : null}
          <TitleButton label="Save & close (Esc)" onClick={close}>
            <X className="size-4" />
          </TitleButton>
        </div>
        {!minimized ? (
          <div className="flex items-center gap-1 md:hidden">
            <button
              className="inline-flex size-10 items-center justify-center rounded-full text-muted-foreground"
              aria-label="Attach files"
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip className="size-5" />
            </button>
            <Button
              size="sm"
              className="h-9 gap-1.5 rounded-full bg-brand px-4 text-brand-foreground hover:bg-brand/90"
              onClick={() => void send()}
              disabled={sending || !ready}
            >
              <Send className="size-4" /> Send
            </Button>
          </div>
        ) : null}
      </header>

      {!minimized ? (
        <>
          {ctxError ? (
            <p role="alert" className="border-b bg-destructive/5 px-4 py-2 text-sm text-destructive">
              {ctxError}
            </p>
          ) : null}
          {!ready ? (
            <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Preparing…
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <p className="hidden truncate border-b px-4 py-2 text-xs text-muted-foreground md:block">
                From {mailbox.displayName ? `${mailbox.displayName} <${mailbox.address}>` : mailbox.address}
              </p>
              <RecipientField
                label="To"
                value={to}
                onChange={onTo}
                autoFocus={init.mode === "new" || init.mode === "forward"}
                trailing={
                  !showCc ? (
                    <button
                      type="button"
                      className="shrink-0 pt-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                      onClick={() => setShowCc(true)}
                    >
                      Cc/Bcc
                    </button>
                  ) : null
                }
              />
              {showCc ? (
                <>
                  <RecipientField label="Cc" value={cc} onChange={onCc} />
                  <RecipientField label="Bcc" value={bcc} onChange={onBcc} />
                </>
              ) : null}
              <input
                value={subject}
                onChange={(e) => {
                  fields.current.subject = e.target.value;
                  setSubject(e.target.value);
                  touch();
                }}
                placeholder="Subject"
                aria-label="Subject"
                className="h-11 shrink-0 border-b bg-transparent px-4 text-[15px] font-medium outline-none placeholder:font-normal placeholder:text-muted-foreground md:h-10 md:text-sm"
              />

              <RichEditor
                ref={editor}
                initialHtml={init.restore?.html ?? ctx?.html ?? ""}
                placeholder={init.mode === "forward" ? "Add a message (optional)" : "Write your message…"}
                onChange={touch}
                onFiles={addFiles}
                showToolbar={toolbar}
                className="min-h-0 flex-1"
                footer={
                  <div className="shrink-0 space-y-2 px-4 pb-2">
                    {quoting ? (
                      <div className="rounded-xl border bg-muted/30">
                        <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                          <button
                            type="button"
                            className="inline-flex h-5 items-center rounded bg-muted px-1.5 hover:bg-muted-foreground/20"
                            onClick={() => setShowQuote((s) => !s)}
                            aria-label={showQuote ? "Hide quoted text" : "Show quoted text"}
                            aria-expanded={showQuote}
                          >
                            <MoreHorizontal className="size-3.5" />
                          </button>
                          <span className="min-w-0 flex-1 truncate">{ctx?.quoteLabel}</span>
                          {init.mode !== "forward" ? (
                            <label className="flex shrink-0 cursor-pointer items-center gap-1.5">
                              <input
                                type="checkbox"
                                checked={includeQuote}
                                onChange={(e) => setIncludeQuote(e.target.checked)}
                                className="accent-[var(--brand)]"
                              />
                              Include
                            </label>
                          ) : null}
                        </div>
                        {showQuote ? (
                          <div className="max-h-72 overflow-y-auto border-t bg-white">
                            {quoteBody.data ? (
                              <EmailFrame html={quoteBody.data.document} title="Quoted message" />
                            ) : (
                              <p className="p-3 text-xs text-muted-foreground">Loading…</p>
                            )}
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    {forwarded.length || uploads.length ? (
                      <ul className="flex flex-wrap gap-2">
                        {forwarded.map((a) => {
                          const Icon = fileIcon(a.contentType, a.filename);
                          return (
                            <AttachmentChip
                              key={`f-${a.part}`}
                              icon={<Icon className="size-4" />}
                              name={a.filename}
                              detail={formatBytes(a.size)}
                              onRemove={() => {
                                setForwarded((list) => list.filter((x) => x.part !== a.part));
                                touch();
                              }}
                            />
                          );
                        })}
                        {uploads.map((u) => {
                          const Icon = fileIcon(u.type, u.name);
                          return (
                            <AttachmentChip
                              key={u.localId}
                              icon={<Icon className="size-4" />}
                              name={u.name}
                              detail={u.error ? u.error : u.uploadId ? formatBytes(u.size) : `Uploading ${Math.round(u.progress * 100)}%`}
                              progress={u.uploadId || u.error ? undefined : u.progress}
                              failed={Boolean(u.error)}
                              onRemove={() => removeUpload(u)}
                            />
                          );
                        })}
                      </ul>
                    ) : null}

                    {error ? (
                      <p role="alert" className="rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                        {error}
                      </p>
                    ) : null}
                  </div>
                }
              />

              {/* Bottom bar (desktop) */}
              <div className="hidden shrink-0 items-center gap-1 border-t px-3 py-2 md:flex">
                <Button
                  className="h-9 gap-2 rounded-full bg-brand px-5 text-brand-foreground hover:bg-brand/90"
                  onClick={() => void send()}
                  disabled={sending}
                  title="Send (Ctrl+Enter)"
                >
                  <Send className="size-4" /> Send
                </Button>
                <ToolButton label="Formatting" active={toolbar} onClick={() => setToolbar((t) => !t)}>
                  <Type />
                </ToolButton>
                <ToolButton label="Attach files" onClick={() => fileInput.current?.click()}>
                  <Paperclip />
                </ToolButton>
                <div className="flex-1" />
                <ToolButton label="Discard draft" onClick={discard}>
                  <Trash2 />
                </ToolButton>
              </div>
              {/* Bottom bar (phone) */}
              <div className="pb-safe flex shrink-0 items-center gap-1 border-t px-2 py-1 md:hidden">
                <ToolButton label="Formatting" active={toolbar} onClick={() => setToolbar((t) => !t)}>
                  <Type />
                </ToolButton>
                <div className="flex-1" />
                <ToolButton label="Discard draft" onClick={discard}>
                  <Trash2 />
                </ToolButton>
              </div>
            </div>
          )}
        </>
      ) : null}

      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          addFiles([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
    </section>
  );
}

function TitleButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex size-8 items-center justify-center rounded-md text-background/70 hover:bg-background/15 hover:text-background"
    >
      {children}
    </button>
  );
}

function ToolButton({ label, onClick, active, children }: { label: string; onClick: () => void; active?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex size-10 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground md:size-9 [&_svg]:size-[18px]",
        active && "bg-muted text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function AttachmentChip({
  icon,
  name,
  detail,
  progress,
  failed,
  onRemove,
}: {
  icon: ReactNode;
  name: string;
  detail: string;
  progress?: number;
  failed?: boolean;
  onRemove: () => void;
}) {
  return (
    <li
      className={cn(
        "relative flex max-w-full min-w-0 items-center gap-2 overflow-hidden rounded-lg border bg-card py-1.5 pr-1 pl-2 text-xs sm:max-w-64",
        failed && "border-destructive/40 bg-destructive/5",
      )}
    >
      <span className={cn("shrink-0", failed ? "text-destructive" : "text-brand")}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{name}</span>
        <span className={cn("block truncate", failed ? "text-destructive" : "text-muted-foreground")}>{detail}</span>
      </span>
      <button
        type="button"
        aria-label={`Remove ${name}`}
        onClick={onRemove}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
      {progress !== undefined ? (
        <span className="absolute inset-x-0 bottom-0 h-0.5 bg-muted" aria-hidden="true">
          <span className="block h-full bg-brand transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
        </span>
      ) : null}
    </li>
  );
}
