"use client";

import { createContext, useContext } from "react";
import type { ComposeMode, FolderDTO, MailPreferences } from "@/lib/mail-types";
import type { MailApi } from "../_lib/api";

/** Everything the mail app's components share: the mailbox, URL state, settings and actions. */

export type MailboxInfo = {
  id: string;
  address: string;
  displayName: string | null;
  status: string;
  role: "OWNER" | "DELEGATE" | "READ_ONLY";
};

export type OtherMailbox = { id: string; address: string; displayName: string | null; status: string };
export type SignedInAccount = { id: string; email: string; displayName: string | null };

/** What the URL says is on screen. */
export type Nav = { folderId: string | null; threadId: string | null; q: string; all: boolean };

/** A composer's content, kept in localStorage so nothing typed is lost to a crash or reload. */
export type SavedCompose = {
  mode: ComposeMode;
  sourceId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  savedAt: number;
};

export type ComposerInit = {
  mode: ComposeMode;
  sourceId?: string | null;
  to?: string[];
  subject?: string;
  /** Reopen locally saved content. */
  restore?: SavedCompose;
};

/** "inbox" = back to the Inbox (not spam / unarchive / restore from Trash). */
export type MoveTarget = "archive" | "trash" | "spam" | "inbox" | "delete" | { folderId: string };

export type MailCtx = {
  mailbox: MailboxInfo;
  api: MailApi;
  folders: FolderDTO[];
  folder: FolderDTO | null;
  prefs: MailPreferences;
  setPrefs: (patch: Partial<MailPreferences>) => void;
  nav: Nav;
  navigate: (patch: Partial<Nav>, opts?: { replace?: boolean }) => void;
  openComposer: (init: ComposerInit) => void;
  /** Read/unread for message ids (and the conversations they belong to). */
  markSeen: (ids: string[], seen: boolean) => void;
  setStar: (ids: string[], flagged: boolean) => void;
  /** Move/archive/trash/spam/delete; resolves false if the server refused. */
  move: (ids: string[], target: MoveTarget, threadKeys: string[]) => Promise<boolean>;
  /** Permanently delete everything in Trash or Junk. */
  emptyFolder: (folderId: string) => Promise<void>;
  syncNow: (scope?: string) => Promise<void>;
  syncing: boolean;
  can: { organise: boolean; send: boolean };
  openSidebar: () => void;
};

export const MailContext = createContext<MailCtx | null>(null);

export function useMail(): MailCtx {
  const ctx = useContext(MailContext);
  if (!ctx) throw new Error("useMail() outside <MailContext>");
  return ctx;
}
