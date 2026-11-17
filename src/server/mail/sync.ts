import "server-only";
import type { FetchMessageObject, FetchQueryObject, ImapFlow } from "imapflow";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "../db";
import { withImap } from "./client";
import { folderUnchanged, syncFolders, type SyncedFolder } from "./folders";
import {
  flagColumns,
  hasAttachments,
  normalizeMessageId,
  parseReferences,
  sameFlags,
  threadKeyFor,
  toAddressList,
  toDate,
} from "./meta";

/**
 * Mailbox synchronisation: IMAP is the source of truth, `message_meta` is a
 * cache of envelopes + flags (no bodies).
 *
 * Per folder (opened READ-ONLY, so syncing never marks mail as read):
 *   - UIDVALIDITY changed → drop the folder's cache and start over (RFC 3501)
 *   - first sync          → newest INITIAL_WINDOW messages
 *   - later syncs         → UIDs above the highest cached UID
 *   - expunges            → UID SEARCH over the cached range, delete the missing
 *   - flag changes        → CONDSTORE CHANGEDSINCE when available, else compare
 *
 * A database lease guarantees one sync per mailbox at a time, and a time
 * budget keeps each call inside serverless limits (callers repeat while
 * `complete` is false).
 */

const INITIAL_WINDOW = 200;
const INSERT_CHUNK = 200;
const LEASE_SECONDS = 90;
const ROLE_ORDER = ["INBOX", "SENT", "DRAFTS", "ARCHIVE", "JUNK", "TRASH", "NONE", "FLAGGED", "ALL"];

const FETCH_QUERY: FetchQueryObject = {
  uid: true,
  flags: true,
  envelope: true,
  internalDate: true,
  size: true,
  bodyStructure: true,
  headers: ["references"],
};

export type SyncScope = "inbox" | "all" | { folderId: string };

export type SyncResult = {
  status: "ok" | "locked";
  foldersSynced: number;
  newMessages: number;
  /** false when the time budget ran out before every target folder was synced */
  complete: boolean;
};

async function acquireLease(mailboxId: string): Promise<boolean> {
  const updated = await db().$executeRaw`
    UPDATE mailboxes
    SET sync_lease_until = NOW(3) + INTERVAL ${LEASE_SECONDS} SECOND
    WHERE id = ${mailboxId} AND (sync_lease_until IS NULL OR sync_lease_until < NOW(3))`;
  return updated === 1;
}

async function releaseLease(mailboxId: string): Promise<void> {
  await db().$executeRaw`UPDATE mailboxes SET sync_lease_until = NULL WHERE id = ${mailboxId}`;
}

export async function syncMailbox(
  mailboxId: string,
  opts: { scope?: SyncScope; budgetMs?: number } = {},
): Promise<SyncResult> {
  const scope = opts.scope ?? "inbox";
  const budgetMs = opts.budgetMs ?? 8_000;
  const started = Date.now();

  if (!(await acquireLease(mailboxId))) {
    return { status: "locked", foldersSynced: 0, newMessages: 0, complete: false };
  }
  try {
    return await withImap(mailboxId, async (client) => {
      const folders = await syncFolders(client, mailboxId);
      let targets = folders.filter((f) => f.selectable);
      if (scope === "inbox") targets = targets.filter((f) => f.specialUse === "INBOX");
      else if (typeof scope === "object") targets = targets.filter((f) => f.id === scope.folderId);
      targets.sort((a, b) => ROLE_ORDER.indexOf(a.specialUse) - ROLE_ORDER.indexOf(b.specialUse));

      let foldersSynced = 0;
      let newMessages = 0;
      for (const folder of targets) {
        if (folderUnchanged(folder)) {
          foldersSynced++; // nothing changed on the server since the last sync
          continue;
        }
        if (foldersSynced > 0 && Date.now() - started > budgetMs) break;
        newMessages += await syncFolderMessages(client, mailboxId, folder);
        foldersSynced++;
      }
      await db().mailbox.update({ where: { id: mailboxId }, data: { lastSyncAt: new Date(), lastSyncError: null } });
      return { status: "ok", foldersSynced, newMessages, complete: foldersSynced === targets.length };
    });
  } finally {
    await releaseLease(mailboxId).catch(() => {});
  }
}

async function syncFolderMessages(client: ImapFlow, mailboxId: string, folder: SyncedFolder): Promise<number> {
  const p = db();
  const lock = await client.getMailboxLock(folder.path, { readOnly: true });
  try {
    const box = client.mailbox;
    if (!box) return 0;
    const uidValidity = BigInt(box.uidValidity);

    const stored = folder.cached;
    const sameEpoch = stored.uidValidity === uidValidity;
    if (stored.uidValidity != null && !sameEpoch) {
      // The server renumbered this folder: every cached UID is meaningless now.
      await p.messageMeta.deleteMany({ where: { folderId: folder.id } });
    }

    const agg = await p.messageMeta.aggregate({
      where: { folderId: folder.id, uidValidity },
      _max: { uid: true },
      _min: { uid: true },
    });
    const maxUid = agg._max.uid != null ? Number(agg._max.uid) : null;
    const minUid = agg._min.uid != null ? Number(agg._min.uid) : null;

    // 1) New messages
    let added = 0;
    if (box.exists > 0) {
      if (maxUid === null) {
        const start = Math.max(1, box.exists - INITIAL_WINDOW + 1);
        added = await fetchAndInsert(client, `${start}:*`, false, 0, { mailboxId, folderId: folder.id, uidValidity });
      } else if (box.uidNext > maxUid + 1) {
        added = await fetchAndInsert(client, `${maxUid + 1}:*`, true, maxUid, { mailboxId, folderId: folder.id, uidValidity });
      }
    }

    // 2) Expunges and 3) flag changes, within the cached UID range
    if (maxUid !== null && minUid !== null) {
      const range = `${minUid}:${maxUid}`;
      const present = await client.search({ uid: range }, { uid: true });
      if (Array.isArray(present)) {
        const onServer = new Set(present);
        const known = await p.messageMeta.findMany({
          where: { folderId: folder.id, uidValidity },
          select: { id: true, uid: true, flags: true },
        });
        const gone = known.filter((k) => !onServer.has(Number(k.uid))).map((k) => k.id);
        for (let i = 0; i < gone.length; i += 500) {
          await p.messageMeta.deleteMany({ where: { id: { in: gone.slice(i, i + 500) } } });
        }

        const byUid = new Map(known.map((k) => [Number(k.uid), k]));
        const condstore = sameEpoch && stored.highestModSeq != null && box.highestModseq != null;
        const anythingChanged = !condstore || box.highestModseq! > stored.highestModSeq!;
        if (anythingChanged) {
          const options = condstore ? { uid: true, changedSince: stored.highestModSeq! } : { uid: true };
          for await (const msg of client.fetch(range, { uid: true, flags: true }, options)) {
            const row = byUid.get(msg.uid);
            if (!row || !msg.flags || sameFlags(row.flags, msg.flags)) continue;
            await p.messageMeta.update({
              where: { id: row.id },
              data: { ...flagColumns(msg.flags), modSeq: msg.modseq ?? null },
            });
          }
        }
      }
    }

    await p.mailFolder.update({
      where: { id: folder.id },
      data: {
        uidValidity,
        uidNext: BigInt(box.uidNext),
        highestModSeq: box.highestModseq ?? null,
        totalCount: box.exists,
        lastSyncedAt: new Date(),
      },
    });
    return added;
  } finally {
    lock.release();
  }
}

type RowContext = { mailboxId: string; folderId: string; uidValidity: bigint };

async function fetchAndInsert(
  client: ImapFlow,
  range: string,
  byUid: boolean,
  afterUid: number,
  ctx: RowContext,
): Promise<number> {
  const rows: Prisma.MessageMetaCreateManyInput[] = [];
  for await (const msg of client.fetch(range, FETCH_QUERY, { uid: byUid })) {
    // "N:*" always includes the highest UID even if it is below N (RFC 3501).
    if (msg.uid <= afterUid) continue;
    rows.push(toRow(msg, ctx));
  }
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await db().messageMeta.createMany({ data: rows.slice(i, i + INSERT_CHUNK), skipDuplicates: true });
  }
  return rows.length;
}

export function toRow(msg: FetchMessageObject, ctx: RowContext): Prisma.MessageMetaCreateManyInput {
  const env = msg.envelope ?? {};
  const messageIdHeader = normalizeMessageId(env.messageId);
  const inReplyTo = normalizeMessageId(env.inReplyTo);
  const references = parseReferences(msg.headers);
  const from = env.from?.[0];
  return {
    mailboxId: ctx.mailboxId,
    folderId: ctx.folderId,
    uidValidity: ctx.uidValidity,
    uid: BigInt(msg.uid),
    modSeq: msg.modseq ?? null,
    messageIdHeader,
    inReplyTo,
    references,
    threadKey: threadKeyFor(messageIdHeader, inReplyTo, references),
    subject: env.subject ? env.subject.slice(0, 2000) : null,
    fromName: from?.name?.trim().slice(0, 255) || null,
    fromAddress: from?.address?.trim().toLowerCase().slice(0, 320) || null,
    toAddrs: toAddressList(env.to),
    ccAddrs: toAddressList(env.cc),
    bccAddrs: toAddressList(env.bcc),
    replyTo: toAddressList(env.replyTo),
    sentAt: toDate(env.date),
    internalDate: toDate(msg.internalDate) ?? new Date(),
    sizeBytes: msg.size ?? 0,
    ...flagColumns(msg.flags),
    hasAttachments: hasAttachments(msg.bodyStructure),
    preview: null,
  };
}
