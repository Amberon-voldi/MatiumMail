"use client";

import { useState } from "react";
import { Download, File, FileArchive, FileImage, FileSpreadsheet, FileText, Loader2, Paperclip } from "lucide-react";
import { toast } from "sonner";
import type { AttachmentDTO } from "@/lib/mail-types";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { errorMessage } from "../_lib/api";
import { fetchAttachment, PREVIEWABLE, saveBlob } from "../_lib/files";
import { formatBytes } from "../_lib/format";
import { useMail } from "./mail-context";

export function fileIcon(type: string, name: string) {
  if (type.startsWith("image/")) return FileImage;
  if (type === "application/pdf" || /\.(pdf|docx?|txt|rtf|odt)$/i.test(name)) return FileText;
  if (/zip|compressed|tar|rar|7z/.test(type) || /\.(zip|rar|7z|gz|tgz)$/i.test(name)) return FileArchive;
  if (/sheet|excel|csv/.test(type) || /\.(xlsx?|csv|ods)$/i.test(name)) return FileSpreadsheet;
  return File;
}

const IMAGE = /^image\/(png|jpe?g|gif|webp)$/;

/** Attachments of a received message: thumbnails for pictures, cards for files; open or download. */
export function AttachmentList({ messageId, attachments }: { messageId: string; attachments: AttachmentDTO[] }) {
  const { api } = useMail();
  const [busy, setBusy] = useState<Record<string, number>>({});
  const [viewing, setViewing] = useState<AttachmentDTO | null>(null);
  if (attachments.length === 0) return null;

  const download = async (a: AttachmentDTO) => {
    if (busy[a.part] !== undefined) return;
    setBusy((b) => ({ ...b, [a.part]: 0 }));
    try {
      const blob = await fetchAttachment(api, messageId, a, (f) => setBusy((b) => ({ ...b, [a.part]: f })));
      saveBlob(blob, a.filename);
    } catch (err) {
      toast.error(`Couldn't download ${a.filename}`, { description: errorMessage(err) });
    } finally {
      setBusy((b) => {
        const rest = { ...b };
        delete rest[a.part];
        return rest;
      });
    }
  };

  const images = attachments.filter((a) => IMAGE.test(a.contentType) && !a.chunked);
  const files = attachments.filter((a) => !images.includes(a));
  const total = attachments.reduce((n, a) => n + a.size, 0);

  return (
    <section aria-label="Attachments" className="mt-4 border-t pt-4">
      <p className="mb-3 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Paperclip className="size-3.5" aria-hidden="true" />
        {attachments.length} attachment{attachments.length === 1 ? "" : "s"} · {formatBytes(total)}
      </p>
      {images.length ? (
        <ul className="mb-3 flex flex-wrap gap-2">
          {images.map((a) => (
            <li key={a.part}>
              <button
                type="button"
                onClick={() => setViewing(a)}
                className="group relative block size-28 overflow-hidden rounded-xl border bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none sm:size-32"
                title={`${a.filename} · ${formatBytes(a.size)}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- authenticated, same-origin attachment */}
                <img
                  src={api.attachmentUrl(messageId, a.part)}
                  alt={a.filename}
                  loading="lazy"
                  className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
                />
                <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/70 to-transparent px-2 pt-4 pb-1.5 text-left text-[11px] font-medium text-white">
                  {a.filename}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {files.length ? (
        <ul className="grid gap-2 sm:grid-cols-2">
          {files.map((a) => {
            const Icon = fileIcon(a.contentType, a.filename);
            const progress = busy[a.part];
            const previewable = PREVIEWABLE.has(a.contentType) && !a.chunked;
            return (
              <li key={a.part} className="flex min-w-0 items-center gap-3 rounded-xl border bg-card p-2.5 pr-1.5 transition-[transform,box-shadow] duration-200 hover:shadow-md motion-safe:hover:-translate-y-0.5">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
                  <Icon className="size-5" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  {previewable ? (
                    <a
                      href={api.attachmentUrl(messageId, a.part)}
                      target="_blank"
                      rel="noopener"
                      className="block truncate text-sm font-medium hover:underline"
                      title={`Open ${a.filename}`}
                    >
                      {a.filename}
                    </a>
                  ) : (
                    <span className="block truncate text-sm font-medium" title={a.filename}>
                      {a.filename}
                    </span>
                  )}
                  <span className="block text-xs text-muted-foreground">
                    {progress !== undefined && a.chunked ? `Downloading… ${Math.round(progress * 100)}%` : formatBytes(a.size)}
                  </span>
                </span>
                {a.chunked ? (
                  <button
                    type="button"
                    onClick={() => void download(a)}
                    disabled={progress !== undefined}
                    className="inline-flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-60 md:size-8 md:rounded-lg"
                    aria-label={`Download ${a.filename}`}
                    title="Download"
                  >
                    {progress !== undefined ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                  </button>
                ) : (
                  <a
                    href={api.attachmentUrl(messageId, a.part, { download: true })}
                    download={a.filename}
                    className="inline-flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground md:size-8 md:rounded-lg"
                    aria-label={`Download ${a.filename}`}
                    title="Download"
                  >
                    <Download className="size-4" />
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      <Dialog open={viewing !== null} onOpenChange={(open) => !open && setViewing(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogTitle className="truncate">{viewing?.filename}</DialogTitle>
          {viewing ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element -- authenticated, same-origin attachment */}
              <img
                src={api.attachmentUrl(messageId, viewing.part)}
                alt={viewing.filename}
                className="max-h-[70dvh] w-full rounded-lg bg-muted/40 object-contain"
              />
              <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
                <span>{formatBytes(viewing.size)}</span>
                <a
                  href={api.attachmentUrl(messageId, viewing.part, { download: true })}
                  download={viewing.filename}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/85"
                >
                  <Download className="size-4" aria-hidden="true" /> Download
                </a>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}
