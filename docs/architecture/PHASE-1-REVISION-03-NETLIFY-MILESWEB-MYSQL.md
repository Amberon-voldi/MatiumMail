# Phase 1 — Revision 03: Netlify hosting + MySQL on MilesWeb

> Status: **Proposal — awaiting approval. Current.**
> Supersedes Revision 02 (AWS Amplify) and Revision 01 (Cloudflare). The MySQL schema notes in [Revision 01 §4](./PHASE-1-REVISION-01-CLOUDFLARE-MYSQL.md#4-mysql-changes) still apply, and [`schema.draft.prisma`](./schema.draft.prisma) is MySQL / Prisma 7 with the archive tables removed.
> Unchanged from [`PHASE-1-ARCHITECTURE.md`](./PHASE-1-ARCHITECTURE.md): library choices for the mail side, HTML sanitisation and the security model.
> **No AWS is involved.** Key management is replaced as described in §3.3. (AWS S3 and KMS in the original document are superseded.)
> **Archiving (the S3 "Vault") is deferred and out of v1 scope.** Its design stays in the original document §6 for a later phase; see §3.4 for what v1 does instead.
> "For now" is taken to mean: **v1 runs entirely on Netlify + MilesWeb, with no server of our own and no other providers apart from Prisma Accelerate (§2)**, and the code is structured so an always-on mail worker can be added later without a rewrite.

## 1. Platform facts that shape v1

| Fact | Impact |
|---|---|
| Netlify runs Next.js server code in **serverless functions** (request-scoped) | No long-lived IMAP connections and no IDLE. Every mail operation opens a connection, logs in, works and disconnects. |
| Synchronous functions time out at **~10 s by default** (raised on paid plans); **background functions** run up to **15 min** (asynchronous, with automatic retries); **scheduled functions** run on a cron | Interactive actions must stay small. Initial sync, bulk actions and archiving run as chunked background jobs. |
| Functions run in **one region (US East by default)** | MilesWeb's mail and MySQL servers are presumably in India, so every IMAP command and SQL query would cross ~250 ms. **Setting the functions region close to MilesWeb is essential** (needs to be checked on your Netlify plan). |
| **No static outbound IP** unless you buy Netlify **Private Connectivity** (Enterprise) | Two problems: MilesWeb **Remote MySQL** normally whitelists specific IPs, and MilesWeb can't whitelist us for IMAP/SMTP. |
| Function **request bodies are capped at ~6 MB**; **streamed responses at 20 MB** (and 60 s) | Attachments need chunked uploads and streamed or ranged downloads (§3.5). |

## 2. The MySQL-on-MilesWeb problem and the fix

Shared-hosting MySQL is built for PHP sites on the same server. Using it from serverless functions on the internet raises four issues:

1. **Remote access must be allowed in mPanel.** It's usually a "Remote MySQL / access hosts" list of IPs. Netlify has no fixed IPs, so the only way to make it work would be allowing *any* host (`%`). ❌ Not acceptable on its own.
2. **Encryption in transit:** remote MySQL on shared hosts often has **no TLS**, which would send the DB password and email metadata over the internet in plaintext. ❌ Must be verified.
3. **Connection limits:** shared plans cap connections per user (often ~10–25). Serverless functions each open their own connections and can exhaust that quickly.
4. **Latency:** an ORM makes several queries per page, so cross-continent round trips add up.

**Recommended fix: Prisma Accelerate with Static IP** (a managed connection pooler from the makers of Prisma; static IP needs its Pro or Business plan):

```
Netlify functions ──HTTPS──► Prisma Accelerate pool (region near MilesWeb, static IPs)
                                   │  MySQL protocol, ideally TLS
                                   ▼
                             MilesWeb MySQL  (Remote MySQL allowlist = Accelerate's IPs only)
```

* Solves 1: whitelist only Accelerate's published IPs instead of `%`.
* Solves 3: Accelerate keeps a small, bounded pool to MilesWeb no matter how many functions run.
* Helps 4: the functions talk to Accelerate over HTTPS with keep-alive, and the pool sits next to the database.
* Does **not** solve 2: the Accelerate → MilesWeb hop is still the public internet, so we still need MilesWeb to support TLS on remote MySQL.

**If MilesWeb doesn't offer Remote MySQL or TLS**, MySQL on MilesWeb can't be used safely from Netlify. We'd switch to a managed MySQL (e.g. a small managed instance in India with TLS and IP allowlisting), and the schema stays the same.

## 3. v1 architecture

```
Browser ──HTTPS──► Netlify  (mail.matiumtech.com)
                    Next.js (Netlify's Next.js runtime): UI + server actions + route handlers
                    ├─ sync functions:       sessions, lists, search, flag/move, open message, send
                    ├─ background functions: initial sync, backfill, bulk actions, outbox (sending)
                    └─ scheduled functions:  periodic refresh of counts/quota for active mailboxes
                         │                   │                         │
                         │ IMAPS/SMTPS       │ Prisma Accelerate       │ (built in)
                         ▼                   ▼                         ▼
                   MilesWeb mail       MilesWeb MySQL       Netlify Blobs: temporary attachment
                                                            chunks only (auto-cleaned after 24 h)
                   Master encryption key: Netlify secret environment variable (§3.3)
```

### 3.1 How mail works without an always-on worker

* **Open a folder:** read the cached list from MySQL instantly, then run a quick incremental sync. If the server supports CONDSTORE/QRESYNC, one round trip fetches changes since the last sync. The list updates when it returns.
* **Near-real-time:** while a tab is visible, the browser asks for changes every **~30–60 s**. That call checks the folder's status on the server and fetches only new or changed messages. No IDLE in v1.
* **Initial sync / backfill:** a background function syncs the newest ~2,000 messages per folder in chunks, saves its progress in MySQL, and re-invokes itself until done.
* **Open a message:** fetch and parse the body on demand, sanitise it, and return it. Attachments are downloaded separately (§3.5).
* **Send (outbox):** "Send" stores the message in an outbox row and returns immediately. A background function builds the MIME once, sends it over SMTP, saves a copy to Sent, and reports the status (sent / failed with reason). That avoids the ~10 s synchronous timeout for big messages, and makes a short "Undo send" window easy to add.
* **Connection etiquette:** each function uses one IMAP connection with short timeouts. Only one sync per mailbox runs at a time (a lock row in MySQL). Retries stop immediately on authentication failure (`NEEDS_REAUTH`), which protects against MilesWeb's lockouts.

### 3.2 Jobs, locks and rate limits without Redis

* Job queue = a `jobs` table in MySQL claimed with `SELECT … FOR UPDATE SKIP LOCKED` (MySQL 8 / MariaDB 10.6+), processed by background functions and kicked off by the request or the scheduler.
* Sync locks = a lease row per mailbox with an expiry.
* Rate limiting = Netlify's edge rate-limiting rules on `/login` and the APIs (plan-dependent), plus MySQL counters per address/IP for login attempts.
* These replace BullMQ/Redis. A schema update adds `jobs`, `mailbox_sync_leases` and `rate_limit_counters` in Phase 2.

### 3.3 Secrets without AWS KMS

With no separate engine and no cloud key service, the Netlify functions hold the master key and decrypt mailbox credentials themselves. The original "web tier can never read passwords" guarantee is gone in v1.

**Scheme (still envelope encryption, local key-wrapping):**

```
CREDENTIAL_KEK_V1  (32 random bytes, base64)  ── Netlify environment variable,
                                                  marked secret, scoped to Functions only
      │  AES-256-GCM wrap, AAD = "dek|{mailboxId}|v{version}"
      ▼
per-mailbox DEK (32 random bytes)  ── stored wrapped in mailbox_credentials.wrapped_dek
      │  AES-256-GCM, AAD = "mailbox-credential|{mailboxId}|v{version}"
      ▼
mailbox password  ── stored as ciphertext + iv + authTag
```

* `key_id` records which master key version wrapped the DEK. **Rotation:** add `CREDENTIAL_KEK_V2`, run a re-wrap job, then remove V1. The mailbox passwords themselves don't need re-encrypting.
* A database dump on its own is useless without the Netlify secret, and the secret on its own is useless without the database: they're stored with different providers (Netlify vs MilesWeb).
* Production refuses to start if the key is missing, too short or obviously a placeholder.
* **What we lose vs KMS:** no hardware-backed key, no per-decrypt audit trail from a cloud provider, and revocation means rotating the key rather than flipping a permission. We log credential-use counts per mailbox in our own audit log, and anyone with Netlify admin access can read the key, so keep that team very small and protected with 2FA.
* **Optional later:** an external secrets/KMS service (e.g. HashiCorp Vault, Infisical) behind the same `KeyProvider` interface.

### 3.4 Archiving: deferred

Not in v1. No archive storage provider, no Vault tables, no archive jobs. What v1 still does about the 5 GB limit:

* **Storage monitoring** stays: quota via IMAP `QUOTA` if available, otherwise computed usage with a manually entered limit; warnings at **70 %** and **85 %**.
* Instead of "archive old mail", the warning links to **space-saving tools that only use the live mailbox**: sort/filter by size, "messages with attachments over 5 MB", "older than 12 months", and emptying Trash/Spam. All deletions go through the normal confirm/Trash flow.
* The schema, job queue and `mail-core` streaming fetch are built so the Vault can be added later as a new module plus a migration, without reworking anything.

### 3.5 Attachments within Netlify's limits

* **Download, up to ~18 MB:** the function streams the decoded attachment straight from IMAP to the browser (streamed responses allow 20 MB / 60 s), with `Content-Disposition: attachment` and `nosniff`.
* **Download, larger:** a **ranged download**. The browser requests the attachment in ~4 MB pieces; each request uses IMAP partial fetch (`BODY.PEEK[part]<offset.length>`), decodes that slice (offsets aligned to base64 boundaries) and returns it. The browser joins the pieces into one file. This covers the largest attachments MilesWeb is likely to accept.
* **Upload (compose):** the browser splits files into ~4 MB chunks (under the ~6 MB request cap), each stored temporarily in **Netlify Blobs** under the draft's id. The outbox job reassembles them, checks type/size, and builds the message. A scheduled function deletes chunks older than 24 h. Blobs is only used here as scratch space, never as permanent storage.
* **Size limit:** compose enforces MilesWeb's real SMTP message-size limit once known (base64 adds ~33 %, so a 25 MB limit means about 18 MB of attachments).

## 4. What v1 gives up vs. the full design, and what it gains

| Area | v1 on Netlify | Full design (later) |
|---|---|---|
| New-mail latency | 30–60 s polling while the tab is open | Seconds (IDLE) |
| Static IP for MilesWeb mail | ❌ (lockout risk managed by stopping on auth errors) | ✅ |
| Password isolation from web tier | Functions can decrypt (mitigated) | Only the engine can decrypt |
| Archiving to separate storage | Deferred | Vault (original §6) |
| Servers to run | **None** | One small VPS |
| Monthly cost | Netlify plan + Accelerate Pro | + ~US$10–20 for a VPS (+ storage when archiving arrives) |

## 5. Upgrade path (designed in from day one)

All mail logic lives in `packages/mail-core` and the job handlers in `packages/jobs`, with **no Netlify-specific code inside them**. The Netlify functions are thin wrappers. Moving to an always-on worker later means running the same job handlers in a Node process on a small VPS (static IP + IDLE). No UI or schema changes, and the master key moves from Netlify to the worker, restoring the "web tier can't read passwords" guarantee.

## 6. Repository layout (updated)

```
apps/web          Next.js app deployed to Netlify (UI, server actions, route handlers)
netlify/functions thin wrappers: *-background.mts (jobs), scheduled refresh
packages/db       Prisma (MySQL) + data-access layer with mailbox authorisation
packages/mail-core ImapFlow / Nodemailer / mailparser, provider interface
packages/jobs     job definitions + MySQL-backed queue/locks (portable to a worker later)
packages/crypto, contracts, sanitize, config
```

Turborepo stays. Netlify builds `apps/web` via `netlify.toml` (base directory + Next.js runtime).

## 7. Things to verify (please check in mPanel / ask MilesWeb)

**MySQL on MilesWeb**
1. ★ Does mPanel offer **Remote MySQL** (allow external hosts)? Can we whitelist specific IPs?
2. ★ Does remote MySQL support **TLS/SSL**?
3. ★ MySQL **or MariaDB**, and which version? (We need MySQL ≥ 8.0 or MariaDB ≥ 10.6 for `SKIP LOCKED` and JSON.)
4. Limits: **max connections per user**, database size limit on your plan, and whether `CREATE TRIGGER` is permitted (for the append-only audit log).
5. Does MilesWeb back up databases, and how often? (Our own extra backup destination will be decided together with archiving later.)
6. Which **data-centre location** hosts your MilesWeb account (India / US / UK)? This decides the Netlify function region and the Accelerate pool region.

**Netlify**
7. Which **Netlify plan** (Free / Pro / Enterprise)? It affects the functions region setting, synchronous function timeout, background functions, and rate-limiting rules.

**Keys / mail limits**
8. Who will have **admin access to the Netlify team**? Those people can read the master encryption key.

9. MilesWeb's **maximum message size** for SMTP (sets the attachment limit in compose).

**Still open from earlier:** MilesWeb IMAP/SMTP host/port/security, the certificate hostname, a test mailbox, sending limits, the lockout policy, and shared mailboxes.

## Sources

- [Netlify: Background Functions](https://docs.netlify.com/build/functions/background-functions/)
- [Netlify support guide: function timeouts](https://answers.netlify.com/t/support-guide-why-is-my-function-taking-long-or-timing-out/71689)
- [Netlify: Private Connectivity (static IPs)](https://docs.netlify.com/manage/security/private-connectivity)
- [Netlify community: functions IP](https://answers.netlify.com/t/netlify-functions-ip/54054)
- [Prisma Accelerate: Static IP](https://www.prisma.io/docs/accelerate/static-ip)
- [Prisma blog: Accelerate static IP support](https://www.prisma.io/blog/accelerate-static-ip-support)
- [Prisma Accelerate getting started](https://docs.prisma.io/docs/accelerate/getting-started)
- [Netlify forum: function request body size](https://answers.netlify.com/t/maximum-body-size-for-netlify-function-post/22607)
- [Netlify Functions API (streaming limits)](https://docs.netlify.com/functions/api/)
- [Netlify Blobs vs Vercel Blob (Netlify knowledge base)](https://www.netlify.com/knowledge-base/netlify-blobs-vs-vercel-blob/)
- [Vercel Blob vs Netlify Blobs (Vercel KB)](https://vercel.com/kb/guide/vercel-blob-vs-netlify-blobs)
