"use client";

import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import { Bold, Italic, Link2, List, ListOrdered, Quote, RemoveFormatting, Strikethrough, Underline } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Lightweight rich-text editor (contentEditable + the browser's editing
 * commands). Pasted HTML is reduced to basic formatting here; the server
 * sanitises again before anything is sent.
 */

export type RichEditorHandle = {
  html: () => string;
  focus: () => void;
  isEmpty: () => boolean;
};

const KEEP = new Set(["B", "STRONG", "I", "EM", "U", "S", "STRIKE", "A", "P", "BR", "DIV", "UL", "OL", "LI", "BLOCKQUOTE", "H1", "H2", "H3", "PRE", "CODE"]);
const DROP = new Set(["SCRIPT", "STYLE", "META", "TITLE", "HEAD", "LINK", "IFRAME", "OBJECT", "EMBED", "TEMPLATE", "SVG", "MATH", "FORM", "INPUT", "BUTTON", "SELECT", "TEXTAREA"]);

/** Pasted HTML → basic formatting only (no styles, classes, scripts, images from elsewhere). */
export function cleanPastedHtml(html: string): string {
  const src = new DOMParser().parseFromString(html, "text/html");
  const out = document.createElement("div");
  const copy = (node: Node, into: Node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        into.appendChild(document.createTextNode(child.textContent ?? ""));
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as Element;
      if (DROP.has(el.tagName)) continue;
      if (KEEP.has(el.tagName)) {
        const clone = document.createElement(el.tagName.toLowerCase());
        if (el.tagName === "A") {
          const href = el.getAttribute("href") ?? "";
          if (/^(https?:|mailto:)/i.test(href)) clone.setAttribute("href", href);
        }
        into.appendChild(clone);
        copy(el, clone);
      } else copy(el, into); // unwrap unknown wrappers (span, font, table cells…)
    }
  };
  copy(src.body, out);
  return out.innerHTML;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

const INLINE_IMAGE = /^image\/(png|jpe?g|gif|webp)$/;
const MAX_INLINE_IMAGE = 3 * 1024 * 1024;

type Tool = { label: string; icon: ReactNode; command: string; value?: string };

const TOOLS: Tool[] = [
  { label: "Bold (Ctrl+B)", icon: <Bold />, command: "bold" },
  { label: "Italic (Ctrl+I)", icon: <Italic />, command: "italic" },
  { label: "Underline (Ctrl+U)", icon: <Underline />, command: "underline" },
  { label: "Strikethrough", icon: <Strikethrough />, command: "strikeThrough" },
  { label: "Bulleted list", icon: <List />, command: "insertUnorderedList" },
  { label: "Numbered list", icon: <ListOrdered />, command: "insertOrderedList" },
  { label: "Quote", icon: <Quote />, command: "formatBlock", value: "blockquote" },
  { label: "Link", icon: <Link2 />, command: "link" },
  { label: "Clear formatting", icon: <RemoveFormatting />, command: "removeFormat" },
];

export function RichEditor({
  ref,
  initialHtml,
  placeholder,
  onChange,
  onFiles,
  showToolbar,
  className,
  footer,
}: {
  ref?: Ref<RichEditorHandle>;
  initialHtml: string;
  placeholder?: string;
  onChange: () => void;
  /** Non-image files dropped or pasted into the editor become attachments. */
  onFiles: (files: File[]) => void;
  showToolbar: boolean;
  className?: string;
  footer?: ReactNode;
}) {
  const el = useRef<HTMLDivElement>(null);
  const saved = useRef<Range | null>(null);
  const [linking, setLinking] = useState(false);
  const [url, setUrl] = useState("");
  const [empty, setEmpty] = useState(!initialHtml);

  useEffect(() => {
    if (el.current) el.current.innerHTML = initialHtml;
    // Only the first value seeds the editor; afterwards the DOM is the source of truth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isEmpty = () => {
    const node = el.current;
    return !node || ((node.textContent ?? "").trim() === "" && !node.querySelector("img"));
  };

  useImperativeHandle(ref, () => ({
    html: () => el.current?.innerHTML ?? "",
    focus: () => el.current?.focus(),
    isEmpty,
  }));

  const changed = () => {
    setEmpty(isEmpty());
    onChange();
  };

  const exec = (command: string, value?: string) => {
    el.current?.focus();
    if (saved.current) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(saved.current);
    }
    document.execCommand(command, false, value);
    changed();
  };

  const remember = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && el.current?.contains(sel.anchorNode)) saved.current = sel.getRangeAt(0).cloneRange();
  };

  const takeFiles = async (files: File[]) => {
    const images = files.filter((f) => INLINE_IMAGE.test(f.type) && f.size <= MAX_INLINE_IMAGE);
    const others = files.filter((f) => !images.includes(f));
    for (const img of images) {
      const dataUrl = await readAsDataUrl(img);
      el.current?.focus();
      document.execCommand("insertHTML", false, `<img src="${dataUrl}" alt="" style="max-width:100%">`);
    }
    if (images.length) changed();
    if (others.length) onFiles(others);
  };

  const runTool = (t: Tool) => {
    if (t.command === "link") {
      remember();
      setLinking(true);
    } else exec(t.command, t.value);
  };

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="relative min-h-0 flex-1">
        {empty ? (
          <p className="pointer-events-none absolute top-3 left-4 text-[15px] text-muted-foreground md:text-sm" aria-hidden="true">
            {placeholder}
          </p>
        ) : null}
        <div
          ref={el}
          role="textbox"
          aria-multiline="true"
          aria-label="Message"
          contentEditable
          suppressContentEditableWarning
          onInput={changed}
          onBlur={remember}
          onKeyUp={remember}
          onMouseUp={remember}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length) {
              e.preventDefault();
              void takeFiles(files);
              return;
            }
            const html = e.clipboardData.getData("text/html");
            if (html) {
              e.preventDefault();
              document.execCommand("insertHTML", false, cleanPastedHtml(html));
              changed();
            }
          }}
          onDrop={(e) => {
            const files = [...e.dataTransfer.files];
            if (files.length) {
              e.preventDefault();
              void takeFiles(files);
            }
          }}
          className="h-full min-h-40 overflow-y-auto px-4 py-3 text-[15px] leading-relaxed outline-none md:text-sm [&_a]:text-brand [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_img]:my-1 [&_img]:max-w-full [&_img]:rounded-md [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6"
        />
      </div>
      {footer}
      {showToolbar ? (
        <div className="flex flex-wrap items-center gap-0.5 border-t px-2 py-1" onMouseDown={(e) => !linking && e.preventDefault()}>
          {linking ? (
            <form
              className="flex w-full items-center gap-2 py-0.5"
              onSubmit={(e) => {
                e.preventDefault();
                const value = url.trim();
                setLinking(false);
                setUrl("");
                if (value) exec("createLink", /^(https?:|mailto:)/i.test(value) ? value : `https://${value}`);
              }}
            >
              <input
                autoFocus
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="Paste or type a link"
                className="h-8 flex-1 rounded-lg border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-brand/40"
              />
              <button type="submit" className="h-8 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground">
                Add link
              </button>
              <button type="button" onClick={() => setLinking(false)} className="h-8 rounded-lg px-2 text-xs text-muted-foreground hover:bg-muted">
                Cancel
              </button>
            </form>
          ) : (
            TOOLS.map((t) => (
              <button
                key={t.label}
                type="button"
                title={t.label}
                aria-label={t.label}
                onClick={() => runTool(t)}
                className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground md:size-8 [&_svg]:size-4"
              >
                {t.icon}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
