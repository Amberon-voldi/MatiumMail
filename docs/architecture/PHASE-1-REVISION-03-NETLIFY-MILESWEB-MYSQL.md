# Phase 1 — Revision 03: Netlify hosting + MySQL on MilesWeb

> Status: **Proposal — awaiting approval. Current.**
> Supersedes Revision 02 (AWS Amplify) and Revision 01 (Cloudflare). The MySQL schema notes in [Revision 01 §4](./PHASE-1-REVISION-01-CLOUDFLARE-MYSQL.md#4-mysql-changes) still apply, and [`schema.draft.prisma`](./schema.draft.prisma) (MySQL, Prisma 7) is unchanged.
> Unchanged from [`PHASE-1-ARCHITECTURE.md`](./PHASE-1-ARCHITECTURE.md): library choices for the mail side, the Vault workflow (verify before removal, explicit confirmation), HTML sanitisation and the security model.
> **No AWS is involved.** Archive storage and key management are replaced as described in §3.3 and §3.4. (AWS S3 and KMS in the original document are superseded.)
> "For now" is taken to mean: **v1 runs on Netlify + MilesWeb (+ one S3-compatible storage provider), with no server of our own**, and the code is structured so an always-on mail worker can be added later without a rewrite.

## 1. Platform facts that shape v1

| Fact | Impact |
|---|---|
| Netlify runs Next.js server code in **serverless functions** (request-scoped) | No long-lived IMAP connections and no IDLE. Every mail operation opens a connection, logs in, works and disconnects. |
| Synchronous functions time out at **~10 s by default** (raised on paid plans); **background functions** run up to **15 min** (asynchronous, with automatic retries); **scheduled functions** run on a cron | Interactive actions must stay small. Initial sync, bulk actions and archiving run as chunked background jobs. |
| Functions run in **one region (US East by default)** | MilesWeb's mail and MySQL servers are presumably in India, so every IMAP command and SQL query would cross ~250 ms. **Setting the functions region close to MilesWeb is essential** (needs to be checked on your Netlify plan). |
| **No static outbound IP** unless you buy Netlify **Private Connectivity** (Enterprise) | Two problems: MilesWeb **Remote MySQL** normally whitelists specific IPs, and MilesWeb can't whitelist us for IMAP/SMTP. |
| Function responses are size-limited | Attachments go through short-lived presigned storage URLs, never through a function. |

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
                    ├─ background functions: initial sync, backfill, bulk actions, Vault archive/restore
                    └─ scheduled functions:  periodic refresh of counts/quota for active mailboxes
                         │                   │                         │
                         │ IMAPS/SMTPS       │ Prisma Accelerate       │ HTTPS (S3-compatible API)
                         ▼                   ▼                         ▼
                   MilesWeb mail       MilesWeb MySQL       Archive store: Vault bucket + transfer bucket
                                                            (provider TBD, §3.4; not AWS)
                   Master encryption key: Netlify secret environment variable (§3.3)
```

### 3.1 How mail works without an always-on worker

* **Open a folder:** read the cached list from MySQL instantly, then run a quick incremental sync. If the server supports CONDSTORE/QRESYNC, one round trip fetches changes since the last sync. The list updates when it returns.
* **Near-real-time:** while a tab is visible, the browser asks for changes every **~30–60 s**. That call checks the folder's status on the server and fetches only new or changed messages. No IDLE in v1.
* **Initial sync / backfill:** a background function syncs the newest ~2,000 messages per folder in chunks, saves its progress in MySQL, and re-invokes itself until done.
* **Open a message:** fetch and parse the body on demand, sanitise it, and return it. Attachments go to the transfer bucket (objects auto-expire after 1 day) and come back as a 60-second presigned link.
* **Send:** build the message once, send it over SMTP, and save a copy to Sent. Large attachments are uploaded to the transfer bucket first, via presigned PUT, and validated server-side before sending.
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

### 3.4 Archive storage without AWS S3

The Vault needs: durability (it becomes the only copy once originals are removed), large objects, short-lived download/upload links (to keep big attachments off Netlify functions), versioning or deletion protection, and cheap storage.

| Option | Fit | Notes |
|---|---|---|
| **S3-compatible provider**, e.g. Backblaze B2, Wasabi, Cloudflare R2, or a MilesWeb object-storage product if your account has one | ✅ **Recommended** | Standard S3 API (we use a generic S3 client library, pointed at the provider's endpoint, with no AWS account), presigned links, versioning / Object Lock on B2/Wasabi, low cost (e.g. B2 ≈ US$6 per TB-month). Separate from MilesWeb, so a hosting problem can't take the archive with it. |
| **Netlify Blobs** (built into Netlify) | ⚠️ Possible, not recommended for the Vault | Zero extra accounts and objects up to 5 GB, but no public/presigned URLs (every download streams through a function and hits response limits), no versioning or deletion lock, no published durability figure, and it's tied to the Netlify site. Fine for small temporary data. |
| Files on MilesWeb hosting disk | ❌ | Counts against the same hosting disk/inode limits we're trying to relieve, and it's on the same provider as the live mail. |

**Provider-neutral verification** (some S3-compatible providers don't support SHA-256 upload checksums): compute SHA-256 while downloading from IMAP → upload with `Content-MD5` (the provider rejects corrupted uploads) → **read the object back and re-hash it** before marking it `VERIFIED`. Emails are small, so the extra read is cheap, and it's the strongest check anyway. The `ArchiveStore` interface keeps the provider swappable.

## 4. What v1 gives up vs. the full design, and what it gains

| Area | v1 on Netlify | Full design (later) |
|---|---|---|
| New-mail latency | 30–60 s polling while the tab is open | Seconds (IDLE) |
| Static IP for MilesWeb mail | ❌ (lockout risk managed by stopping on auth errors) | ✅ |
| Password isolation from web tier | Functions can decrypt (mitigated) | Only the engine can decrypt |
| Big archive batches | Chunked background functions (slower, but resumable) | Dedicated worker |
| Servers to run | **None** | One small VPS |
| Monthly cost | Netlify plan + Accelerate Pro + archive storage (a few US$ per TB) | + ~US$10–20 for a VPS |

## 5. Upgrade path (designed in from day one)

All mail logic lives in `packages/mail-core` and the job handlers in `packages/jobs`, with **no Netlify-specific code inside them**. The Netlify functions are thin wrappers. Moving to an always-on worker later means running the same job handlers in a Node process on a small VPS (static IP + IDLE). No UI or schema changes, and the master key moves from Netlify to the worker, restoring the "web tier can't read passwords" guarantee.

## 6. Repository layout (updated)

```
apps/web          Next.js app deployed to Netlify (UI, server actions, route handlers)
netlify/functions thin wrappers: *-background.mts (jobs), scheduled refresh
packages/db       Prisma (MySQL) + data-access layer with mailbox authorisation
packages/mail-core ImapFlow / Nodemailer / mailparser, provider interface
packages/jobs     job definitions + MySQL-backed queue/locks (portable to a worker later)
packages/storage  ArchiveStore interface + S3-compatible implementation
packages/crypto, contracts, sanitize, config
```

Turborepo stays. Netlify builds `apps/web` via `netlify.toml` (base directory + Next.js runtime).

## 7. Things to verify (please check in mPanel / ask MilesWeb)

**MySQL on MilesWeb**
1. ★ Does mPanel offer **Remote MySQL** (allow external hosts)? Can we whitelist specific IPs?
2. ★ Does remote MySQL support **TLS/SSL**?
3. ★ MySQL **or MariaDB**, and which version? (We need MySQL ≥ 8.0 or MariaDB ≥ 10.6 for `SKIP LOCKED` and JSON.)
4. Limits: **max connections per user**, database size limit on your plan, and whether `CREATE TRIGGER` is permitted (for the append-only audit log).
5. Does MilesWeb back up databases, and how often? (We'll also take our own nightly encrypted logical backup to the archive storage provider.)
6. Which **data-centre location** hosts your MilesWeb account (India / US / UK)? This decides the Netlify function region and the Accelerate pool region.

**Netlify**
7. Which **Netlify plan** (Free / Pro / Enterprise)? It affects the functions region setting, synchronous function timeout, background functions, and rate-limiting rules.

**Storage / keys**
8. ★ Which **archive storage provider**? Recommended: an S3-compatible one (Backblaze B2 or Wasabi), or tell me if MilesWeb offers object storage on your account. Or accept Netlify Blobs with its limitations.
9. Who will have **admin access to the Netlify team**? Those people can read the master encryption key.

**Still open from earlier:** MilesWeb IMAP/SMTP host/port/security, the certificate hostname, a test mailbox, sending limits, the lockout policy, and shared mailboxes.

## Sources

- [Netlify: Background Functions](https://docs.netlify.com/build/functions/background-functions/)
- [Netlify support guide: function timeouts](https://answers.netlify.com/t/support-guide-why-is-my-function-taking-long-or-timing-out/71689)
- [Netlify: Private Connectivity (static IPs)](https://docs.netlify.com/manage/security/private-connectivity)
- [Netlify community: functions IP](https://answers.netlify.com/t/netlify-functions-ip/54054)
- [Prisma Accelerate: Static IP](https://www.prisma.io/docs/accelerate/static-ip)
- [Prisma blog: Accelerate static IP support](https://www.prisma.io/blog/accelerate-static-ip-support)
- [Prisma Accelerate getting started](https://docs.prisma.io/docs/accelerate/getting-started)
- [Netlify Blobs vs Vercel Blob (Netlify knowledge base)](https://www.netlify.com/knowledge-base/netlify-blobs-vs-vercel-blob/)
- [Vercel Blob vs Netlify Blobs (Vercel KB)](https://vercel.com/kb/guide/vercel-blob-vs-netlify-blobs)
