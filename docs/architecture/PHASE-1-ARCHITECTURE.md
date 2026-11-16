# MatiumMail — Phase 1 Architecture

> Status: **Proposal — awaiting approval.** No application code has been written.
> Companion file: [`schema.draft.prisma`](./schema.draft.prisma) (full draft database schema).
>
> **Revised:** hosting is now **Netlify**, the database is **MySQL on MilesWeb**, and **no AWS is used** (no S3, no KMS). See [`PHASE-1-REVISION-03-NETLIFY-MILESWEB-MYSQL.md`](./PHASE-1-REVISION-03-NETLIFY-MILESWEB-MYSQL.md) (current), which overrides D1/D6/D7/D8, all AWS (S3/KMS/IAM) details, Redis/BullMQ and every Postgres-specific detail below. MySQL schema notes are in [Revision 01 §4](./PHASE-1-REVISION-01-CLOUDFLARE-MYSQL.md#4-mysql-changes).

---

## 0. Guiding decisions (TL;DR)

| # | Decision | Why |
|---|----------|-----|
| D1 | **Two deployable services**: `web` (Next.js) + `mail-engine` (long-running Node.js) | IMAP is stateful (IDLE, selected folder, connection limits). Next.js request handlers are the wrong place to hold sockets for minutes/hours. |
| D2 | **Only `mail-engine` talks IMAP/SMTP and only it can decrypt mailbox credentials** | Shrinks the blast radius: a bug or compromise in the web tier cannot read mailbox passwords. |
| D3 | **Postgres caches metadata only; IMAP stays the source of truth.** Bodies/attachments are fetched on demand. | Avoids duplicating 5 GB × N mailboxes, keeps sync simple and correct. |
| D4 | **Sign-in = full email address + mailbox password, verified by IMAP LOGIN** (delegated auth), then an app-owned server session. | Matches the requirement; no second password to manage. Optional app-level TOTP on top. |
| D5 | **Domains, server settings and mailboxes are rows in the DB**, never code. | New domain = admin form; new mailbox = first login (if auto-provision enabled) or admin form. |
| D6 | **Envelope encryption** (AES-256-GCM + AWS KMS) for mailbox secrets. | Industry-standard, rotatable, auditable via CloudTrail. |
| D7 | **S3 "Vault" for archives**: content-addressed EML objects, SSE-KMS, versioning, checksum-verified; originals removed only after verification **and** explicit confirmation. | Requirement §7, with protection against both data loss and accidental deletion. |
| D8 | **Self-hosted container deployment** (e.g. AWS EC2/Lightsail in `ap-south-1`) behind Caddy/ALB — not Vercel. | Persistent worker process, a **stable egress IP** (important for MilesWeb firewalls), data locality with S3. |

---

## 1. Recommended system architecture

### 1.1 Component diagram

```
                       Browser (mail.matiumtech.com)
                       React UI · TanStack Query · SSE
                                   │  HTTPS (cookie session, no credentials)
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ web  (Next.js, App Router, Node runtime)                                  │
│  • Pages / RSC / route handlers / server actions                          │
│  • AuthN (sessions), AuthZ (mailbox access checks), CSRF, rate limiting   │
│  • Reads metadata straight from Postgres (lists, counts, search)          │
│  • HTML sanitisation + safe rendering pipeline                            │
│  • SSE endpoint: relays Redis pub/sub events to the browser              │
│  • Calls mail-engine for anything that touches IMAP/SMTP                  │
│  ✗ has NO KMS decrypt permission, never sees stored mailbox passwords    │
└───────────────┬───────────────────────────────┬──────────────────────────┘
                │ internal HTTP (private network, │ BullMQ jobs
                │ signed service token, zod-typed)│ (Redis)
                ▼                                 ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ mail-engine  (Node.js, Fastify + BullMQ workers)                          │
│  • Connection manager: per-mailbox IMAP pool with a hard connection budget│
│  • IDLE watchers for active mailboxes, scheduled polling for the rest    │
│  • Sync workers (folders, metadata, flags, expunges)                      │
│  • Command API: fetch body/attachment, flag, move, delete, append, send   │
│  • SMTP sending (Nodemailer) + APPEND copy to Sent                        │
│  • Archive / restore / verify workers (S3)                                │
│  • Quota probes                                                           │
│  ✓ only service with kms:Decrypt on the credential key                   │
└───────┬──────────────────────┬───────────────────────┬───────────────────┘
        │ IMAPS / SMTPS        │ SQL                   │ HTTPS
        ▼                      ▼                       ▼
┌───────────────┐   ┌──────────────────────┐   ┌──────────────────────────┐
│ MilesWeb mail │   │ PostgreSQL           │   │ AWS                       │
│ server(s)     │   │  metadata, users,    │   │  S3 (archive vault)       │
│ IMAP + SMTP   │   │  permissions, audit  │   │  KMS (credential + S3 key)│
└───────────────┘   └──────────────────────┘   └──────────────────────────┘
                    ┌──────────────────────┐
                    │ Redis                │  queues, pub/sub, rate limits,
                    │                      │  short-lived body cache
                    └──────────────────────┘
```

### 1.2 Repository layout (pnpm workspaces + Turborepo)

```
matiummail/
├─ apps/
│  ├─ web/            Next.js app (UI + BFF)
│  └─ mail-engine/    Fastify API + BullMQ workers
├─ packages/
│  ├─ db/             Prisma schema, client, migrations, data-access layer
│  ├─ mail-core/      Provider abstraction (ImapProvider/SmtpProvider interfaces),
│  │                  ImapFlow + Nodemailer implementations, MIME helpers
│  ├─ crypto/         Envelope encryption, KeyProvider (KMS | local dev key)
│  ├─ contracts/      zod schemas shared by web ↔ engine (request/response/events)
│  ├─ sanitize/       Email HTML sanitiser + tests (malicious corpus)
│  └─ config/         env parsing (zod), eslint/tsconfig presets
└─ docs/
```

`mail-core` defines interfaces (`MailProvider`, `ImapSession`, `MailSender`) so Gmail/Microsoft 365 (OAuth2) can be added later without touching the UI or sync logic — requirement §11 without building it now.

### 1.3 How Next.js talks to IMAP and SMTP

1. Browser calls a Next.js route handler / server action (e.g. `POST /api/mailboxes/:id/messages/move`).
2. `web` validates the session, validates input with zod, and runs **`requireMailboxAccess(user, mailboxId, 'organise')`** against `mailbox_access`.
3. `web` calls `mail-engine` over the private network: `POST /internal/v1/mailboxes/:id/move` with a short-lived service JWT (HS256 shared secret, 60 s TTL, audience-bound) that includes the already-authorised `userId` and `mailboxId`. The engine **re-checks** the access row (defence in depth).
4. The engine borrows a connection from that mailbox's pool, decrypts the credential if it needs to (re)connect, performs `UID MOVE`, updates Postgres, writes an audit entry, and publishes `mailbox:{id}` events to Redis.
5. `web`'s SSE endpoint forwards the event to every browser tab subscribed to that mailbox → TanStack Query invalidates/patches the list.

Read paths that don't need IMAP (message lists, unread counts, search over metadata, contacts, archive search) go **directly from `web` to Postgres** and are fast.

Long or bulk operations (archive 2,000 messages, initial sync, bulk move) are **BullMQ jobs** with progress events over the same SSE channel.

### 1.4 Authentication & tenancy model

* **Organization** → **Domains** → **Mailboxes**. **Users** belong to an organisation and get mailboxes only through explicit **MailboxAccess** rows (`OWNER`, `DELEGATE`, `READ_ONLY`). Org role (`OWNER/ADMIN/MEMBER`) controls *administration*, not mailbox content: even an admin needs an access row to read a mailbox (and granting one is audited).
* **Sign-in flow**
  1. User enters `support@matiumtech.com` + password.
  2. `web` rate-limits (per IP, per address), looks up the domain → must be registered & active, else generic "invalid credentials".
  3. `web` forwards the credential **once** to `mail-engine /internal/v1/auth/verify` (never logged, never stored by `web`).
  4. Engine performs IMAP `LOGIN` over TLS. On success it (re)encrypts and stores the credential, marks the mailbox `ACTIVE`, and returns.
  5. If the user doesn't exist and the domain has `autoProvision=true`, create `User` + `Mailbox` + `OWNER` access. Otherwise the user/mailbox must have been created by an admin.
  6. `web` creates a session (random 256-bit token in an `HttpOnly; Secure; SameSite=Lax; Path=/` cookie with the `__Host-` prefix; only its SHA-256 is stored), 12 h idle / 7 d absolute expiry (configurable). Optional TOTP step-up.
* **Shared mailboxes** (e.g. `support@`): an admin links the mailbox once by entering its password; then grants `DELEGATE` to team members, who sign in with *their own* address and switch mailboxes in the sidebar. Nobody needs to know the shared password.
* **Password changed in mPanel** → engine gets `AUTHENTICATIONFAILED` → mailbox status `NEEDS_REAUTH`, sync stops (to avoid tripping MilesWeb's brute-force lockout), UI asks the owner to re-enter the password.

---

## 2. Technology & library selection

| Concern | Choice | Reasoning / alternatives rejected |
|---|---|---|
| Framework | **Next.js** (current stable at scaffold time, pinned), App Router, TypeScript `strict` | Requested. Node runtime only (not Edge) for crypto & Prisma. |
| Styling / UI | **Tailwind CSS v4**, **shadcn/ui** (Radix primitives), **lucide-react** icons, **next-themes** | Requested; shadcn copies components into the repo so we fully own the look (no "admin dashboard" vibe). |
| Data fetching (client) | **TanStack Query** + **@tanstack/react-virtual** | Cache, optimistic updates, infinite lists; virtualisation keeps 10k-row lists smooth. |
| Rich-text editor | **Tiptap** (ProseMirror) | Mature, headless (fits our design), clean HTML output, paste handling, extensible (signatures, inline images). Lexical considered; Tiptap's email-friendly HTML output wins. |
| Keyboard shortcuts | **react-hotkeys-hook** | Small, scoped shortcuts (Gmail-like `j/k/e/#/r/a/f/c`, `/`). |
| **IMAP** | **ImapFlow** | Actively maintained by the author of Nodemailer; promise API; IDLE; CONDSTORE/QRESYNC; MOVE/UIDPLUS; QUOTA (`getQuota`); SPECIAL-USE detection; mailbox locking; streaming fetch. `node-imap`/`imap-simple` are unmaintained (no updates for years) — rejected. |
| MIME parsing | **mailparser** (`simpleParser`) | Same maintainer; robust with real-world broken mail, charsets, TNEF-free attachments, streams. `postal-mime` is an alternative (lighter, browser-capable) but we only parse server-side. |
| **SMTP** | **Nodemailer** (+ its `MailComposer`) | De-facto Node standard; implicit TLS (465) & STARTTLS (587) with `requireTLS`; pooling; build the exact MIME once and reuse the same bytes for SMTP send and IMAP `APPEND` to Sent. |
| HTML sanitisation | **DOMPurify** on **jsdom** (server-side) + sandboxed `<iframe srcdoc>` with strict CSP | Belt-and-braces: sanitise on the server *and* render in an iframe without `allow-scripts`/`allow-same-origin`. |
| Validation | **zod** | One schema for env, API input, web↔engine contracts. |
| ORM / DB | **Prisma** + **PostgreSQL 16+** with `pg_trgm` | Requested. Full-text via `tsvector` + GIN in raw migrations. |
| Queue / realtime fan-out | **BullMQ** on **Redis 7** | Retries with backoff, concurrency per queue, repeatable jobs (polling, future archive policies), progress events. |
| Rate limiting | **rate-limiter-flexible** (Redis store) | Per-IP, per-account, per-mailbox SMTP throttles. |
| Sessions | **Custom opaque-token sessions** (pattern from the Lucia guide, helpers from `@oslojs/crypto` / `@oslojs/encoding`) | Our auth is unusual (delegated to IMAP). Auth.js discourages DB sessions with credentials providers; a small, fully-tested module (~200 LOC) is clearer than bending a framework. |
| Encryption | Node `crypto` (AES-256-GCM) + **@aws-sdk/client-kms** | No custom crypto; KMS for key wrapping. |
| S3 | **@aws-sdk/client-s3** + **@aws-sdk/lib-storage** (multipart) + **@aws-sdk/s3-request-presigner** | Official v3 SDK. |
| Attachment checks | **file-type** (magic-byte sniffing); optional **ClamAV** (`clamd`) sidecar | Don't trust declared MIME types; AV scan of uploads is a Phase 6 option. |
| Internal API | **Fastify** + `fastify-type-provider-zod` | Fast, schema-first, good for the engine's private API. |
| Logging / errors | **pino** (with redaction), optional **Sentry** | Structured logs; secrets & bodies redacted by path. |
| Testing | **Vitest**, **Playwright**, **Testcontainers** (Postgres/Redis), **GreenMail** or Dovecot container as IMAP/SMTP test double | Integration tests against a real IMAP server, not mocks. |

---

## 3. PostgreSQL schema

The complete draft is in [`schema.draft.prisma`](./schema.draft.prisma). Summary:

| Area | Tables | Notes |
|---|---|---|
| Tenancy & identity | `organizations`, `users`, `sessions` | Org-ready for future SaaS but v1 runs with one org. Sessions store only token hashes. |
| Mail configuration | `mail_server_profiles`, `domains`, `mailboxes` | Server settings are data. Many domains can share one MilesWeb profile. |
| Secrets | `mailbox_credentials` | 1:1 with mailbox, separate table, ciphertext + wrapped DEK + key id + version. |
| Authorisation | `mailbox_access` | `(user_id, mailbox_id)` PK + role. Absence = no access. |
| Live-mail cache | `mail_folders`, `message_meta`, `compose_drafts` | Folder sync state (UIDVALIDITY, UIDNEXT, HIGHESTMODSEQ); envelope metadata + flags + preview, no bodies. |
| People | `contacts`, `signatures` | Scoped per mailbox (isolation); signatures can be per-user within a shared mailbox. |
| Archive vault | `archive_batches`, `archived_messages`, `archive_attachments`, `archive_policies` | Content-addressed by SHA-256, explicit live-copy lifecycle. |
| Monitoring / compliance | `storage_snapshots`, `audit_logs` | Audit log is append-only at the DB-grant level. |

Isolation rules enforced in the data-access layer (`packages/db`):

* Every function that touches mail data takes an **`AuthorizedMailbox`** value that can only be produced by `requireMailboxAccess()`. Raw `prisma.messageMeta.findMany` is lint-banned outside `packages/db`.
* All mail tables carry `mailbox_id`, and every query filters by it — even when filtering by folder.
* Optional later hardening: Postgres Row-Level Security keyed on `app.current_mailbox_ids`.

---

## 4. IMAP synchronisation strategy

### 4.1 Principles

* **IMAP is authoritative.** Postgres is a rebuildable cache of envelopes + flags.
* **Bodies on demand.** Opening a message fetches `BODYSTRUCTURE` + the needed parts with `BODY.PEEK[...]` (we set `\Seen` explicitly, never by accident). Parsed + sanitised HTML is cached in Redis (encrypted, ~10 min TTL) to make back/forward navigation instant.
* **Newest first.** Users see their latest mail within seconds; history backfills in the background.
* **Connection budget.** Shared hosting caps concurrent IMAP connections. Per mailbox we use at most `maxConnectionsPerMailbox` (default **3**): 1 IDLE (INBOX), 1 interactive commands, 1 background sync/archive. All engine work goes through a pool that enforces this.

### 4.2 Phases

**A. Capability probe (on first connect, cached on the server profile)**
`CAPABILITY`, `NAMESPACE`, `LIST` with `SPECIAL-USE`. Records whether we have `IDLE`, `CONDSTORE`, `QRESYNC`, `UIDPLUS`, `MOVE`, `QUOTA`, `SPECIAL-USE`, `STATUS=SIZE`, `ESEARCH`, `LITERAL+`.

**B. Folder sync**
`LIST "" "*"` → upsert `mail_folders`. Role mapping: `SPECIAL-USE` attributes first; if absent, a name heuristic (`Sent`, `Sent Items`, `INBOX.Sent`, `Junk`/`Spam`, `Trash`/`Deleted Items`, `Drafts`, `Archive`), overridable per mailbox in settings. Folder names decoded from modified UTF-7. Missing standard folders are created on demand (e.g. `Archive`).

**C. Initial metadata sync (per folder, INBOX first)**
`STATUS` → `UIDVALIDITY`, `UIDNEXT`, `MESSAGES`, `UNSEEN`, `HIGHESTMODSEQ`.
`UID FETCH <newest ~2,000> (UID FLAGS INTERNALDATE RFC822.SIZE ENVELOPE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (REFERENCES IN-REPLY-TO)] MODSEQ)` plus a short `BODY.PEEK[TEXT]<0.2048>` (or the first text part) for the preview. Then backfill older UIDs in chunks of 500 as a low-priority job, tracking `backfill_cursor_uid`.

**D. Incremental sync**

| Server supports | Strategy |
|---|---|
| `QRESYNC` | `SELECT folder (QRESYNC (uidvalidity modseq))` → server returns changed flags **and** `VANISHED` UIDs since our modseq. Cheapest & exact. |
| `CONDSTORE` only | `UID FETCH 1:* (FLAGS) (CHANGEDSINCE modseq)` for flag changes; `UID SEARCH ALL` (or `ESEARCH`) to diff UID sets for expunges; `UID FETCH <uidNext>:*` for new mail. |
| Neither | New mail via `UIDNEXT`; flags re-fetched for the newest ~1,000 messages each cycle and the full folder hourly; expunges via UID-set diff. |

Always: if `UIDVALIDITY` changed → discard that folder's cache and resync it (RFC 3501 requirement).

**E. Real-time**

* **IDLE on INBOX** for each mailbox that has an active browser session (seen in last ~15 min). IDLE is re-issued every ~25 min (servers drop at 30). On `EXISTS`/`EXPUNGE`/`FETCH` → run incremental sync → publish event.
* **Polling** other folders of active mailboxes every 2–3 min; inactive mailboxes every 15 min (keeps counts & quota fresh without burning connections). `NOTIFY` (RFC 5465) used only if advertised.
* Engine → Redis pub/sub `mailbox:{id}` → `web` SSE → browser. Fallback to 60 s polling if SSE drops.

**F. User actions (write-through)**
Optimistic UI → engine runs `UID STORE`, `UID MOVE` (or `UID COPY` + `UID STORE \Deleted` + `UID EXPUNGE` when MOVE is missing — **never a bare `EXPUNGE`**, which would purge other users' `\Deleted` messages), `APPEND` → cache updated → event. On failure the UI rolls back and shows the error.

**G. Sending**
Compose → `MailComposer` builds MIME once → Nodemailer SMTP send → on success `APPEND` the same bytes to Sent with `\Seen` (unless MilesWeb auto-saves sent mail — to verify, §7) → harvest recipients into contacts. Outbound throttled to stay under MilesWeb's hourly limit; queued with retries on transient (4xx) errors, surfaced immediately on 5xx.

**H. Drafts**
Autosave every ~5 s to `compose_drafts` (server-side, crash-safe). On "Save draft"/close: `APPEND` to Drafts and delete the previous draft UID. On send: delete the IMAP draft.

**I. Search**
1. Metadata search in Postgres (`tsvector` on subject/from/to/preview + trigram on addresses) — instant, covers most needs.
2. "Search full message bodies on server" → IMAP `UID SEARCH TEXT` (speed depends on whether MilesWeb's Dovecot has FTS indexing).
3. Archive vault search — Postgres FTS over `archived_messages`.

**J. Failure handling**
Exponential backoff with jitter per mailbox; circuit breaker after N consecutive failures (`ERROR` status shown in UI); **auth failures stop retries immediately** (`NEEDS_REAUTH`) to avoid account/IP lockout; TLS errors never fall back to plaintext.

---

## 5. Secure mailbox credential storage

### 5.1 Scheme: envelope encryption

```
                AWS KMS CMK  "alias/matiummail-credentials"
                     │  GenerateDataKey / Decrypt
                     │  EncryptionContext = { mailboxId, purpose: "mailbox-credential" }
                     ▼
     DEK (32 random bytes, per mailbox, per version)
                     │  AES-256-GCM, 12-byte random IV,
                     │  AAD = "mailbox-credential|{mailboxId}|v{version}"
                     ▼
      ciphertext + authTag  ─────►  mailbox_credentials row
      wrappedDek + keyId + version
```

* **AAD/encryption context binds** the ciphertext to its mailbox: copying one row's ciphertext onto another mailbox fails to decrypt.
* **Only the `mail-engine` IAM role** has any permission on this key (`kms:GenerateDataKey`, `kms:Decrypt`). `web` has none; it forwards the plaintext password once to the engine over the private network and the engine encrypts it.
* Plaintext DEKs are cached in engine memory for ≤5 min to limit KMS calls; plaintext passwords exist only for the duration of an IMAP/SMTP login.
* **Rotation**: re-wrap DEKs under a new KMS key version (KMS automatic yearly rotation is transparent); `keyId` + `version` support re-encrypt jobs.
* **Local dev / non-AWS**: a `LocalKeyProvider` uses a 32-byte master key from env (`CREDENTIAL_MASTER_KEY`), same interface. Production refuses to boot with the local provider.
* **App-level TOTP secrets** reuse the same envelope helper with a different `purpose`.

### 5.2 Surrounding controls

* Passwords are accepted only in POST bodies over HTTPS, never in URLs, never echoed back, never stored in browser storage, never sent to the client after login.
* pino redaction for `password`, `pass`, `auth`, `authorization`, `cookie`, `*.credential*`; ImapFlow/Nodemailer debug loggers disabled in production (they can print `LOGIN` lines).
* DB backups are encrypted (RDS/KMS or `pgBackRest` + encryption); the credential ciphertext is useless without KMS access.
* Every decrypt is visible in CloudTrail; anomalies alertable.
* App passwords: the model has `CredentialType.APP_PASSWORD`; if MilesWeb offers them we prefer them (revocable without changing the user's main password). OAuth2 reserved for future Gmail/M365.
* Considered and rejected for v1: *not* storing passwords (session-memory only). It breaks IDLE, background sync, archiving and shared-mailbox delegation. Could be offered later as a per-mailbox "no-store" mode with reduced features.

---

## 6. AWS S3 archival architecture ("Vault")

> **Naming:** IMAP servers already have an "Archive" folder that still lives in MilesWeb storage and counts against quota. To avoid confusion, the UI calls the S3 system the **Vault** ("Move to Vault"). Please confirm or pick another name.

### 6.1 Bucket design

* Bucket `matiummail-vault-<env>` in the same region as the app (proposed `ap-south-1`, Mumbai).
* **Block Public Access** on; bucket policy denies non-TLS requests and any principal other than the engine role (+ break-glass admin).
* **SSE-KMS** with a dedicated CMK (`alias/matiummail-vault`) and S3 Bucket Keys enabled (cuts KMS cost).
* **Versioning on.** Optional **Object Lock (governance mode)** with a short default retention (e.g. 30 days) as a guard against accidental or malicious deletion — must be enabled at bucket creation, so decide now.
* **Key layout (content-addressed, no PII in keys):**
  `orgs/{orgId}/mailboxes/{mailboxId}/eml/{yyyy}/{mm}/{sha256}.eml`
  `orgs/{orgId}/mailboxes/{mailboxId}/meta/{sha256}.json` (metadata sidecar → the Postgres index can be rebuilt from S3 alone)
* **Lifecycle:** objects ≥128 KB → S3 Standard-IA after 30 days → Glacier Instant Retrieval after 180 days. Objects <128 KB stay in Standard (IA/GIR bill a 128 KB minimum, so moving small emails costs *more*). All tiers allow immediate download.
* Noncurrent versions expire after 90 days (configurable).

### 6.2 Archive workflow (per message, idempotent BullMQ job)

1. **Select** — user selects messages (or a filter like "older than 12 months in INBOX"). `web` checks `archive` permission, creates an `archive_batch` and enqueues jobs. UI shows progress.
2. **Fetch** — engine `EXAMINE`s the folder (**read-only**, so flags are untouched), confirms `UIDVALIDITY` matches, `UID FETCH <uid> (BODY.PEEK[] RFC822.SIZE INTERNALDATE FLAGS)`. Stream to a temp file (no full-message RAM spikes), computing SHA-256 and byte count on the fly. Check byte count == `RFC822.SIZE`.
3. **Parse** — `mailparser` extracts headers (From/To/Cc/Bcc/Subject/Date/Message-ID), text excerpt (first ~32 KB), attachment inventory. The EML itself is the untouched original RFC 822 source, so everything (body, attachments, headers incl. DKIM/Received) is preserved byte-for-byte.
4. **Upload** — `PutObject` (or multipart for >16 MB) with `ChecksumAlgorithm=SHA256`; S3 rejects the upload if bytes don't match our checksum. `ContentType: message/rfc822`. Deduplication: if `(mailboxId, sha256)` already `VERIFIED`, skip upload.
5. **Verify** — `HeadObject` with `ChecksumMode=ENABLED`: confirm `ChecksumSHA256` and `ContentLength` match; record `VersionId`. Write sidecar JSON. Persist metadata in one transaction → `status = VERIFIED`. (A weekly job re-downloads a random sample and re-hashes.)
6. **Audit** — `archive.message.verified` with batch id, sizes, S3 key (no content).
7. **Offer removal** — when the batch finishes, the UI shows: *"1,248 emails (3.1 GB) safely stored in the Vault and verified. Free up space in your mailbox?"* with two explicit choices:
   * **Move originals to Trash** (reversible; space freed when Trash is emptied), or
   * **Permanently remove originals from the server** (typed confirmation).
   Nothing happens without this click.
8. **Remove (only if confirmed)** — per message: re-check `status = VERIFIED`, re-`SELECT` folder, confirm `UIDVALIDITY` + `RFC822.SIZE` + Message-ID still match the archived record, then `UID MOVE` to Trash **or** `UID STORE +FLAGS (\Deleted)` + **`UID EXPUNGE <uid>`** (requires `UIDPLUS`; without it we only offer "Move to Trash"). Set `live_copy_state`, audit `archive.live_copy.expunge`.

Failures at any step leave the original untouched and mark the item `FAILED` with a reason; retries are safe because keys are content-addressed.

### 6.3 Search, download, restore

* **Search**: Postgres FTS (`subject`, `from`, `to`, `cc`, `text_excerpt`, attachment filenames) with date/sender/has-attachment filters — same search UI as live mail, "Vault" scope.
* **View**: engine fetches the EML, parses, sanitises → same reader component as live mail.
* **Download**: `.eml` via a presigned GET URL (60 s TTL, `Content-Disposition: attachment`) issued only after an access check; single attachments streamed through the engine (extracted from the EML). Bulk export → zip job → presigned URL.
* **Restore**: fetch EML from S3 → verify SHA-256 → check quota headroom → IMAP `APPEND` to the original folder (or a `Restored` folder if it no longer exists) **preserving the original flags and INTERNALDATE** → `live_copy_state = RESTORED`. The vault copy is retained.
* **Vault deletion**: admin-only, typed confirmation, audited; blocked while Object Lock retention applies.

### 6.4 Future automated policies

`archive_policies` (schema ready, disabled in v1): a BullMQ repeatable job runs `UID SEARCH BEFORE <date>` per configured folder, enqueues a `POLICY` batch, and **notifies the owner** to confirm removal of originals — automation archives but never deletes on its own.

---

## 7. Storage monitoring

1. **Preferred — IMAP `QUOTA` extension** (`GETQUOTAROOT INBOX`, RFC 2087/9208). Dovecot with the quota plugin exposes this, but whether MilesWeb enables it must be **verified with a real mailbox** (capability probe).
2. **Fallback — computed usage**: `STATUS <folder> (SIZE)` if `STATUS=SIZE` is advertised, else sum of `RFC822.SIZE` across folders (which we already have from sync). The **limit** then comes from the admin-entered `quota_limit_bytes` (default from the domain, e.g. 5 GB) and the UI labels it "limit set manually".
3. We do **not** scrape mPanel or invent an API.

UI: sidebar meter (`used / limit · %`), amber banner at **70 %**, red at **85 %** with *"Move emails older than 12 months to the Vault (~X GB)"* — X is computed from metadata sizes. Vault usage (sum of `archived_messages.size_bytes`) is shown separately and never mixed with mailbox quota. Daily `storage_snapshots` give a trend line.

---

## 8. Security architecture (overview; full review in Phase 6)

* **Sessions**: `__Host-` cookie, `HttpOnly`, `Secure`, `SameSite=Lax`; token hashed at rest; idle + absolute expiry; rotation on login/privilege change; "sign out everywhere".
* **CSRF**: SameSite + strict `Origin`/`Host` check on every non-GET request; Next.js server actions' built-in origin check; JSON-only APIs reject `text/plain`/form posts.
* **Rate limiting**: login (per IP and per address, with progressive delay) — this also protects our server IP from being banned by MilesWeb's brute-force protection; API per session; SMTP per mailbox per hour.
* **Untrusted email content**:
  * Server-side DOMPurify with an email-specific allowlist: no `<script>`, `<iframe>`, `<object>`, `<form>`, event handlers, `javascript:`/`data:` (except safe images) URLs, `<base>`, `<meta http-equiv>`; CSS sanitised (no `position:fixed`, `expression()`, external `@import`).
  * Rendered in `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc=…>` with a CSP that forbids scripts; links get `target=_blank rel="noopener noreferrer"`.
  * **Remote images blocked by default** (tracking pixels); "Load images" fetches them through our image proxy (no referrer, no cookies, size/type limits, SSRF-protected: public IPs only).
  * `cid:` inline images rewritten to authenticated attachment URLs.
* **Attachments**: downloads served with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, sniffed type via `file-type`; previews only for an allowlist (images rendered from sanitised bytes, PDFs in a sandboxed viewer, text as text); upload size limit aligned with MilesWeb's SMTP limit; executable types warned/blocked; optional ClamAV.
* **Headers**: strict CSP for the app, HSTS (preload), `Referrer-Policy: no-referrer`, `Permissions-Policy`, frame-ancestors `none`.
* **RBAC + isolation**: org role for administration, `mailbox_access` for content; checked in `web` and again in the engine.
* **Audit log**: logins (success/failure), mailbox access grants, sends, deletes, archive/restore/expunge, credential updates, admin changes.

---

## 9. MilesWeb mPanel — limitations & what we must verify

I have **not** assumed any hostname, port or capability. Items marked ★ block Phase 3.

### 9.1 Connection settings (please supply)

1. ★ **IMAP host, port, security** — e.g. is it `mail.<yourdomain>` or a shared server hostname? Port 993 (SSL/TLS) or 143 (STARTTLS)?
2. ★ **SMTP host, port, security** — 465 (SSL/TLS) or 587 (STARTTLS)? Is SMTP auth required with the full email address as username?
3. ★ **TLS certificate name** — is the certificate valid for `mail.matiumtech.com`, `mail.spinternationalpvtltd.com`, `mail.noida.fit`, or only for the server's own hostname? (We will *never* disable certificate verification, so we must use whichever name the certificate covers.)
4. ★ Are all three domains on the **same MilesWeb server** (one settings profile) or different ones?
5. ★ A **test mailbox** (e.g. `test@matiumtech.com`) we can use for development, with throwaway content.

**Where to find these:** in mPanel, open the email account list and look for the email client / device configuration details for a mailbox (MilesWeb usually shows "manual settings" with incoming/outgoing server and ports). Screenshots of that screen (password hidden) are ideal. Otherwise MilesWeb support can confirm them via ticket.

### 9.2 Capabilities & limits to confirm (with MilesWeb support and/or our probe script)

6. **IMAP capabilities**: IDLE, QUOTA, CONDSTORE, QRESYNC, UIDPLUS, MOVE, SPECIAL-USE, STATUS=SIZE. *(Phase 3's first deliverable is a small probe script you run against the test mailbox that prints these — no guessing.)*
7. **Concurrent IMAP connections** allowed per mailbox and per client IP (our engine will hold 1–3 per mailbox, all from one server IP).
8. **SMTP sending limits** (emails/hour per mailbox and per domain/account) and **max message size** (attachments).
9. **Brute-force protection / IP blocking** (e.g. failed-login lockouts). Can our server's static IP be **whitelisted**? A few mistyped passwords across the team could otherwise block the whole app.
10. **External access policy / ToS**: is a third-party application connecting from an AWS IP with persistent IMAP connections acceptable on shared hosting? Any firewall restriction on IMAP/SMTP from outside India or from cloud IP ranges?
11. **Sent folder behaviour**: does MilesWeb automatically save a copy of SMTP-sent mail to Sent? (If yes, we must not APPEND, or users get duplicates.)
12. **Folder namespace**: are folders `INBOX.Sent` style (Dovecot with `INBOX.` prefix) or top-level `Sent`? (Probe will show.)
13. **Quota reality**: is the 5 GB per-mailbox limit enforced separately, or does mail share the hosting plan's total disk/**inode** limit with websites? Is quota exposed over IMAP?
14. **Spam**: where does spam go (a `Junk`/`spam` folder?), and does moving mail to/from it train the filter?
15. **App passwords / 2FA** for mailboxes — available or not?
16. **Server-side features** we won't build in v1 and will leave in mPanel: forwarders, autoresponders, filters (and is ManageSieve exposed?).
17. **Backups**: does MilesWeb back up mailboxes, and with what retention? (Affects how much we lean on the Vault for DR.)
18. **Deliverability**: are SPF, DKIM and DMARC correctly published for all three domains (MilesWeb signs with DKIM on their SMTP)? Not an app feature, but bad records will look like "the app doesn't send".

### 9.3 Known/likely limitations and our mitigations

| Limitation | Mitigation |
|---|---|
| No management API → can't create mailboxes, reset passwords, read quotas via API | Mailboxes created in mPanel; app links them via login/admin form. Quota via IMAP or manual limit. |
| Shared hosting connection/rate limits | Connection budget per mailbox, IDLE only for active mailboxes, throttled SMTP queue. |
| Password changes happen outside the app | `NEEDS_REAUTH` flow; stop retries on auth failure. |
| Possible lack of server-side FTS | Postgres metadata search first; server body search is explicit and labelled "slower". |
| Mail server could be slow/unavailable | Cached metadata keeps the UI usable read-only; clear connection-state banner; retries with backoff. |

---

## 10. Other decisions I need from you

1. **Hosting for the app**: AWS (EC2/Lightsail + RDS + ElastiCache, or a single EC2 with Docker Compose for v1) in `ap-south-1`? Or another VPS provider? (Vercel isn't a fit for the engine.)
2. **AWS account** availability for S3 + KMS (and do you accept the small KMS cost, ~US$1/key/month + requests)?
3. **Scale**: how many users and mailboxes now, and in 12 months? Roughly how large are the biggest mailboxes today?
4. **Shared mailboxes**: which addresses are shared (e.g. `support@`, `accounts@`) and who should have access?
5. **Auto-provisioning**: should anyone with a valid mailbox password on a registered domain be able to sign in automatically, or only addresses an admin has pre-approved? (Recommended: admin pre-approval for v1.)
6. **App-level 2FA (TOTP)** for all users? Recommended — mailbox passwords are single-factor and shared hosting can leak them.
7. **Vault retention**: any legal/accounting retention requirement (e.g. GST records for `accounts@`)? Should Object Lock be enabled?
8. **Product name / branding** for the UI (e.g. "Matium Mail"), and logo/colour preferences.
9. **Sign-in URL**: a single `mail.matiumtech.com` for all domains is assumed — OK?

---

## 11. What Phase 2 will produce (after approval)

* pnpm/Turborepo monorepo with `apps/web`, `apps/mail-engine`, shared packages.
* Next.js + strict TypeScript + Tailwind + shadcn/ui, light/dark theme shell.
* Docker Compose for local Postgres, Redis, and a local Dovecot/GreenMail test mail server.
* Prisma schema (from the draft above) + initial migration + raw SQL for FTS/trigram/audit grants.
* `env` schema with zod (`.env.example` documenting every variable; no secrets committed).
* Envelope-encryption package with tests.
* Authentication: delegated IMAP login (against the local test server until MilesWeb settings arrive), sessions, logout, rate limiting, CSRF/origin checks, admin bootstrap CLI, audit logging.
