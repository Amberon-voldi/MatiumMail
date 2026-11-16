# Phase 1 — Revision 04: free tiers, one user

> Status: **Proposal — awaiting approval. Current.** Amends [Revision 03](./PHASE-1-REVISION-03-NETLIFY-MILESWEB-MYSQL.md); everything there still applies unless changed here.
> Constraints: **Netlify Free plan**, **every other service on a free plan**, MilesWeb hosting (paid) provides mail + MySQL, **one user** (a teammate), possibly with several mailboxes.

## 1. What changes

| Topic | Revision 03 | Now |
|---|---|---|
| Prisma Accelerate **static IP** | Recommended | **Not available** (needs a paid Prisma plan). |
| MySQL access from Netlify | Via Accelerate's static IPs | **Direct remote MySQL with TLS** if MilesWeb allows it, otherwise a small **bridge on MilesWeb** (§2). |
| Netlify functions region | Move close to MilesWeb | Free plan: stays at the default (US East). Every IMAP/SQL round trip to India costs ~250 ms, so we design for few round trips. |
| Netlify budget | Not a concern | **300 credits/month**; functions compute ≈ 10 credits per GB-hour (≈ 30 GB-hours/month). When credits run out on Free, the site pauses until the next month. |
| Background functions | Used for sync/outbox | Use them only if the Free plan permits it; otherwise the fallbacks in §3 apply. |
| Users, roles, admin UI | Multi-user ready | **One user.** No admin screens; mailboxes and the allowed sign-in address(es) are set up with a CLI seed command. The schema stays multi-mailbox, so adding people later needs no redesign. |

## 2. Database access options (decided by MilesWeb's answers)

1. **Remote MySQL with TLS (preferred, if offered).** In mPanel, allow remote access for a *dedicated* database and user. Because Netlify has no fixed IP, the host allowlist would have to be "any" (`%`). That's only acceptable if:
   * the connection **requires TLS** (otherwise ❌),
   * the user has rights on this one database only, with a long random password,
   * the database contains nothing sensitive in clear text: mailbox passwords are encrypted with the master key held in Netlify (Revision 03 §3.3).
2. **Small HTTPS bridge on MilesWeb (fallback).** If remote MySQL is unavailable, or has no TLS, a tiny API is deployed on the MilesWeb hosting (PHP, which every shared plan runs, or Node.js if your plan supports it). It talks to MySQL on `localhost`; Netlify calls it over HTTPS with HMAC-signed requests. MySQL never faces the internet. Cost: a second, small codebase, and the Netlify app uses a typed client instead of Prisma.
3. **Worth checking: host the whole app on MilesWeb.** If your MilesWeb plan can run a **Node.js application**, the Next.js app could live there instead of Netlify. MySQL and mail would then be on (or next to) the same server: no remote database, low latency, the server's own fixed IP, and no Netlify credit limit. Netlify stays the plan unless you want to switch.

## 3. Staying within the free budget (one user)

* **Polling:** check for new mail every **2 minutes** while the tab is visible (plus a manual refresh button and a check when the tab regains focus). Nothing runs while the tab is hidden or closed, and there's **no scheduled function** in v1.
* **Fewer round trips:** each request opens **one** IMAP connection and **one** MySQL connection, batches its queries, and reuses the session lookup. Message lists render from the MySQL cache first.
* **Small functions:** 1 GB memory default; heavy parsing only when a message is opened.
* **Sync without background functions:** the initial sync is **driven by the browser**: while the app is open, it calls "sync next chunk" (~300 messages, kept under the 10 s limit) until done, showing progress. Same idea for bulk actions.
* **Sending without background functions:** sent synchronously when the message fits within the timeout. With the ~250 ms trip to MilesWeb, compose caps attachments at about **10 MB per message** in v1 (raised later if needed).
* **Usage estimate:** one user, ~8 h/day active → about 240 polls/day plus normal use. That's roughly **8–15 GB-hours/month (≈ 80–150 credits)**, inside the 300-credit allowance. We'll show credit usage after the first week and tune the polling interval if needed.

## 4. Security (still required, even for one user)

The site is on the public internet with real business mail, so v1 keeps:

* **Sign-in allowlist:** only the configured address(es) can sign in; everyone else gets a generic error before any IMAP login is attempted, so we never hammer MilesWeb.
* Login rate limiting (MySQL counters), HttpOnly/Secure/SameSite session cookies, CSRF/origin checks, HTML sanitisation in a sandboxed iframe, remote images blocked by default, encrypted mailbox credentials, and an audit log.
* **TOTP 2FA:** recommended. It's a small amount of work and protects against a leaked mailbox password.

## 5. Questions that decide the database path

1. ★ Does mPanel have **Remote MySQL**, and does it support **SSL/TLS**? Is it **MySQL or MariaDB**, and which version?
2. ★ Can your MilesWeb plan run a **Node.js application** (or only PHP)?
3. ★ Which **country/data centre** is your MilesWeb hosting in?
4. Which **mailbox(es)** will your teammate use, and should the app be locked to just those addresses? (Recommended: yes.)
5. Turn on **2FA (TOTP)** for the teammate? (Recommended: yes.)

## Sources

- [Netlify: credit-based pricing plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/)
- [Netlify: how credits work](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/)
- [Netlify changelog: credit-based plans](https://www.netlify.com/changelog/netlify-pricing-update-introducing-credit-based-plans/)
- [Prisma Accelerate: Static IP (paid plans)](https://www.prisma.io/docs/accelerate/static-ip)
