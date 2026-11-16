# Mail servers and domains — current state

> Source: supplied by the owner on 2026-11-16. Items marked *unverified* still need the probe (`tools/probe-mail-server.mjs`) to confirm them.

## Domains

| Domain | Email status | Mailboxes | IMAP | SMTP | DKIM |
|---|---|---|---|---|---|
| `spinternationalpvtltd.com` | **Live**: mail is arriving | `info@` | `mail.spinternationalpvtltd.com:993`, SSL/TLS | same host, `:465` SSL/TLS or `:587` STARTTLS | Validated |
| `noida.fit` | **Half done**: waiting for mailboxes to be created, then the MX records get switched | 5 to create (list pending) | `mail.noida.fit:993`, SSL/TLS | same host, `:465` or `:587` | *unknown* |
| `matiumtech.com` | **Nothing set up**: no DNS records anywhere | none | — | — | — |

## How the app will use these (as `mail_server_profiles` rows, not code)

| Setting | Choice | Why |
|---|---|---|
| IMAP | port 993, implicit TLS | Encrypted from the first byte; plaintext 143 is never used. |
| SMTP | **port 465, implicit TLS** (primary); 587 STARTTLS as fallback | 465 can't be downgraded to plaintext by a network attacker; 587 is kept for networks that block 465. |
| Hostname | `mail.<domain>`, *if its certificate is valid for that name* | Certificate verification is never disabled. If MilesWeb's certificate only covers the server's own hostname, the profile uses that hostname instead (the probe shows which). |
| Profiles | One per server. If both `mail.` hostnames point to the same MilesWeb server **and** one certificate covers both, a single profile serves both domains | *unverified* |

## Hostname conflict: `mail.matiumtech.com`

The original brief put the webmail at `mail.matiumtech.com`. But MilesWeb's naming pattern (`mail.<domain>`) means that **once matiumtech.com email is hosted at MilesWeb, `mail.matiumtech.com` is expected to be the IMAP/SMTP server**. The same name can't point to both Netlify (the web app) and MilesWeb (the mail server).

**Recommendation:** host the web app on a different subdomain, e.g. **`inbox.matiumtech.com`** (or `app.`). Avoid `webmail.`, which MilesWeb-style panels often reserve for their own webmail.

## `matiumtech.com` has no DNS

Before the web app can be reached at any `*.matiumtech.com` address:

1. The domain needs working nameservers. Either:
   * use the registrar's DNS (or MilesWeb's, if it will host matiumtech.com mail later) and add one **CNAME** `inbox → <site>.netlify.app`, or
   * delegate the whole zone to **Netlify DNS** (free) and later add MilesWeb's MX/SPF/DKIM records there.
2. Netlify issues the HTTPS certificate automatically once DNS resolves.

Until then the app runs on its free `*.netlify.app` address.

## Before sending from `noida.fit`

Mailboxes can be read and tested before the MX switch. **Sending** from `@noida.fit` should wait until its **SPF** (and ideally **DKIM**, plus a DMARC record) are published, or messages may land in spam. The MX switch itself only affects *receiving*.

## Probe

Run on your own computer (Node.js 18+), not in this cloud environment, which can't reach your mail servers:

```bash
node tools/probe-mail-server.mjs mail.spinternationalpvtltd.com --user info@spinternationalpvtltd.com
```

The password is asked for with hidden input, sent only to that server over verified TLS, and never printed or saved. SMTP is probed without logging in. Paste the JSON output back; it contains no secrets.
