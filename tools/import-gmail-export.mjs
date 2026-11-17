#!/usr/bin/env node
/**
 * MatiumMail — restore an old Gmail export into the MilesWeb mailboxes.
 *
 * Reads the "SP Mail" viewer export (a folder with data/<account>.js files,
 * one per mailbox) and APPENDs every message to the matching IMAP mailbox:
 *
 *   Gmail label            → IMAP folder
 *   TRASH                  → Trash
 *   SPAM                   → Junk
 *   DRAFT                  → Drafts   (\Draft)
 *   INBOX                  → INBOX
 *   SENT (not in INBOX)    → Sent
 *   anything else          → Archive  (created if missing)
 *
 * UNREAD stays unread; everything else is marked \Seen.
 *
 * The export holds each message's headers and the plain-text version of its
 * body (no HTML, no images), and only the names and sizes of its attachments.
 * The text is cleaned up (CSS and tags left over from HTML-only emails,
 * entities, "[image: …]" placeholders) and sent as both text and simple HTML
 * with short, clickable links and a box listing the original attachments.
 *
 * Messages get a stable Message-ID derived from the Gmail id, and Gmail threads
 * are rebuilt with In-Reply-To/References so the webmail shows conversations.
 * Running the tool again skips messages that are up to date, and replaces
 * copies restored by an older version of this tool in place: same folder,
 * same read/starred state.
 *
 * Usage:
 *   node tools/import-gmail-export.mjs <export folder> [--only <address>] [--host <imap host>]
 *   node tools/import-gmail-export.mjs <export folder> --dry-run [--out <dir for .eml files>]
 *
 * The password for each mailbox is asked for interactively (input hidden). It
 * is sent only to the IMAP host over verified TLS and is never printed or saved.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { ImapFlow } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer/index.js";

const IMPORT_HEADER = "X-Matium-Import";
const IMPORT_TAG = "gmail-export";
/** Bumped whenever restored messages change; older copies are replaced. 1 = raw text only. */
const IMPORT_VERSION = 2;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const optionNames = new Set(["--only", "--host", "--port", "--out"]);
const exportDir = args.find((a, i) => !a.startsWith("--") && !optionNames.has(args[i - 1]));
const only = option("--only")?.toLowerCase();
const host = option("--host") ?? "mail.spinternationalpvtltd.com";
const port = Number(option("--port") ?? 993);
const dryRun = flag("--dry-run");
const outDir = option("--out");

if (!exportDir || !Number.isInteger(port)) {
  console.error(
    "Usage: node tools/import-gmail-export.mjs <export folder> [--only <address>] [--host <imap host>] [--port <n>] [--dry-run] [--out <dir>]",
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Reading the export
// ---------------------------------------------------------------------------

/**
 * data/<name>.js is `window.MAILDATA[...]={json};`. It is parsed as JSON,
 * never evaluated.
 */
function readAccount(file) {
  const raw = readFileSync(file, "utf8");
  const start = raw.indexOf("]=");
  if (start < 0) throw new Error(`${file} is not a viewer data file`);
  const data = JSON.parse(raw.slice(start + 2).trim().replace(/;$/, ""));
  if (typeof data?.email !== "string" || !Array.isArray(data.messages)) {
    throw new Error(`${file} has no email/messages`);
  }
  return { email: data.email.toLowerCase(), messages: data.messages };
}

function loadAccounts(dir) {
  const dataDir = path.join(dir, "data");
  return readdirSync(dataDir)
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((f) => readAccount(path.join(dataDir, f)));
}

// ---------------------------------------------------------------------------
// Building messages
// ---------------------------------------------------------------------------

function folderRoleFor(labels) {
  if (labels.includes("TRASH")) return "TRASH";
  if (labels.includes("SPAM")) return "JUNK";
  if (labels.includes("DRAFT")) return "DRAFTS";
  if (labels.includes("INBOX")) return "INBOX";
  if (labels.includes("SENT")) return "SENT";
  return "ARCHIVE";
}

function flagsFor(labels) {
  const flags = [];
  if (!labels.includes("UNREAD")) flags.push("\\Seen");
  if (labels.includes("DRAFT")) flags.push("\\Draft");
  if (labels.includes("STARRED")) flags.push("\\Flagged");
  return flags;
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ── Cleaning the exported text ──────────────────────────────────────────────

const NAMED_ENTITIES = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? all;
  });
}

/** `color: red; margin: 0` — the body of a CSS rule (or an emptied @media block). */
function isRuleBody(body) {
  // url(data:…;base64,…) and quoted values may contain ";" themselves.
  const masked = body.replace(/url\([^)]*\)/gi, "url()").replace(/(["'])(?:(?!\1)[^\n])*\1/g, '""');
  const decls = masked.split(";").map((d) => d.trim()).filter(Boolean);
  return decls.every((d) => /^[a-z-]+\s*:\s*\S/i.test(d));
}

/** A rule: selector lines (continued with a trailing comma) and a { … } body with no nested braces. */
const CSS_RULE = /(?:[^{}\n]*,[ \t]*\n)*[^{}\n]*\{([^{}]*)\}/g;

/**
 * HTML-only emails reach the export with their <style> rules as text. Take
 * those out — only when the body clearly contains CSS, so ordinary text with a
 * stray brace is left alone. Innermost rules go first, then the emptied
 * @media wrappers.
 */
function stripCss(text) {
  const rules = [...text.matchAll(CSS_RULE)].filter((m) => m[1].trim() && isRuleBody(m[1]));
  if (rules.length < 2) return { text, stripped: false };
  let out = text.replace(/\/\*[\s\S]*?\*\//g, "");
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(CSS_RULE, (all, body) => (isRuleBody(body) ? "" : all));
  }
  return { text: out, stripped: true };
}

/** Tags that slipped into a few text bodies: links become "label <url>" like the rest of the export. */
function untag(text) {
  return text
    .replace(/<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_, _q, href, label) => `${label.trim()} <${href}>`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<\/?(html|head|body|div|span|p|table|tbody|thead|tr|td|th|font|b|strong|i|em|u|center|img|meta|link|title|ul|ol|li|h\d)\b[^>]*>/gi, "");
}

/** The readable text of an exported body, and whether it came from an HTML email. */
function cleanText(raw) {
  let text = String(raw ?? "")
    .replace(/\r+\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, "");
  const css = stripCss(text);
  text = decodeEntities(untag(css.text))
    // Some senders' text versions write links as "[ https://… ]".
    .replace(/\[\s+((?:https?|mailto):[^\s\]]+)\s+\]/g, "<$1>");
  const images = /\[image: [^\]]*\]/i.test(text);
  const fromHtml = css.stripped || images;
  text = text
    .replace(/\[image: [^\]]*\]/gi, "")
    .split("\n")
    // Text pulled out of an HTML layout keeps the layout's indentation; drop it.
    .map((line) => (fromHtml ? line.trim() : line.replace(/[ \t ]+$/, "")))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, fromHtml };
}

// ── Text → HTML ─────────────────────────────────────────────────────────────

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** `label <https://…>` (how the export writes links) or a bare URL. */
const LINK = /<((?:https?|mailto):[^>\s]+)>|\bhttps?:\/\/[^\s<>"]+/g;

/** Short text for a link: the address itself when short, else the site and an ellipsis. */
function linkLabel(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "mailto:") return decodeURIComponent(u.pathname);
    const host = u.hostname.replace(/^www\./, "");
    const rest = (u.pathname + u.search).replace(/\/$/, "");
    return (host + rest).length <= 48 ? host + rest : `${host}${rest ? "/…" : ""}`;
  } catch {
    return url;
  }
}

function lineToHtml(line) {
  let out = "";
  let last = 0;
  for (const m of line.matchAll(LINK)) {
    let url = m[1] ?? m[0];
    let trail = "";
    if (!m[1]) {
      trail = /[.,;:!?)\]]+$/.exec(url)?.[0] ?? "";
      url = url.slice(0, url.length - trail.length);
    }
    out += escapeHtml(line.slice(last, m.index));
    const href = escapeHtml(url);
    out += m[1]
      ? ` <a href="${href}" style="font-size:12px;color:#71717a;white-space:nowrap">${escapeHtml(linkLabel(url).split("/")[0])}&nbsp;↗</a>`
      : `<a href="${href}">${escapeHtml(linkLabel(url))}</a>`;
    out += escapeHtml(trail);
    last = m.index + m[0].length;
  }
  return out + escapeHtml(line.slice(last));
}

/** Lines of one paragraph; runs of "> " lines become (nested) quotes. */
function linesToHtml(lines) {
  const parts = [];
  let run = [];
  let quoted = false;
  const flush = () => {
    if (!run.length) return;
    parts.push(quoted ? `<blockquote>${linesToHtml(run.map((l) => l.replace(/^>\s?/, "")))}</blockquote>` : run.map(lineToHtml).join("<br>"));
    run = [];
  };
  for (const line of lines) {
    const q = line.startsWith(">");
    if (q !== quoted) flush();
    quoted = q;
    run.push(line);
  }
  flush();
  return parts.join("");
}

function attachmentsHtml(named) {
  const rows = named
    .map((a) => {
      const size = formatBytes(a.z);
      return `<div style="padding:2px 0">📎 ${escapeHtml(a.n)}${size ? ` <span style="color:#a1a1aa">· ${size}</span>` : ""}</div>`;
    })
    .join("");
  return (
    `<div style="margin-top:20px;padding:12px 14px;border:1px solid #e4e4e7;border-radius:12px;background:#fafafa;font-size:13px;color:#3f3f46">` +
    `<div style="font-weight:600;margin-bottom:4px">${named.length} attachment${named.length === 1 ? "" : "s"} on the original message</div>${rows}` +
    `<div style="margin-top:6px;font-size:12px;color:#71717a">The files weren't included in the Gmail export.</div></div>`
  );
}

const FROM_HTML_NOTE =
  '<p style="margin:20px 0 0;font-size:12px;color:#a1a1aa">Restored from the Gmail export. The original email\'s images and layout weren\'t included.</p>';

/** Text and HTML bodies for one exported message. */
function bodiesFor(m) {
  const { text, fromHtml } = cleanText(m.b || decodeEntities(m.sn || ""));
  const named = (Array.isArray(m.a) ? m.a : []).filter((a) => a?.n);
  const paragraphs = text
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((p) => `<div style="margin:0 0 1em">${linesToHtml(p.split("\n"))}</div>`)
    .join("\n");
  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#18181b">` +
    `${paragraphs}${named.length ? attachmentsHtml(named) : ""}${fromHtml ? FROM_HTML_NOTE : ""}</div>`;
  const note = named.length
    ? `\n\n────────────\nAttachments on the original message (not included in the export):\n${named
        .map((a) => `  • ${a.n}${formatBytes(a.z) ? ` (${formatBytes(a.z)})` : ""}`)
        .join("\n")}`
    : "";
  return { text: `${text}${note}\n`, html };
}

const messageIdFor = (gmailId, domain) => `<${gmailId}.gmail-import@${domain}>`;

/** One plan entry per message: target role, flags, date and the MIME source. */
async function planAccount(account) {
  const domain = account.email.split("@")[1];
  const messages = [...account.messages]
    .filter((m) => typeof m?.id === "string" && /^[0-9a-z]+$/i.test(m.id))
    .sort((a, b) => String(a.d ?? "").localeCompare(String(b.d ?? "")));

  // Gmail threads → References chains: every later message points at the
  // thread's first message (the webmail keys conversations on References[0]).
  const threads = new Map();
  const plan = [];
  for (const m of messages) {
    const labels = Array.isArray(m.l) ? m.l : [];
    const messageId = messageIdFor(m.id, domain);
    const thread = threads.get(m.t) ?? [];
    const date = m.d && !Number.isNaN(Date.parse(m.d)) ? new Date(m.d) : undefined;

    const headers = [
      { key: IMPORT_HEADER, value: `${IMPORT_TAG}; id=${m.id}; v=${IMPORT_VERSION}` },
      { key: "X-Gmail-Labels", value: labels.join(", ") || "(none)" },
    ];
    if (thread.length) {
      headers.push({ key: "In-Reply-To", value: thread[thread.length - 1] });
      headers.push({ key: "References", value: [thread[0], ...thread.slice(-9)].filter((v, i, a) => a.indexOf(v) === i).join(" ") });
    }

    const composer = new MailComposer({
      from: m.f || undefined,
      to: m.to || undefined,
      cc: m.cc || undefined,
      subject: m.s ?? "",
      date,
      messageId,
      ...bodiesFor(m),
      headers,
    });
    const raw = await composer.compile().build();

    if (m.t) threads.set(m.t, [...thread, messageId]);
    plan.push({ gmailId: m.id, messageId, role: folderRoleFor(labels), flags: flagsFor(labels), date, raw, subject: m.s ?? "" });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// IMAP
// ---------------------------------------------------------------------------

const ATTRIBUTE_ROLES = {
  "\\sent": "SENT",
  "\\drafts": "DRAFTS",
  "\\junk": "JUNK",
  "\\trash": "TRASH",
  "\\archive": "ARCHIVE",
};
const NAME_ROLES = [
  [/^(sent|sent items|sent mail|sent messages)$/i, "SENT"],
  [/^drafts?$/i, "DRAFTS"],
  [/^(junk|spam|junk e-?mail|bulk mail|junk mail)$/i, "JUNK"],
  [/^(trash|deleted|deleted items|deleted messages|bin)$/i, "TRASH"],
  [/^(archive|archives)$/i, "ARCHIVE"],
];
const DEFAULT_NAMES = { SENT: "Sent", DRAFTS: "Drafts", JUNK: "Junk", TRASH: "Trash", ARCHIVE: "Archive" };

/** Map each role to an existing folder: SPECIAL-USE first, then well-known names (shallowest wins). */
function rolesOf(folders) {
  const roles = { INBOX: "INBOX" };
  for (const f of folders) {
    const role = ATTRIBUTE_ROLES[(f.specialUse ?? "").toLowerCase()];
    if (role && !roles[role]) roles[role] = f.path;
  }
  const byDepth = [...folders].sort((a, b) => a.path.split(a.delimiter || "\0").length - b.path.split(b.delimiter || "\0").length);
  for (const f of byDepth) {
    const leaf = f.delimiter ? f.path.split(f.delimiter).pop() : f.path;
    for (const [re, role] of NAME_ROLES) {
      if (re.test(leaf) && !roles[role]) roles[role] = f.path;
    }
  }
  return roles;
}

async function ensureFolder(client, folders, roles, role) {
  if (roles[role]) return roles[role];
  const delimiter = folders.find((f) => f.path.toUpperCase() === "INBOX")?.delimiter || ".";
  // Dovecot setups like MilesWeb keep every folder below "INBOX."; follow the existing layout.
  const nested = folders.some((f) => f.path.startsWith(`INBOX${delimiter}`));
  const folderPath = nested ? `INBOX${delimiter}${DEFAULT_NAMES[role]}` : DEFAULT_NAMES[role];
  try {
    await client.mailboxCreate(folderPath);
  } catch (err) {
    if (!/ALREADYEXISTS|already exists/i.test(String(err?.responseText ?? err?.message))) throw err;
  }
  await client.mailboxSubscribe(folderPath).catch(() => {});
  console.log(`  created folder ${folderPath}`);
  roles[role] = folderPath;
  return folderPath;
}

/**
 * Every copy this tool restored before, in any folder (the user may have moved
 * some): Message-ID → [{ path, uid, flags, version }].
 */
async function findRestored(client, folders) {
  const found = new Map();
  for (const f of folders) {
    // Virtual folders only mirror messages that live elsewhere.
    if (f.flags?.has("\\Noselect") || f.flags?.has("\\NonExistent") || f.specialUse === "\\All" || f.specialUse === "\\Flagged") continue;
    const lock = await client.getMailboxLock(f.path, { readOnly: true });
    try {
      const uids = await client.search({ header: { [IMPORT_HEADER]: IMPORT_TAG } }, { uid: true });
      if (!uids?.length) continue;
      for await (const msg of client.fetch(uids, { uid: true, flags: true, envelope: true, headers: [IMPORT_HEADER] }, { uid: true })) {
        const id = msg.envelope?.messageId;
        if (!id) continue;
        const version = Number(/;\s*v=(\d+)/.exec(msg.headers?.toString() ?? "")?.[1] ?? 1);
        const copies = found.get(id) ?? [];
        copies.push({ path: f.path, uid: msg.uid, flags: msg.flags ?? new Set(), version });
        found.set(id, copies);
      }
    } finally {
      lock.release();
    }
  }
  return found;
}

/** Flags worth carrying over to a replacement: read, starred, answered, draft, keywords. */
const keptFlags = (flags) => [...flags].filter((f) => f !== "\\Recent" && f !== "\\Deleted");

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

async function importAccount(account, plan, password) {
  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user: account.email, pass: password },
    // Certificates are always verified, except for a local test server on this machine.
    tls: LOOPBACK.has(host) ? { rejectUnauthorized: false } : { servername: host },
    logger: false,
    connectionTimeout: 60_000,
    greetingTimeout: 60_000,
  });
  await client.connect();
  try {
    const folders = await client.list();
    const roles = rolesOf(folders);
    const restored = await findRestored(client, folders);
    // Older copies are removed only after their replacement is in, so an
    // interrupted run loses nothing; the next run finishes the job.
    const stale = new Map();
    const counts = { added: 0, updated: 0, current: 0 };
    let done = 0;
    for (const p of plan) {
      const copies = restored.get(p.messageId) ?? [];
      const old = copies.filter((c) => c.version < IMPORT_VERSION);
      for (const c of old) stale.set(c.path, [...(stale.get(c.path) ?? []), c.uid]);
      if (copies.some((c) => c.version >= IMPORT_VERSION)) {
        counts.current++;
      } else if (old.length) {
        // In place: the folder it's in now, read/starred as the user left it.
        await client.append(old[0].path, p.raw, keptFlags(old[0].flags), p.date);
        counts.updated++;
      } else {
        await client.append(await ensureFolder(client, folders, roles, p.role), p.raw, p.flags, p.date);
        counts.added++;
      }
      done++;
      if (done % 25 === 0 || done === plan.length) process.stdout.write(`\r  ${done}/${plan.length}`);
    }
    process.stdout.write("\n");
    for (const [folderPath, uids] of stale) {
      const lock = await client.getMailboxLock(folderPath);
      try {
        await client.messageDelete(uids, { uid: true });
      } finally {
        lock.release();
      }
    }
    return counts;
  } finally {
    await client.logout().catch(() => client.close());
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * One reader for every prompt. Lines are queued, so answers piped in on stdin
 * (which arrive before the prompts that use them) are not lost.
 */
let prompt;

/** Prompt for a secret without echoing it. */
function askHidden(question) {
  if (!prompt) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
    const origWrite = rl._writeToOutput?.bind(rl);
    prompt = { rl, muted: false, lines: [], waiting: null, closed: false };
    rl._writeToOutput = (s) => {
      if (!prompt.muted && origWrite) origWrite(s);
    };
    rl.on("line", (line) => {
      const waiting = prompt.waiting;
      prompt.waiting = null;
      if (waiting) waiting(line);
      else prompt.lines.push(line);
    });
    rl.on("close", () => {
      prompt.closed = true;
      prompt.waiting?.("");
      prompt.waiting = null;
    });
  }
  process.stdout.write(question);
  prompt.muted = true;
  return new Promise((resolve) => {
    const answer = (line) => {
      prompt.muted = false;
      process.stdout.write("\n");
      resolve(line);
    };
    if (prompt.lines.length) answer(prompt.lines.shift());
    else if (prompt.closed) answer("");
    else prompt.waiting = answer;
  });
}

function summarize(plan) {
  const byRole = {};
  for (const p of plan) byRole[p.role] = (byRole[p.role] ?? 0) + 1;
  return Object.entries(byRole)
    .map(([role, n]) => `${role} ${n}`)
    .join(", ");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const accounts = loadAccounts(exportDir).filter((a) => !only || a.email === only);
if (accounts.length === 0) {
  console.error(only ? `No account ${only} in ${exportDir}` : `No accounts found in ${exportDir}/data`);
  process.exit(1);
}

let failed = false;
for (const account of accounts) {
  const plan = await planAccount(account);
  console.log(`\n${account.email}: ${plan.length} messages (${summarize(plan)})`);

  if (dryRun) {
    if (outDir) {
      const dir = path.join(outDir, account.email);
      mkdirSync(dir, { recursive: true });
      for (const p of plan) writeFileSync(path.join(dir, `${p.role.toLowerCase()}-${p.gmailId}.eml`), p.raw);
      console.log(`  wrote ${plan.length} .eml files to ${dir}`);
    }
    continue;
  }

  const password = await askHidden(`Password for ${account.email} (hidden): `);
  try {
    const c = await importAccount(account, plan, password);
    console.log(
      `  added ${c.added} · updated ${c.updated}${c.updated ? " (same folder, read/starred kept)" : ""} · already up to date ${c.current}`,
    );
  } catch (err) {
    failed = true;
    const reason = err?.authenticationFailed ? "wrong password or login refused" : (err?.responseText ?? err?.message ?? String(err));
    console.error(`  ✗ ${account.email}: ${reason}`);
  }
}
prompt?.rl.close();
process.exitCode = failed ? 1 : 0;
