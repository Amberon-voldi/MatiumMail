import "server-only";
import type { ImapFlow } from "imapflow";
import type { FolderSpecialUse } from "@/generated/prisma/client";
import { db } from "../db";

/**
 * Folder discovery and role assignment.
 *
 * Roles come from the server's SPECIAL-USE attributes when present, otherwise
 * from well-known names (any nesting, e.g. "INBOX.Sent", "[Gmail]/Sent Mail").
 * Each role is assigned to at most one folder; attribute-based matches win.
 */

export type FolderInput = {
  path: string;
  delimiter: string | null;
  /** SPECIAL-USE attribute as reported by the server, e.g. "\\Sent". */
  specialUse?: string | null;
  flags?: Iterable<string>;
};

const ATTRIBUTE_ROLES: Record<string, FolderSpecialUse> = {
  "\\inbox": "INBOX",
  "\\sent": "SENT",
  "\\drafts": "DRAFTS",
  "\\junk": "JUNK",
  "\\trash": "TRASH",
  "\\archive": "ARCHIVE",
  "\\all": "ALL",
  "\\flagged": "FLAGGED",
};

const NAME_ROLES: Array<[RegExp, FolderSpecialUse]> = [
  [/^inbox$/i, "INBOX"],
  [/^(sent|sent items|sent mail|sent messages|outbox sent)$/i, "SENT"],
  [/^drafts?$/i, "DRAFTS"],
  [/^(junk|spam|junk e-?mail|bulk mail|junk mail)$/i, "JUNK"],
  [/^(trash|deleted|deleted items|deleted messages|bin|recycle bin)$/i, "TRASH"],
  [/^(archive|archives)$/i, "ARCHIVE"],
  [/^all mail$/i, "ALL"],
];

export function leafName(path: string, delimiter: string | null): string {
  if (!delimiter) return path;
  const parts = path.split(delimiter);
  return parts[parts.length - 1] || path;
}

export function assignRoles(folders: FolderInput[]): Map<string, FolderSpecialUse> {
  const result = new Map<string, FolderSpecialUse>();
  const taken = new Set<FolderSpecialUse>();

  // INBOX is always the literal INBOX (RFC 3501), regardless of attributes.
  for (const f of folders) {
    if (f.path.toUpperCase() === "INBOX") {
      result.set(f.path, "INBOX");
      taken.add("INBOX");
    }
  }
  // 1) SPECIAL-USE attributes
  for (const f of folders) {
    if (result.has(f.path)) continue;
    const attrs = [f.specialUse, ...(f.flags ? [...f.flags] : [])].filter(Boolean) as string[];
    for (const a of attrs) {
      const role = ATTRIBUTE_ROLES[a.toLowerCase()];
      if (role && !taken.has(role)) {
        result.set(f.path, role);
        taken.add(role);
        break;
      }
    }
  }
  // 2) Well-known names, shallowest path first so "Sent" beats "Projects/Sent".
  const byDepth = [...folders].sort(
    (a, b) => a.path.split(a.delimiter ?? "\u0000").length - b.path.split(b.delimiter ?? "\u0000").length,
  );
  for (const f of byDepth) {
    if (result.has(f.path)) continue;
    const leaf = leafName(f.path, f.delimiter);
    for (const [re, role] of NAME_ROLES) {
      if (!taken.has(role) && re.test(leaf)) {
        result.set(f.path, role);
        taken.add(role);
        break;
      }
    }
  }
  for (const f of folders) if (!result.has(f.path)) result.set(f.path, "NONE");
  return result;
}

export type SyncedFolder = {
  id: string;
  path: string;
  specialUse: FolderSpecialUse;
  selectable: boolean;
  /** Server-side state from LIST-STATUS (null if the server didn't report it). */
  server: { messages: number | null; uidNext: number | null; uidValidity: bigint | null; highestModseq: bigint | null };
  /** What the cache last recorded for this folder. */
  cached: { uidValidity: bigint | null; uidNext: bigint | null; highestModSeq: bigint | null; totalCount: number };
};

/**
 * True when the server's change markers prove nothing happened in the folder
 * since the last sync (no new mail, no expunges, no flag changes), so it can
 * be skipped without even selecting it.
 */
export function folderUnchanged(f: SyncedFolder): boolean {
  const s = f.server;
  const c = f.cached;
  return (
    s.uidValidity !== null &&
    s.uidNext !== null &&
    s.messages !== null &&
    s.highestModseq !== null &&
    c.uidValidity === s.uidValidity &&
    c.uidNext === BigInt(s.uidNext) &&
    c.highestModSeq === s.highestModseq &&
    c.totalCount === s.messages
  );
}

/**
 * LIST (+STATUS, one round trip) the server's folders and mirror them into
 * mail_folders, writing only rows that are new or changed.
 */
export async function syncFolders(client: ImapFlow, mailboxId: string): Promise<SyncedFolder[]> {
  const listed = await client.list({
    statusQuery: { messages: true, unseen: true, uidNext: true, uidValidity: true, highestModseq: true },
  });
  const roles = assignRoles(
    listed.map((f) => ({ path: f.path, delimiter: f.delimiter ?? null, specialUse: f.specialUse, flags: f.flags })),
  );
  const p = db();
  const existing = new Map(
    (
      await p.mailFolder.findMany({
        where: { mailboxId },
        select: {
          id: true, path: true, name: true, delimiter: true, specialUse: true, subscribed: true, selectable: true,
          totalCount: true, unreadCount: true, uidValidity: true, uidNext: true, highestModSeq: true,
        },
      })
    ).map((r) => [r.path, r]),
  );
  const out: SyncedFolder[] = [];

  for (const f of listed) {
    const selectable = !f.flags?.has("\\Noselect") && !f.flags?.has("\\NonExistent");
    const specialUse = roles.get(f.path) ?? "NONE";
    const status = f.status;
    const data = {
      delimiter: f.delimiter ?? null,
      name: (f.name || leafName(f.path, f.delimiter ?? null)).slice(0, 255),
      specialUse,
      subscribed: f.subscribed ?? true,
      selectable,
      ...(status?.messages != null ? { totalCount: status.messages } : {}),
      ...(status?.unseen != null ? { unreadCount: status.unseen } : {}),
    };
    const prev = existing.get(f.path);
    let id = prev?.id;
    const changed =
      !prev ||
      prev.name !== data.name ||
      prev.delimiter !== data.delimiter ||
      prev.specialUse !== data.specialUse ||
      prev.subscribed !== data.subscribed ||
      prev.selectable !== data.selectable ||
      (data.unreadCount !== undefined && prev.unreadCount !== data.unreadCount);
    if (changed) {
      const row = await p.mailFolder.upsert({
        where: { mailboxId_path: { mailboxId, path: f.path } },
        create: { mailboxId, path: f.path, ...data },
        // totalCount is owned by the message sync (it is a change marker).
        update: { ...data, totalCount: undefined },
        select: { id: true },
      });
      id = row.id;
    }
    out.push({
      id: id!,
      path: f.path,
      specialUse,
      selectable,
      server: {
        messages: status?.messages ?? null,
        uidNext: status?.uidNext ?? null,
        uidValidity: status?.uidValidity != null ? BigInt(status.uidValidity) : null,
        highestModseq: status?.highestModseq != null ? BigInt(status.highestModseq) : null,
      },
      cached: {
        uidValidity: prev?.uidValidity ?? null,
        uidNext: prev?.uidNext ?? null,
        highestModSeq: prev?.highestModSeq ?? null,
        totalCount: prev?.totalCount ?? -1,
      },
    });
  }

  // Folders deleted on the server disappear here too (their cached messages cascade).
  const gone = [...existing.keys()].filter((path) => !listed.some((f) => f.path === path));
  if (gone.length) await p.mailFolder.deleteMany({ where: { mailboxId, path: { in: gone } } });
  return out;
}
