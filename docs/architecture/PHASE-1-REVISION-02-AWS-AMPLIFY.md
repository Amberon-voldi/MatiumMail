# Phase 1 — Revision 02: AWS Amplify Hosting + MySQL

> Status: **Superseded by [Revision 03 (Netlify + MilesWeb MySQL)](./PHASE-1-REVISION-03-NETLIFY-MILESWEB-MYSQL.md).**
> **Supersedes Revision 01 (Cloudflare).** The frontend is hosted on **AWS Amplify Hosting**; the database is **MySQL 8**.
> Unchanged from [`PHASE-1-ARCHITECTURE.md`](./PHASE-1-ARCHITECTURE.md): IMAP sync strategy, credential envelope encryption, the S3 Vault workflow, the security model and the library choices for the mail side.
> Schema: [`schema.draft.prisma`](./schema.draft.prisma) (MySQL, validates with Prisma 7) — unchanged by this revision.

## 1. Amplify constraints that shape the design

| Fact | Impact |
|---|---|
| Amplify Hosting runs Next.js server code on managed, Lambda-style compute (request-scoped) | No long-lived IMAP connections, no IDLE, no background jobs in the Next.js app. A separate always-on mail service is still required. |
| Amplify SSR compute **cannot be attached to a VPC** | It can't reach a private RDS MySQL or a private backend directly. |
| Amplify supports an **IAM compute role** for server-side code | The Next.js server can call AWS APIs (e.g. a private API Gateway, S3) with an IAM identity — no shared secrets. |
| No static outbound IP from Amplify compute | Another reason the IMAP/SMTP traffic must come from our own server with an Elastic IP (MilesWeb whitelisting). |
| Server responses are size- and time-limited (Lambda-based) | Attachments must not stream through Amplify. Use short-lived S3 presigned URLs for uploads and downloads. |
| Amplify documents support for specific Next.js major versions | We pin the newest Next.js version Amplify officially supports at setup time (to verify on day one). |

## 2. Recommended design: everything in AWS `ap-south-1` (Mumbai)

```
Browser ──HTTPS──► AWS Amplify Hosting  (mail.matiumtech.com, + AWS WAF)
                     Next.js: UI, server actions, thin BFF
                     • holds the session cookie, CSRF/origin checks
                     • NO database credentials, NO mailbox secrets
                     │  SigV4-signed requests using the Amplify IAM compute role
                     ▼
                 API Gateway (HTTP API, IAM authorisation)
                     │  VPC Link (private)
                     ▼
┌──────────────────────── VPC ──────────────────────────────────────────┐
│  backend (EC2, e.g. t4g.small, Docker)  — public subnet + Elastic IP  │
│   • api: Fastify — sessions, authorisation, mail data, contacts,      │
│     search, archive, admin  (Prisma, native Node)                     │
│   • engine: ImapFlow/Nodemailer, IDLE, sync, send, Vault jobs         │
│   • Redis + BullMQ (local)                                            │
│   • security group: inbound ONLY from the VPC Link; no public ports   │
│   • outbound to MilesWeb from the Elastic IP (whitelistable)          │
│                                                                       │
│  RDS MySQL 8 (private subnet, encrypted, automated backups)           │
└───────────────────────────────────────────────────────────────────────┘
        │ instance IAM role
        ▼
   S3 (Vault bucket + short-lived transfer bucket)   KMS (credential key, Vault key)
```

### Key changes vs. the original plan

1. **The backend owns all data access.** Because Amplify can't reach a private database, the Next.js app no longer reads the database directly. It calls one private backend API for everything (lists, search, contacts, actions). The backend is the only thing that touches MySQL, IMAP/SMTP, KMS and S3. That's simpler and more secure: the Amplify side holds no database password and no mailbox secrets.
2. **Web → backend is authenticated by AWS IAM**, not a shared secret. API Gateway only accepts requests signed with the Amplify compute role; the backend has no public inbound ports at all. The backend then validates the user's session token on every request.
3. **Static IP without a NAT Gateway:** the EC2 instance sits in a public subnet with an Elastic IP for outbound IMAP/SMTP, but its security group allows inbound traffic only from the VPC Link. That avoids NAT Gateway cost (~US$35+/month).
4. **Attachments via S3 presigned URLs:**
   - *Download:* the backend fetches the attachment from IMAP, writes it to a transfer bucket (objects auto-delete after 1 day via lifecycle), and returns a 60-second presigned URL.
   - *Upload (compose):* the browser uploads straight to the transfer bucket with a presigned PUT (size- and type-limited); the backend validates it before attaching.
5. **Near-real-time updates:**
   - v1: the backend keeps IDLE connections to MilesWeb and records changes; the browser polls a cheap "changes since cursor" endpoint every ~15 s while the tab is visible. New mail shows within seconds of IDLE plus up to ~15 s.
   - Later, if needed: push via **AWS AppSync Events** (managed WebSockets), with no change to the backend logic.
   - Server-sent events are dropped because API Gateway HTTP APIs cut requests after ~30 s.
6. **Login and rate limiting:** **AWS WAF** rate-based rules on Amplify, plus per-address and per-IP limits in the backend (Redis). The password passes through Amplify compute in memory only and is never logged.

### Why not the alternatives

| Alternative | Why not |
|---|---|
| Public RDS endpoint so Amplify can connect directly | Exposes MySQL port 3306 to the internet, because Amplify has no fixed IP to whitelist. |
| Aurora MySQL + RDS Data API (HTTP, IAM-auth) | Works from Amplify without a VPC, but Prisma has no official Data API driver, and Aurora costs more than small RDS. |
| VPC Lambda proxy per operation | More moving parts than one API Gateway → backend route. |
| MySQL on MilesWeb shared hosting | Remote access normally needs IP whitelisting and it's shared, small and backed up on the host's terms. Keep it out of the critical path. |

## 3. Monorepo (updated)

```
apps/web        Next.js on Amplify (UI + thin BFF, signs requests with SigV4)
apps/backend    Fastify API + mail engine + BullMQ workers (one deployable, Docker)
packages/db, mail-core, crypto, contracts, sanitize, config   (as before)
infra/          AWS CDK (TypeScript): VPC, EC2, RDS, API Gateway + VPC Link,
                S3 buckets, KMS keys, IAM roles, WAF — reproducible infrastructure
```

`api` and `engine` start as one process on one instance. They can be split later without code changes, because they communicate through the queue and a shared module boundary.

## 4. Rough monthly cost (Mumbai, small team)

| Item | Approx. |
|---|---|
| Amplify Hosting (build minutes + SSR requests) | US$1–5 |
| EC2 t4g.small + 30 GB gp3 + Elastic IP | US$15–20 |
| RDS MySQL db.t4g.micro, 20 GB, automated backups | US$15–20 |
| API Gateway HTTP API + VPC Link | < US$2 at this scale |
| KMS (2 keys) | ~US$2 |
| WAF (web ACL + a few rules) | ~US$6–8 |
| S3 Vault | by volume (~US$0.025/GB-month Standard) |
| **Total excluding Vault storage** | **≈ US$40–60** |

Cheaper variant: MySQL in Docker on the same EC2 instance, with nightly encrypted dumps to S3 (saves ~US$15–20, but we own backup and restore testing).

## 5. Questions for this revision

1. Confirm: **AWS Amplify Hosting** replaces Cloudflare, and the MySQL database lives in AWS (**RDS MySQL**, recommended) rather than on MilesWeb.
2. **RDS** (managed backups) or **MySQL on the EC2 instance** (cheaper)?
3. Is there an AWS account ready? Is `ap-south-1` (Mumbai) OK as the region?
4. OK to use **AWS CDK** to define the infrastructure (repeatable, reviewable), rather than clicking resources together in the console?
5. Is ~15-second polling acceptable for v1 "near-real-time", with AppSync Events push as a later upgrade?

## Sources

- [Amplify Hosting: Next.js support](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-amplify-support.html)
- [Amplify Hosting: deploying a Next.js SSR app](https://docs.aws.amazon.com/amplify/latest/userguide/deploy-nextjs-app.html)
- [AWS blog: IAM compute roles for SSR with Amplify Hosting](https://aws.amazon.com/blogs/mobile/iam-compute-roles-for-server-side-rendering-with-aws-amplify-hosting)
- [AWS blog: accessing VPC resources from Next.js API routes on Amplify](https://aws.amazon.com/blogs/mobile/accessing-resources-in-a-amazon-virtual-private-cloud-amazon-vpc-from-next-js-api-routes)
- [re:Post: Amplify access to a private VPC](https://repost.aws/questions/QURiQk6XQLRcevFZcrcVH9yQ/how-to-aws-amplify-access-to-private-vpc)
- [Aurora MySQL now supports RDS Data API](https://aws.amazon.com/about-aws/whats-new/2024/09/amazon-aurora-mysql-rds-data-api)
