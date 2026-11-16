#!/usr/bin/env node
/**
 * MatiumMail — mail server probe (no dependencies, Node.js 18+).
 *
 * Reports what a mail server really supports, so the app is configured from
 * facts instead of assumptions:
 *   • IMAP  :993  implicit TLS — certificate names/validity, capabilities
 *   • SMTP  :465  implicit TLS — certificate, EHLO extensions (AUTH, SIZE…)
 *   • SMTP  :587  STARTTLS     — whether STARTTLS is offered, EHLO extensions
 *   • optional IMAP login (only if the certificate verified): post-login
 *     capabilities, namespace, folder list with special-use roles, quota,
 *     INBOX status.
 *
 * Usage:
 *   node tools/probe-mail-server.mjs <host>
 *   node tools/probe-mail-server.mjs <host> --user info@example.com
 *
 * With --user the password is asked for interactively (input hidden). It is
 * sent only to <host> over verified TLS and is never printed or saved.
 * SMTP is probed WITHOUT logging in, to avoid tripping lockouts.
 */

import tls from "node:tls";
import net from "node:net";
import readline from "node:readline";

const TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const host = args.find((a) => !a.startsWith("--"));
const userIdx = args.indexOf("--user");
const user = userIdx >= 0 ? args[userIdx + 1] : undefined;

if (!host || (userIdx >= 0 && !user)) {
  console.error("Usage: node tools/probe-mail-server.mjs <host> [--user <full email address>]");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Prompt for a secret without echoing it. */
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    const origWrite = rl._writeToOutput?.bind(rl);
    rl._writeToOutput = (s) => {
      if (!muted && origWrite) origWrite(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    muted = true;
  });
}

function describeCert(socket) {
  const cert = socket.getPeerCertificate();
  if (!cert || Object.keys(cert).length === 0) return { present: false };
  const san = (cert.subjectaltname ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^DNS:/, ""))
    .filter(Boolean);
  return {
    present: true,
    verified: socket.authorized,
    verifyError: socket.authorized ? null : String(socket.authorizationError),
    subjectCN: cert.subject?.CN ?? null,
    altNames: san,
    issuer: cert.issuer?.O ?? cert.issuer?.CN ?? null,
    validFrom: cert.valid_from,
    validTo: cert.valid_to,
    tlsProtocol: socket.getProtocol(),
  };
}

/**
 * Line reader over a socket that understands IMAP literals ({n}\r\n<n bytes>),
 * yielding complete logical lines. Works for SMTP too (no literals there).
 */
class LineReader {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.lines = [];
    this.waiters = [];
    this.error = null;
    this.pending = null; // logical line being assembled across literals
    socket.on("data", (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.parse();
    });
    const fail = (err) => {
      this.error = err ?? new Error("connection closed");
      for (const w of this.waiters.splice(0)) w.reject(this.error);
    };
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("connection closed")));
  }

  attach(socket) {
    // Used after STARTTLS: keep reading from the upgraded socket.
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.error = null;
    socket.on("data", (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.parse();
    });
    socket.on("error", (e) => {
      this.error = e;
      for (const w of this.waiters.splice(0)) w.reject(e);
    });
  }

  parse() {
    for (;;) {
      if (this.pending && this.pending.need > 0) {
        if (this.buf.length < this.pending.need) return;
        this.pending.text += this.buf.subarray(0, this.pending.need).toString("utf8");
        this.buf = this.buf.subarray(this.pending.need);
        this.pending.need = 0;
      }
      const idx = this.buf.indexOf("\r\n");
      if (idx < 0) return;
      const part = this.buf.subarray(0, idx).toString("utf8");
      this.buf = this.buf.subarray(idx + 2);
      const lit = /\{(\d+)\+?\}$/.exec(part);
      const text = (this.pending?.text ?? "") + (lit ? part.slice(0, lit.index) : part);
      if (lit) {
        this.pending = { text, need: Number(lit[1]) };
        continue;
      }
      this.pending = null;
      this.push(text);
    }
  }

  push(line) {
    const w = this.waiters.shift();
    if (w) w.resolve(line);
    else this.lines.push(line);
  }

  next() {
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timed out waiting for server")), TIMEOUT_MS);
      this.waiters.push({
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e)),
      });
    });
  }
}

function connectTls(port, { rejectUnauthorized }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized, timeout: TIMEOUT_MS });
    socket.once("secureConnect", () => resolve(socket));
    socket.once("error", reject);
    socket.once("timeout", () => socket.destroy(new Error("connection timed out")));
  });
}

function connectPlain(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, timeout: TIMEOUT_MS });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
    socket.once("timeout", () => socket.destroy(new Error("connection timed out")));
  });
}

/** Connect with full verification; if that fails, reconnect unverified ONLY to describe the certificate. */
async function connectTlsDescribed(port) {
  try {
    const socket = await connectTls(port, { rejectUnauthorized: true });
    return { socket, cert: describeCert(socket) };
  } catch (err) {
    if (!/certificate|self.signed|altnames|hostname|issuer|expired/i.test(String(err?.message))) throw err;
    const socket = await connectTls(port, { rejectUnauthorized: false });
    return { socket, cert: describeCert(socket) };
  }
}

// ---------------------------------------------------------------------------
// IMAP
// ---------------------------------------------------------------------------

let tagCounter = 0;
async function imapCommand(socket, reader, command) {
  const tag = `P${++tagCounter}`;
  socket.write(`${tag} ${command}\r\n`);
  const untagged = [];
  for (;;) {
    const line = await reader.next();
    if (line.startsWith(`${tag} `)) {
      const status = line.slice(tag.length + 1).split(" ")[0];
      return { status, statusLine: line, untagged };
    }
    untagged.push(line);
  }
}

function parseCapabilities(lines) {
  for (const l of lines) {
    const m = /CAPABILITY (.+?)(\]|$)/i.exec(l);
    if (m) return m[1].trim().split(/\s+/);
  }
  return [];
}

function imapQuote(s) {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function probeImap(password) {
  const out = { port: 993, security: "TLS" };
  const { socket, cert } = await connectTlsDescribed(993);
  out.certificate = cert;
  const reader = new LineReader(socket);
  try {
    const greeting = await reader.next();
    out.greeting = greeting.replace(/\[CAPABILITY[^\]]*\]\s*/i, "");
    out.capabilitiesBeforeLogin = parseCapabilities([greeting]);
    if (out.capabilitiesBeforeLogin.length === 0) {
      out.capabilitiesBeforeLogin = parseCapabilities((await imapCommand(socket, reader, "CAPABILITY")).untagged);
    }

    if (password !== undefined) {
      if (!cert.verified) {
        out.login = "SKIPPED — certificate did not verify for this hostname; not sending a password";
      } else {
        const login = await imapCommand(socket, reader, `LOGIN ${imapQuote(user)} ${imapQuote(password)}`);
        out.login = login.status === "OK" ? "OK" : `FAILED (${login.statusLine.replace(/^P\d+ /, "")})`;
        if (login.status === "OK") {
          const caps = parseCapabilities([login.statusLine, ...login.untagged]);
          out.capabilitiesAfterLogin = caps.length
            ? caps
            : parseCapabilities((await imapCommand(socket, reader, "CAPABILITY")).untagged);
          const has = (c) => out.capabilitiesAfterLogin.some((x) => x.toUpperCase() === c);

          if (has("NAMESPACE")) {
            out.namespace = (await imapCommand(socket, reader, "NAMESPACE")).untagged.join(" | ");
          }

          const list = await imapCommand(socket, reader, has("SPECIAL-USE") ? 'LIST "" "*" RETURN (SPECIAL-USE)' : 'LIST "" "*"');
          out.folders = list.untagged
            .filter((l) => l.startsWith("* LIST"))
            .map((l) => {
              const m = /^\* LIST \(([^)]*)\) (\S+) (.+)$/.exec(l);
              return m ? { flags: m[1], delimiter: m[2], name: m[3] } : { raw: l };
            });

          if (has("QUOTA")) {
            const q = await imapCommand(socket, reader, "GETQUOTAROOT INBOX");
            out.quota = q.status === "OK" ? q.untagged : `not available (${q.statusLine})`;
          } else {
            out.quota = "QUOTA extension not advertised";
          }

          const items = ["MESSAGES", "UNSEEN", "UIDNEXT", "UIDVALIDITY"];
          if (has("CONDSTORE") || has("QRESYNC")) items.push("HIGHESTMODSEQ");
          if (has("STATUS=SIZE")) items.push("SIZE");
          const st = await imapCommand(socket, reader, `STATUS INBOX (${items.join(" ")})`);
          out.inboxStatus = st.untagged.join(" ") || st.statusLine;
        }
      }
    }
    await imapCommand(socket, reader, "LOGOUT").catch(() => {});
  } finally {
    socket.destroy();
  }

  const caps = (out.capabilitiesAfterLogin ?? out.capabilitiesBeforeLogin).map((c) => c.toUpperCase());
  out.keyFeatures = Object.fromEntries(
    ["IDLE", "CONDSTORE", "QRESYNC", "UIDPLUS", "MOVE", "QUOTA", "SPECIAL-USE", "NAMESPACE", "STATUS=SIZE", "ESEARCH", "LITERAL+", "ENABLE", "COMPRESS=DEFLATE"].map(
      (f) => [f, caps.includes(f)],
    ),
  );
  if (!out.capabilitiesAfterLogin) out.keyFeaturesNote = "Based on pre-login capabilities; run with --user for the full list.";
  return out;
}

// ---------------------------------------------------------------------------
// SMTP (no authentication)
// ---------------------------------------------------------------------------

async function smtpResponse(reader) {
  const lines = [];
  for (;;) {
    const line = await reader.next();
    lines.push(line);
    if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) return { code: Number(line.slice(0, 3)), lines };
  }
}

function parseEhlo(lines) {
  return lines.slice(1).map((l) => l.slice(4).trim());
}

async function probeSmtpImplicit() {
  const out = { port: 465, security: "TLS" };
  const { socket, cert } = await connectTlsDescribed(465);
  out.certificate = cert;
  const reader = new LineReader(socket);
  try {
    out.greeting = (await smtpResponse(reader)).lines.join(" ");
    socket.write("EHLO probe.invalid\r\n");
    out.extensions = parseEhlo((await smtpResponse(reader)).lines);
    socket.write("QUIT\r\n");
    await smtpResponse(reader).catch(() => {});
  } finally {
    socket.destroy();
  }
  return out;
}

async function probeSmtpStartTls() {
  const out = { port: 587, security: "STARTTLS" };
  const plain = await connectPlain(587);
  const reader = new LineReader(plain);
  let secure;
  try {
    out.greeting = (await smtpResponse(reader)).lines.join(" ");
    plain.write("EHLO probe.invalid\r\n");
    const before = parseEhlo((await smtpResponse(reader)).lines);
    out.extensionsBeforeTls = before;
    out.startTlsOffered = before.some((e) => e.toUpperCase() === "STARTTLS");
    if (!out.startTlsOffered) return out;

    plain.write("STARTTLS\r\n");
    const r = await smtpResponse(reader);
    if (r.code !== 220) {
      out.startTls = `refused (${r.lines.join(" ")})`;
      return out;
    }
    plain.removeAllListeners("data");
    secure = await new Promise((resolve, reject) => {
      const s = tls.connect({ socket: plain, servername: host, rejectUnauthorized: false });
      s.once("secureConnect", () => resolve(s));
      s.once("error", reject);
    });
    out.certificate = describeCert(secure);
    // rejectUnauthorized:false above only so we can describe a bad cert;
    // re-check verification explicitly:
    const v = tls.checkServerIdentity(host, secure.getPeerCertificate());
    if (v) out.certificate.verified = false;
    reader.attach(secure);
    secure.write("EHLO probe.invalid\r\n");
    out.extensions = parseEhlo((await smtpResponse(reader)).lines);
    secure.write("QUIT\r\n");
    await smtpResponse(reader).catch(() => {});
  } finally {
    secure?.destroy();
    plain.destroy();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function step(name, fn) {
  try {
    return await fn();
  } catch (err) {
    return { error: `${name} failed: ${err?.message ?? err}` };
  }
}

const password = user ? await askHidden(`Password for ${user} (hidden): `) : undefined;

console.error(`Probing ${host} …`);
const report = {
  host,
  probedAt: new Date().toISOString(),
  node: process.version,
  imap: await step("IMAP 993", () => probeImap(password)),
  smtp465: await step("SMTP 465", probeSmtpImplicit),
  smtp587: await step("SMTP 587", probeSmtpStartTls),
};

const sizeExt = [...(report.smtp465.extensions ?? []), ...(report.smtp587.extensions ?? [])].find((e) => /^SIZE\s+\d+/i.test(e));
report.summary = {
  imapCertificateValidForHost: report.imap.certificate?.verified ?? false,
  smtp465CertificateValidForHost: report.smtp465.certificate?.verified ?? false,
  smtp587StartTlsOffered: report.smtp587.startTlsOffered ?? false,
  smtpMaxMessageBytes: sizeExt ? Number(sizeExt.split(/\s+/)[1]) : null,
  imapLogin: report.imap.login ?? "not attempted (no --user)",
};

console.log(JSON.stringify(report, null, 2));
