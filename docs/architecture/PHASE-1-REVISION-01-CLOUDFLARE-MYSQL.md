# Phase 1 — Revision 01: Cloudflare hosting + MySQL

> Status: **Proposal — awaiting approval.**
> Supersedes the hosting (D8) and database parts of [`PHASE-1-ARCHITECTURE.md`](./PHASE-1-ARCHITECTURE.md). Everything else (sync strategy, credential encryption, Vault workflow, security model) still applies.
> Schema: [`schema.draft.prisma`](./schema.draft.prisma) now targets **MySQL 8.0+** and validates with Prisma 7.

## 1. What changes with Cloudflare

### 1.1 "Pages" vs Workers for Next.js
Cloudflare's supported way to run a full-stack Next.js app is now the **OpenNext adapter (`@opennextjs/cloudflare`) on Cloudflare Workers**. The old Pages adapter (`@cloudflare/next-on-pages`) is deprecated and only supports the Edge runtime. It's still the same Cloudflare account, dashboard, custom domain (`mail.matiumtech.com`) and git-based deploys; only the product name differs. **Plan: deploy the Next.js app to Workers via OpenNext.**

### 1.2 Cloudflare runtime facts that affect a mail client

| Fact | Impact |
|---|---|
| Workers can open **outbound** TCP/TLS sockets (`cloudflare:sockets`, and `node:net`/`node:tls` client APIs under `nodejs_compat`) | IMAP (993) and SMTP (465/587) are *technically reachable* from a Worker. Port 25 is blocked (we don't need it). |
| A Worker lives for one request; sockets must be opened inside a handler | No IMAP **IDLE**, no background sync, no connection reuse in plain Workers. Each action would cost a full TLS + IMAP LOGIN round trip. |
| **No static egress IP** for `connect()` sockets; the dedicated-egress products don't cover TCP sockets | MilesWeb can't whitelist us, and its brute-force/firewall protection could block Cloudflare's shared source addresses. That's a serious operational risk for shared hosting. |
| 128 MB memory per isolate | Parsing/archiving a 25–50 MB email with attachments in a Worker risks out-of-memory errors. |
| ImapFlow / Nodemailer / mailparser are written for Node.js | Running them on workerd is **unverified**. Workers-native alternatives exist (`postal-mime` for parsing; smaller SMTP libraries) but the IMAP side would be largely custom. |

## 2. Recommended design: Option A, hybrid (Cloudflare front, small mail-engine server)

```
Browser ──HTTPS──► Cloudflare (WAF, Turnstile, rate limiting)
                     │
                     ▼
            web: Next.js on Workers (OpenNext)
              • UI, sessions, authorisation, sanitised rendering
              • MySQL via Hyperdrive (pooled)
              • no mailbox secrets, no KMS access
                     │  Cloudflare Tunnel (private, no open ports)
                     │  + Cloudflare Access service token + signed JWT
                     ▼
            mail-engine: Node.js container on a small VPS with a STATIC IP
              • ImapFlow / Nodemailer / mailparser (unchanged)
              • IDLE watchers, sync, send, Vault archive/restore
              • BullMQ + Redis (local to the VPS)
              • only holder of KMS decrypt
                 │ IMAPS/SMTPS (static IP, whitelistable)   │ HTTPS
                 ▼                                           ▼
            MilesWeb mail servers                     AWS S3 + KMS
```

* **What runs on Cloudflare:** everything the user touches (UI, API, login, search, lists), so it's fast and globally cached. **Turnstile** on the login form plus the **Workers Rate Limiting binding** replace Redis-based login rate limiting in `web`.
* **What runs on the VPS:** only `mail-engine` + Redis (and MySQL if you want it there). It's reachable *only* through a Cloudflare Tunnel, so no inbound ports are open. Roughly US$6–15/month (e.g. Lightsail Mumbai, DigitalOcean Bangalore).
* **Real-time updates:** the Worker relays a server-sent-events stream from the engine through the Tunnel. If that proves costly or flaky, a Durable Object WebSocket hub (with hibernation) is the fallback.
* **Why this is recommended:** it keeps every safety property of the original design (static IP for MilesWeb, IDLE, a connection budget, large-message streaming, a proven IMAP/SMTP library stack, secrets isolated from the web tier) while the product is hosted on Cloudflare.

## 3. Alternative: Option B, all-Cloudflare (not recommended for v1)

* A Durable Object per mailbox holds the IMAP socket and handles IDLE; Queues run archive jobs; Cron Triggers handle polling; or Cloudflare Containers for the engine.
* **Risks:** no static IP (MilesWeb lockouts and firewalling can't be fixed by whitelisting), largely custom IMAP code on an unverified runtime, memory limits for large emails, and Durable Objects billed for as long as sockets stay open.
* Could be revisited later once the hybrid is stable; the provider abstraction in `packages/mail-core` keeps that door open.

## 4. MySQL changes

| Topic | Postgres plan | MySQL plan |
|---|---|---|
| Version | Postgres 16 | **MySQL 8.0+** (InnoDB, `utf8mb4`). MariaDB works with Prisma's `mysql` provider but has weaker JSON support. Please confirm which one you have. |
| IDs | `uuid` type | UUIDv7 stored as `CHAR(36)` |
| Arrays (flags, references) | `text[]` | `JSON` |
| Search | `tsvector` + trigram | **InnoDB `FULLTEXT`** indexes (`@@fulltext`) on message metadata, archive metadata and contacts; prefix `LIKE 'abc%'` on indexed columns for autocomplete |
| JSON defaults | DB defaults | Not allowed for JSON in MySQL, so the data-access layer writes them explicitly |
| Append-only audit log | per-table grants | per-table grants if the host allows them, otherwise `BEFORE UPDATE/DELETE` triggers that raise an error |
| Access from Workers | — | **Hyperdrive** (MySQL support is GA). **Prisma's MySQL driver adapter on Workers needs a day-one spike**; if it doesn't work, `web` uses Drizzle ORM or `mysql2` for its read paths while `mail-engine` (Node) keeps native Prisma. |

Note on search quality: InnoDB FULLTEXT ignores words shorter than 3 characters by default and does natural-language/boolean matching rather than ranked fuzzy search. That's fine for subject/sender/preview search; full-body search still goes to IMAP `SEARCH` or (for the Vault) the archived text excerpt.

## 5. Where should MySQL live? (important)

| Option | Verdict |
|---|---|
| **MilesWeb shared-hosting MySQL** | ⚠️ Likely **not workable**. Shared-hosting MySQL normally allows remote connections only from whitelisted IPs, and Cloudflare/Hyperdrive has no static IP. It's also small, shared, and backed up on the host's terms. |
| **On the mail-engine VPS** (Docker) | ✅ Cheapest. Reachable from Hyperdrive through the same Cloudflare Tunnel. We own the backups (nightly dump to S3). |
| **Managed MySQL** (AWS RDS Mumbai, Aiven, DigitalOcean, etc.) | ✅ Best durability and automated backups; more expensive (~US$15–30/month). |

## 6. New questions

1. **Option A (hybrid) vs Option B (all-Cloudflare)?** Recommended: A.
2. **Where is / will the MySQL database be hosted**, and is it MySQL 8 or MariaDB?
3. For Option A: is a small VPS acceptable? Which provider (AWS Lightsail Mumbai keeps it near S3 and India)?
4. S3 stays on AWS as originally specified. Cloudflare **R2** is an alternative (no egress fees, same account), but you asked for S3, so I'm keeping S3 unless you say otherwise.

## Sources

- [OpenNext Cloudflare adapter](https://opennext.js.org/cloudflare)
- [Cloudflare blog: deploying Next.js apps to Workers with the OpenNext adapter](https://blog.cloudflare.com/deploying-nextjs-apps-to-cloudflare-workers-with-the-opennext-adapter/)
- [Workers TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
- [Workers `node:tls`](https://developers.cloudflare.com/workers/runtime-apis/nodejs/tls)
- [Workers Node.js net/dns support changelog](https://developers.cloudflare.com/changelog/2025-01-28-nodejs-compat-improvements)
- [Dedicated egress IPs with other products (TCP sockets not covered)](https://developers.cloudflare.com/smart-shield/configuration/dedicated-egress-ips/other-products/)
- [Hyperdrive MySQL GA changelog](https://developers.cloudflare.com/changelog/post/2026-08-07-hyperdrive-mysql-ga/)
- [Cloudflare blog: building global MySQL apps with Workers and Hyperdrive](https://blog.cloudflare.com/building-global-mysql-apps-with-cloudflare-workers-and-hyperdrive/)
