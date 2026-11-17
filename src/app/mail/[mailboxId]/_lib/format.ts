import type { Addr } from "@/lib/mail-types";

/**
 * Display helpers. Dates use one fixed time zone (the organisation's) so the
 * server-rendered first paint and the browser agree.
 */

const TZ = "Asia/Kolkata";
const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const time = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, weekday: "short" });
const dayMonth = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, day: "numeric", month: "short" });
const short = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, day: "numeric", month: "short", year: "numeric" });
const full = new Intl.DateTimeFormat("en-IN", {
  timeZone: TZ,
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** "3:45 pm" today, "Mon" this week, "12 Nov" this year, "12 Nov 2024" before. */
export function listDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (dayKey.format(d) === dayKey.format(now)) return time.format(d);
  const days = (now.getTime() - d.getTime()) / 86_400_000;
  if (days >= 0 && days < 6) return weekday.format(d);
  return d.getFullYear() === now.getFullYear() ? dayMonth.format(d) : short.format(d);
}

export function fullDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : full.format(d);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function displayName(a: Addr | null | undefined): string {
  if (!a) return "Unknown sender";
  return a.name?.replace(/^["']|["']$/g, "").trim() || a.address || "Unknown sender";
}

export function formatAddress(a: Addr): string {
  return a.name && a.address ? `${a.name} <${a.address}>` : (a.address ?? a.name ?? "");
}

export function initials(a: Addr | null | undefined): string {
  const name = displayName(a);
  const parts = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

const AVATARS = [
  "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
  "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300",
  "bg-lime-500/15 text-lime-700 dark:text-lime-300",
];

/** Stable colour per sender. */
export function avatarClass(a: Addr | null | undefined): string {
  const seed = (a?.address ?? a?.name ?? "").toLowerCase();
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AVATARS[Math.abs(h) % AVATARS.length];
}

/** Parse "Name <a@b.c>" / "a@b.c". */
export function parseAddress(raw: string): Addr | null {
  const s = raw.trim().replace(/[,;]+$/, "");
  const m = /^(?:"?([^"<]*?)"?\s*)?<([^<>\s]+@[^<>\s]+)>$/.exec(s) ?? /^()([^\s<>,;]+@[^\s<>,;]+)$/.exec(s);
  if (!m) return null;
  return { name: m[1]?.trim() || null, address: m[2].toLowerCase() };
}

export function isValidAddress(raw: string): boolean {
  const a = parseAddress(raw);
  return Boolean(a?.address && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(a.address));
}
