"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import type { ContactDTO } from "@/lib/mail-types";
import { cn } from "@/lib/utils";
import { displayName, isValidAddress, parseAddress } from "../_lib/format";
import { Avatar } from "./bits";
import { useMail } from "./mail-context";

/**
 * Address entry as chips, with autocomplete from contacts and past senders.
 * Commas, semicolons, Enter, Tab and pasting a list all create chips.
 */
export function RecipientField({
  label,
  value,
  onChange,
  autoFocus,
  trailing,
}: {
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  autoFocus?: boolean;
  trailing?: ReactNode;
}) {
  const { api } = useMail();
  const [text, setText] = useState("");
  const textRef = useRef("");
  const [found, setFound] = useState<{ q: string; contacts: ContactDTO[] }>({ q: "", contacts: [] });
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const setTextBoth = (t: string) => {
    textRef.current = t;
    setText(t);
  };

  const query = text.trim();
  useEffect(() => {
    if (query.length < 1 || /[,;]/.test(query)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api
        .contacts(query, controller.signal)
        .then((r) => {
          setFound({ q: query, contacts: r.contacts });
          setActive(0);
        })
        .catch(() => {});
    }, 140);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, query]);

  const taken = new Set(value.map((v) => parseAddress(v)?.address ?? v.toLowerCase()));
  const suggestions = query && found.q === query ? found.contacts.filter((c) => !taken.has(c.address)) : [];

  const add = (raw: string[]) => {
    const next = [...value];
    for (const r of raw.map((s) => s.trim()).filter(Boolean)) {
      const key = parseAddress(r)?.address ?? r.toLowerCase();
      if (!next.some((v) => (parseAddress(v)?.address ?? v.toLowerCase()) === key)) next.push(r);
    }
    onChange(next);
    setTextBoth("");
  };

  const pick = (c: ContactDTO) => add([c.name ? `${c.name} <${c.address}>` : c.address]);

  const commitText = () => {
    if (textRef.current.trim()) add(textRef.current.split(/[,;\n]+/));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (suggestions.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setActive((i) => (i + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
      return;
    }
    if ((e.key === "Enter" || e.key === "Tab") && suggestions.length) {
      e.preventDefault();
      pick(suggestions[Math.min(active, suggestions.length - 1)]);
      return;
    }
    if (e.key === "Enter" || e.key === "," || e.key === ";") {
      if (text.trim()) {
        e.preventDefault();
        commitText();
      }
      return;
    }
    if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1));
    if (e.key === "Escape" && suggestions.length) {
      e.stopPropagation();
      setFound({ q: "", contacts: [] });
    }
  };

  return (
    <div className="relative flex items-start gap-2 border-b px-4 py-1.5" onClick={() => inputRef.current?.focus()}>
      <label htmlFor={`${listId}-input`} className="w-8 shrink-0 pt-1.5 text-sm text-muted-foreground">
        {label}
      </label>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {value.map((v, i) => {
          const ok = isValidAddress(v);
          const a = parseAddress(v);
          return (
            <span
              key={`${v}-${i}`}
              title={v}
              className={cn(
                "inline-flex max-w-full items-center gap-1 rounded-full border py-0.5 pr-1 pl-2 text-[13px]",
                ok ? "bg-muted/60" : "border-destructive/40 bg-destructive/10 text-destructive",
              )}
            >
              <span className="truncate">{a ? displayName(a) : v}</span>
              <button
                type="button"
                aria-label={`Remove ${v}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(value.filter((_, j) => j !== i));
                }}
                className="inline-flex size-4 items-center justify-center rounded-full hover:bg-foreground/10"
              >
                <X className="size-3" />
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          id={`${listId}-input`}
          type="email"
          inputMode="email"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          multiple
          autoFocus={autoFocus}
          value={text}
          onChange={(e) => setTextBoth(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text");
            if (/[,;\n]/.test(pasted)) {
              e.preventDefault();
              add(pasted.split(/[,;\n]+/));
            }
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            // Let a click on a suggestion land first.
            setTimeout(commitText, 150);
          }}
          role="combobox"
          aria-expanded={suggestions.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          className="h-8 min-w-24 flex-1 bg-transparent text-[15px] outline-none md:text-sm"
        />
      </div>
      {trailing}
      {focused && suggestions.length ? (
        <ul id={listId} role="listbox" className="absolute top-full right-2 left-12 z-20 mt-1 overflow-hidden rounded-xl border bg-popover p-1 shadow-lg">
          {suggestions.map((c, i) => (
            <li
              key={c.address}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(c);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn("flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5", i === active && "bg-muted")}
            >
              <Avatar addr={c} className="size-7 text-[11px]" />
              <span className="min-w-0">
                <span className="block truncate text-sm">{c.name || c.address}</span>
                {c.name ? <span className="block truncate text-xs text-muted-foreground">{c.address}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
