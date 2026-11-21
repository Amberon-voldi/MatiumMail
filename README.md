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
cp .env.example .env        # then fill in DB_PASSWORD, CREDENTIAL_KEYS (see comments)
npm run db:status:remote    # check the connection (pinned TLS) and pending migrations
npm run db:migrate:remote   # apply migrations
npm run setup -- config/setup.example.json   # provision org, server profile, domains, allowed users
npm run dev                 # http://localhost:3000 (or the next free port)
```

Sign in with an allowlisted mailbox address and its mailbox password. The password is verified
against the mail server over TLS and stored envelope-encrypted (`CREDENTIAL_KEYS`).

- **Matium Mail password** (Accounts → Set short password): an optional shorter sign-in password
  (6+ characters, scrypt-hashed), for when the host's mailbox password rules are too long to type.
  The mailbox password keeps working and stays the root of trust: if it's changed in mPanel, the
  short password stops working until the new mailbox password has been entered once (at sign-in,
  or on the mailbox's "Update mailbox password" page).
- **Several accounts at once** (Accounts → Add another account): one browser can be signed in to
  up to 10 addresses; all their mailboxes are open together, and each can be signed out separately.

> The encryption key in `CREDENTIAL_KEYS` must be identical locally and on Netlify, because both
> use the same database. Losing it means every user has to sign in again (stored passwords become
> unreadable); leaking it, together with a database copy, exposes mailbox passwords.

## Mail app

The mail page (`/mail/<mailboxId>`) is a single-page app: the server renders the first screen, then
the browser talks to the JSON API in `src/app/api/mail/<mailboxId>/…` (route handlers, so requests run
in parallel — Server Actions would queue behind a slow sync).

- **Conversations**: messages are grouped by thread (References/In-Reply-To), across Inbox and Sent.
- **Images in email** load through a privacy proxy (`/api/img`, HMAC-signed URLs, SSRF-safe), so
  senders never see the reader's IP and http:// images work on https. Tracking pixels are dropped.
  Settings → "Show images automatically" switches to ask-first.
- **Attachments**: preview/download; files over ~4.5 MB download in pieces (AWS Amplify caps a
  response at ~5.7 MB). Composer uploads go in 1.5 MB chunks into `compose_uploads` (20 MB total).
- **Composer**: rich text, reply / reply all / forward (with the original's attachments), drafts in
  the IMAP Drafts folder, autocomplete, local autosave.
- **Phones**: one pane at a time, folder drawer, swipe a row to archive/mark read, pull to refresh;
  installable (manifest + MatiumTech icons). After sign-in, phones and tablets are offered "Add to
  Home Screen" (Android: the browser's own install prompt; iOS: the Share → Add to Home Screen steps).
  "Not now" hides it for two weeks; the account menu's "Install app" brings it back.
- Keyboard shortcuts on desktop (`?` lists them). Older mail is fetched from the server on scroll.

## Restoring an old Gmail export

`tools/import-gmail-export.mjs` puts the messages of an "SP Mail" viewer export (`data/<account>.js`)
back into their IMAP mailboxes, asking for each mailbox password (hidden). The export only has the
text of each email and the names of its attachments, so restored mail is cleaned-up text with simple
HTML, not the original design. Re-running it is safe; copies from an older version are replaced in
place (same folder, read/starred kept).

```bash
node tools/import-gmail-export.mjs ~/Downloads/gmail-clone --dry-run   # what would go where
node tools/import-gmail-export.mjs ~/Downloads/gmail-clone             # restore / update
```

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
