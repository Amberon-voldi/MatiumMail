/**
 * JSON shapes exchanged between the mail API (src/app/api/mail) and the mail
 * app in the browser. Dates are ISO-8601 strings. No server-only imports here.
 */

export type FolderRole = "NONE" | "INBOX" | "SENT" | "DRAFTS" | "JUNK" | "TRASH" | "ARCHIVE" | "ALL" | "FLAGGED";

export type Addr = { name: string | null; address: string | null };

export type FolderDTO = {
  id: string;
  name: string;
  path: string;
  role: FolderRole;
  /** Nesting depth below the top level (0 for INBOX, Sent, …). */
  depth: number;
  total: number;
  unread: number;
  lastSyncedAt: string | null;
};

export type ThreadSummaryDTO = {
  /** Conversation key (thread key, or the message id for a lone message). */
  key: string;
  /** Newest message of the conversation in this view; opening the row opens it. */
  latestId: string;
  /** Messages of this conversation in this view (actions apply to these). */
  ids: string[];
  folderId: string;
  subject: string | null;
  from: Addr;
  /** Short sender names, oldest first; the mailbox owner is "me". */
  participants: string[];
  preview: string | null;
  date: string;
  /** Messages in the whole conversation (all folders except Trash/Junk). */
  count: number;
  unread: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  hasAttachments: boolean;
};

export type ThreadPageDTO = {
  threads: ThreadSummaryDTO[];
  nextCursor: string | null;
  /** The server has older messages in this folder that aren't cached yet. */
  olderOnServer: boolean;
};

export type ThreadMessageDTO = {
  id: string;
  folderId: string;
  folderRole: FolderRole;
  folderName: string;
  subject: string | null;
  from: Addr;
  to: Addr[];
  cc: Addr[];
  date: string;
  preview: string | null;
  isSeen: boolean;
  isFlagged: boolean;
  isAnswered: boolean;
  isDraft: boolean;
  hasAttachments: boolean;
};

export type ThreadDTO = {
  key: string;
  subject: string | null;
  messages: ThreadMessageDTO[];
};

export type AttachmentDTO = {
  part: string;
  filename: string;
  contentType: string;
  encoding: string;
  /** Approximate decoded size in bytes. */
  size: number;
  /** Too large for one response; the browser downloads it in pieces. */
  chunked: boolean;
  /** Number of pieces when chunked. */
  chunks: number;
};

export type MessageBodyDTO = {
  id: string;
  subject: string;
  from: Addr | null;
  to: Addr[];
  cc: Addr[];
  replyTo: Addr[];
  date: string | null;
  /** Complete sandboxed document for the email frame. */
  document: string;
  /** "none": no remote images; "loaded": shown via the privacy proxy; "blocked": hidden until asked. */
  remoteImages: "none" | "loaded" | "blocked";
  attachments: AttachmentDTO[];
  unsubscribe: { url: string | null; mailto: string | null } | null;
};

export type ComposeMode = "new" | "reply" | "replyAll" | "forward" | "draft";

export type ComposeContextDTO = {
  mode: ComposeMode;
  sourceId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  /** Editable body to start from (drafts only); sanitized. */
  html: string;
  /** "On …, … wrote:" / forwarded-message header shown above the quote. */
  quoteLabel: string | null;
  /** Attachments of the source that a forward (or draft) carries over. */
  attachments: AttachmentDTO[];
};

export type ContactDTO = { name: string | null; address: string };

export type MailPreferences = {
  /** "proxy": load remote images through the privacy proxy; "ask": block until "Show images". */
  remoteImages: "proxy" | "ask";
  conversationView: boolean;
};

export const DEFAULT_PREFERENCES: MailPreferences = { remoteImages: "proxy", conversationView: true };

export type SendRequest = {
  mode: ComposeMode;
  sourceId: string | null;
  /** Identifies this composer's saved drafts (X-Matium-Draft header), replaced on every save and removed on send. */
  draftKey: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  includeQuote: boolean;
  /** Source attachment parts to forward (forward/draft modes). */
  forwardParts: string[];
  uploadIds: string[];
};

export type UploadDTO = { id: string; filename: string; contentType: string; size: number };

/** Attachments up to this decoded size download in one response (AWS Amplify caps responses at ~5.7 MB). */
export const ATTACHMENT_DIRECT_MAX = 4_500_000;
/** Larger ones download as raw (still-encoded) pieces of this size and are decoded in the browser. */
export const ATTACHMENT_CHUNK_BYTES = 4 * 1024 * 1024;
/** Upload chunks stay well under any platform request limit. */
export const UPLOAD_CHUNK_BYTES = 1536 * 1024;
export const MAX_ATTACHMENTS_BYTES = 20 * 1024 * 1024;

export type ActionOp =
  | { op: "flags"; ids: string[]; seen?: boolean; flagged?: boolean }
  | { op: "move"; ids: string[]; folderId: string }
  | { op: "trash"; ids: string[] }
  | { op: "archive"; ids: string[] }
  | { op: "spam"; ids: string[] }
  | { op: "notSpam"; ids: string[] }
  | { op: "delete"; ids: string[] }
  | { op: "emptyFolder"; folderId: string };

export type ApiError = { error: string; code?: string };
