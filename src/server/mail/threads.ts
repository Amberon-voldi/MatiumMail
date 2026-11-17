import type { Addr } from "@/lib/mail-types";

/** Pure helpers for conversation (thread) views over cached message rows. */

export type ThreadKeyed = { id: string; threadKey: string | null };

/** A message without a thread key is a conversation of its own. */
export function conversationKey(row: ThreadKeyed): string {
  return row.threadKey ?? `m:${row.id}`;
}

/**
 * Group newest-first rows into conversations, in order of each conversation's
 * newest row. At most `limit` conversations; later rows of an included
 * conversation still join it. `truncated` is true when a conversation was left out.
 */
export function groupByConversation<T extends ThreadKeyed>(rows: T[], limit: number): { groups: T[][]; truncated: boolean } {
  const groups = new Map<string, T[]>();
  let truncated = false;
  for (const row of rows) {
    const key = conversationKey(row);
    const group = groups.get(key);
    if (group) group.push(row);
    else if (groups.size < limit) groups.set(key, [row]);
    else truncated = true;
  }
  return { groups: [...groups.values()], truncated };
}

/** First name, else the part of the address before "@". */
export function shortName(a: { name?: string | null; address?: string | null }): string {
  const name = a.name?.replace(/["']/g, "").trim();
  if (name) return name.split(/\s+/)[0].slice(0, 30);
  return (a.address ?? "").split("@")[0].slice(0, 30) || "unknown";
}

/** Distinct senders of a conversation (oldest first), "me" for the mailbox's own address. */
export function participantsOf(
  members: Array<{ fromName: string | null; fromAddress: string | null }>,
  me: string,
  max = 4,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of members) {
    const key = (m.fromAddress ?? m.fromName ?? "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(m.fromAddress?.toLowerCase() === me.toLowerCase() ? "me" : shortName({ name: m.fromName, address: m.fromAddress }));
  }
  return out.length > max ? [...out.slice(0, 1), "…", ...out.slice(-(max - 2))] : out;
}

/**
 * One row per real message: the same Message-ID can exist in several folders
 * (a copy sent to yourself, a message filed twice). The copy in `preferFolderId`
 * wins, otherwise the first one.
 */
export function dedupeCopies<T extends { id: string; messageIdHeader: string | null; folderId: string }>(
  rows: T[],
  preferFolderId?: string,
): T[] {
  const chosen = new Map<string, T>();
  for (const row of rows) {
    const key = row.messageIdHeader?.toLowerCase() ?? `id:${row.id}`;
    const prev = chosen.get(key);
    if (!prev || (preferFolderId && row.folderId === preferFolderId && prev.folderId !== preferFolderId)) chosen.set(key, row);
  }
  return rows.filter((r) => chosen.get(r.messageIdHeader?.toLowerCase() ?? `id:${r.id}`) === r);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Opaque list cursor: the (date, id) of the last row shown. */
export function encodeCursor(date: Date, id: string): string {
  return `${date.getTime()}.${id}`;
}

export function decodeCursor(cursor: string | null | undefined): { date: Date; id: string } | null {
  if (!cursor) return null;
  const dot = cursor.indexOf(".");
  const ms = Number(cursor.slice(0, dot));
  const id = cursor.slice(dot + 1);
  if (dot <= 0 || !Number.isFinite(ms) || !UUID.test(id)) return null;
  return { date: new Date(ms), id };
}

export function toAddrList(value: unknown): Addr[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((a): a is { name?: unknown; address?: unknown } => typeof a === "object" && a !== null)
    .map((a) => ({
      name: typeof a.name === "string" ? a.name : null,
      address: typeof a.address === "string" ? a.address : null,
    }));
}

export function referencesOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
