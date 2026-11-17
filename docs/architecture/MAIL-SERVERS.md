# Infrastructure facts: mail, DNS, database

> **Verified 2026-11-17** from the MilesWeb client area, mPanel, the Cloudflare dashboard (read-only), public DNS, and direct connection tests run from the owner's Mac with `tools/probe-mail-server.mjs`. Nothing was changed in any account.
> Still unverified: everything that needs a mailbox login (post-login IMAP capabilities, quota over IMAP, folder names). See "Still to verify" at the end.

## 1. Hosting account (MilesWeb)

| Item | Value |
|---|---|
| Plan | **Premium** (shared hosting, mPanel), active, renews 17 Nov 2027 |
| Primary domain | `matiumtech.com` |
| Addon domains | `noida.fit`, `spinternationalpvtltd.com` |
| Server | one server for web, mail and MySQL: **45.199.139.26** (`solaris.herosite.pro`) |
| Limits | 50 GB disk · unlimited bandwidth · 50 email accounts (1 used) · 350 databases (1 used) |
| Mailbox quota | 5 GB per mailbox by default, adjustable in mPanel (up to the plan's 50 GB) |
| Node.js apps | **Not included** (mPanel shows "Upgrade") |
| PHP | 8.2, with `pdo_mysql`, `mysqli`, `imap`, `mailparse`, `openssl`, `sodium`, `redis` |
| SSH | Available (password or keys) |
| Backups | **Automatic daily**: files, databases and mailboxes |
| Website TLS (mPanel) | All three domains show **self-signed** certificates for websites. Not relevant to the mail servers (below) or to Cloudflare-proxied sites. |

## 2. Mail server

| | IMAP | SMTP submission |
|---|---|---|
| Software | Dovecot (Ubuntu) | Postfix (Ubuntu) |
| Host to use | **`mail.spinternationalpvtltd.com`** (for both domains, see below) | same |
| Ports | **993 implicit TLS** (143 is also open; never used) | **465 implicit TLS** (primary), **587 STARTTLS** (fallback); 25 blocked from this network |
| Certificate | Let's Encrypt, valid for `mail.spinternationalpvtltd.com`, expires Feb 2027 (auto-renewing) | same certificate on 465 and 587, valid |
| Auth | `AUTH=PLAIN AUTH=LOGIN`, username = full email address | `AUTH PLAIN LOGIN`, username = full email address |
| Pre-login capabilities | `IMAP4rev1 SASL-IR LOGIN-REFERRALS ID ENABLE IDLE LITERAL+` | `SIZE 102400000` (≈ 97 MB), `PIPELINING`, `8BITMIME`, `SMTPUTF8`, `CHUNKING`, `DSN` |
| Greeting time | ~0.3–0.6 s | ⚠️ **~23 s, every time, both ports** (see §5) |

**`mail.noida.fit` presents a self-signed certificate** (`CN=mail.noida.fit`). Because both domains are on the same Dovecot/Postfix server and logins use the full address, **the app connects to `mail.spinternationalpvtltd.com` for noida.fit mailboxes too**. That gives one server profile with a valid certificate, and certificate checks are never disabled. If MilesWeb later issues a real certificate for `mail.noida.fit`, nothing needs to change.

mPanel's own "Email client settings" page lists exactly these settings (IMAP 993 SSL, SMTP 465 SSL / 587 STARTTLS, POP 995 SSL).

## 3. Domains and DNS (all DNS on Cloudflare, free plan)

### `spinternationalpvtltd.com`: live
* MX `0 mail.spinternationalpvtltd.com` → 45.199.139.26 (DNS only) ✅
* SPF `v=spf1 ip4:45.199.139.26 +mx include:relay.mailbaby.net include:_spf.mx.cloudflare.net ~all` ✅ (MilesWeb relays outbound mail through MailBaby)
* DKIM `hostingcp._domainkey` (MilesWeb) ✅ · DMARC `p=quarantine` ✅
* Leftovers that can be cleaned up later: Zoho verification + `zmail._domainkey`, Cloudflare Email Routing DKIM `cf2024-1`, Squarespace `_domainconnect`.
* Mailbox: `info@spinternationalpvtltd.com` (5 GB, DKIM configured).

### `noida.fit`: hosting ready, mail not switched yet
* MX is still **Cloudflare Email Routing** (`route1/2/3.mx.cloudflare.net`; locked while Email Routing is enabled).
* `mail.noida.fit` A → 45.199.139.26 ✅; `imap/pop/smtp.noida.fit` CNAME → `mail.noida.fit` ✅
* DKIM `hostingcp._domainkey` (MilesWeb) already published ✅ · DMARC `p=none`
* ⚠️ **Apex SPF only allows Cloudflare**: `v=spf1 include:_spf.mx.cloudflare.net ~all`. Mail sent from `@noida.fit` through MilesWeb would fail SPF.
* Other mail services on this domain (keep them): **Resend / Amazon SES** (`resend._domainkey`, `send.`/`rsend.` CNAMEs, SES DKIM CNAMEs, and on `mail.noida.fit` an SES bounce MX + `include:amazonses.com` SPF). An A record and an MX record on `mail.noida.fit` coexist fine.
* Website: CloudFront (proxied).

### `matiumtech.com`: ⚠️ not registered
* `whois` at Verisign: **"No match for domain MATIUMTECH.COM"**. It isn't in Cloudflare and has no DNS anywhere, yet it's the MilesWeb plan's primary domain (MilesWeb nameservers: `luna/odin/neon.mydnsvault.com`).
* It must be **registered** before it can be used for the webmail URL or for email.

## 4. Database (MySQL on MilesWeb)

| Item | Value |
|---|---|
| Engine | **MariaDB 11.4.13** (LTS), Ubuntu 24.04 |
| Host | 45.199.139.26:3306 (mPanel lists "MySQL IP… for external access"; DB host shows `localhost/45.199.139.26`) |
| Reachable from the internet | **Yes**, port 3306 accepts connections |
| TLS | **Supported** (TLS 1.3). Certificate is MariaDB's auto-generated **self-signed** `CN=MariaDB Server` |
| Remote-host allowlist | **Per DB user**: mPanel → Databases → Users → Manage → "Remote access IP" (not shown in the create form). New users get only an internal host (`10.169.7.131`) |
| App database | **`matiumte1_matiummail`** (created 2026-11-17) |
| App user | **`matiumte1_matiummail`**: privileges **All** on `matiumte1_matiummail` only; `mysql_native_password`; remote hosts **`%`** (any) + `10.169.7.131`. Password is held by the owner (password manager), never in the repo |
| Other | database `matiumte1_spinternational` (empty, no users) |
| Privileges offered | All standard ones, **including `TRIGGER`** (enables the append-only audit log) |
| Auth plugins | `mysql_native_password` (default) |

Implications:
* **Remote login confirmed (2026-11-17)** from the owner's Mac: `matiumte1_matiummail@%`, TLS 1.3 (`TLS_AES_256_GCM_SHA384`), grants `USAGE ON *.*` + `ALL PRIVILEGES ON matiumte1_matiummail.*`, query round trip 55–79 ms from India (expect ~250 ms+ from Netlify US East). `%` was added because Netlify has no fixed IP. Accepted risk: the login is reachable from the internet. Mitigations: long random password, user limited to one database, app always uses TLS with a pinned certificate. (`REQUIRE SSL` can't be set from mPanel.)
* TLS with a self-signed certificate: **certificate pinning**. The server certificate is a fixed one (`CN=MariaDB Server`, valid to **Nov 2036**, SHA-256 `94:F4:AA:D1:02:7A:BD:93:…:9D:38:30`). With the official `mariadb` driver (3.5.5), standard verification fails with `ER_SELF_SIGNED_NO_PWD` as expected; pinning (`ssl.ca` = the server cert + fingerprint check) works. **MariaDB 11.4 zero-configuration verification also works** once the password is supplied (the driver checks the certificate against a password-derived fingerprint), so standard verification succeeds too. The app uses pinning as the primary check. TLS is never turned off.
* MariaDB 11.4 meets the schema's needs: JSON functions, `FULLTEXT` on InnoDB, `SELECT … FOR UPDATE SKIP LOCKED`, descending indexes. (Prisma treats MariaDB through its MySQL provider; the MariaDB driver adapter is used.)

## 5. ⚠️ SMTP greets after ~23 seconds

Measured six times from the owner's network: TCP/TLS connects quickly, then Postfix waits **~22.8–23.2 s** before its `220` greeting. IMAP has no such delay. This looks like a Postfix-side wait such as a reverse-DNS or ident lookup on the client's IP (the test network uses IPv6 with NAT64, whose public address may have no reverse DNS) or a deliberate greeting pause.

Why it matters: a Netlify synchronous function has a **~10 s** limit, so **sending would time out** if Netlify's servers see the same delay.

Plan:
1. Phase 2/3: deploy a tiny probe function on Netlify and measure the greeting delay **from Netlify** (AWS addresses have proper reverse DNS, so it may be fast).
2. If it's still slow: send through a **background function** (15 min limit), which the outbox design already supports. If background functions aren't available on the Free plan, ask MilesWeb support why submission ports delay the greeting. A 23 s pause on authenticated submission ports is unusual.

## 6. Decisions this enables

| Topic | Decision |
|---|---|
| Server profile | One profile: `mail.spinternationalpvtltd.com`, IMAP 993 TLS, SMTP 465 TLS (587 STARTTLS fallback), max message 97 MB (compose capped lower for Netlify limits) |
| Real-time | Dovecot advertises `IDLE` (only useful once there's an always-on worker; v1 polls) |
| Database | MariaDB 11.4 on the same server, direct connection with TLS (pending the remote-access test) |
| PHP bridge fallback | Feasible: PHP 8.2 + `pdo_mysql` on the hosting, talking to MariaDB on `localhost` |
| Node.js on MilesWeb | Not available on this plan, so hosting the app on MilesWeb is off the table |

## 7. Still to verify (needs an action by the owner)

1. **Run the login probe** (post-login capabilities: QUOTA, MOVE, UIDPLUS, CONDSTORE/QRESYNC, SPECIAL-USE, folder names), typing the password yourself:
   ```bash
   node tools/probe-mail-server.mjs mail.spinternationalpvtltd.com --user info@spinternationalpvtltd.com
   ```
2. ~~Remote DB access test~~: done. Database + user created, `%` allowlisted, TLS login verified.
3. **Register `matiumtech.com`**, or pick another hostname for the webmail.
4. **Before switching noida.fit MX** (all in Cloudflare DNS):
   * update apex SPF to `v=spf1 ip4:45.199.139.26 include:relay.mailbaby.net include:_spf.mx.cloudflare.net ~all`
   * create the noida.fit mailboxes in mPanel
   * disable Cloudflare Email Routing for noida.fit, then set MX `0 mail.noida.fit`
5. List the 5 noida.fit mailbox addresses.
