# Matium Mail

Branded webmail for Matium and partner domains, on top of MilesWeb mail hosting (IMAP/SMTP).
Next.js 16 · TypeScript · Tailwind 4 · shadcn/ui · Prisma 7 on MariaDB 11.4.

Architecture and decisions: [`docs/architecture/`](docs/architecture/) — start with
[`PHASE-1-ARCHITECTURE.md`](docs/architecture/PHASE-1-ARCHITECTURE.md), then the revisions, and
[`MAIL-SERVERS.md`](docs/architecture/MAIL-SERVERS.md) for the verified infrastructure facts.

## Requirements

- Node.js 22+
- Access to the MilesWeb MariaDB (`matiumte1_matiummail`) — dev and production share it; there is no local database
- Docker only for the IMAP integration tests (GreenMail)

## Setup

```bash
npm install                 # also generates the Prisma client
cp .env.example .env        # then fill in DB_PASSWORD, DB_TLS_CA_PEM_BASE64, CREDENTIAL_KEYS (see comments)
npm run db:status:remote    # check the connection (pinned TLS) and pending migrations
npm run db:migrate:remote   # apply migrations
npm run setup -- config/setup.example.json   # provision org, server profile, domains, allowed users
npm run dev                 # http://localhost:3000 (or the next free port)
```

Sign in with an allowlisted mailbox address and its mailbox password. The password is verified
against the mail server over TLS and stored envelope-encrypted (`CREDENTIAL_KEYS`).

> The encryption key in `CREDENTIAL_KEYS` must be identical locally and on Netlify, because both
> use the same database. Losing it means every user has to sign in again (stored passwords become
> unreadable); leaking it, together with a database copy, exposes mailbox passwords.

## Adding people and domains

Edit a copy of `config/setup.example.json` (e.g. `config/setup.local.json`, gitignored) and re-run
`npm run setup -- <file>`. It is idempotent and never deletes anything. No code changes needed.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Dev server |
| `npm run build` | Prisma generate + production build |
| `npm test` | Unit + integration tests (GreenMail tests skip if Docker isn't running) |
| `npm run typecheck` / `npm run lint` | Type-check / lint |
| `npm run db:status:remote` | Show applied / pending migrations on the configured DB |
| `npm run db:migrate:remote` | Apply pending migrations over pinned TLS |
| `npm run setup -- <config.json>` | Provision org, server profiles, domains, users |
| `npm run keys:generate` | Print a new random 32-byte key (base64) |
| `npm run dev:infra` | Start GreenMail (tests only) |

## Security model (short)

- Login: allowlist check before any IMAP connection → IMAP LOGIN over verified TLS → session
- Sessions: random token in an HttpOnly cookie (`__Host-` in production); only its SHA-256 is stored
- Rate limits per IP and per address (MariaDB-backed); append-only audit log enforced by DB triggers
- Database: TLS pinned to the MariaDB server certificate; plaintext only possible for localhost
- Mailbox passwords: AES-256-GCM envelope encryption bound to the mailbox id and version
