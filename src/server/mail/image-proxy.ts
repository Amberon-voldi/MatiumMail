import "server-only";
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { lookup, type LookupAddress, type LookupAllOptions, type LookupOneOptions } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { credentialKeyRing } from "../crypto/keyring";

/**
 * Privacy proxy for images in email (like Gmail's): remote images are loaded
 * through this server, so senders never see the reader's IP address, cookies
 * or browser, and http:// images still load on the https:// app.
 *
 * It is not an open proxy: every URL is HMAC-signed by the server when the
 * message is rendered, so only images that appear in mail the user opened can
 * be fetched. SSRF rules: http(s) only, ports 80/443/8080/8443, the hostname is
 * resolved once through a lookup that rejects private, loopback, link-local
 * and other non-public addresses (the connection uses exactly that address, so
 * DNS rebinding can't swap it), redirects are followed by hand and re-checked,
 * responses are capped in size and must be raster images (never SVG).
 */

export const IMAGE_PROXY_PATH = "/api/img";
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 4;
const MAX_URL_LENGTH = 4096;
const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);

const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

// ── Signing ─────────────────────────────────────────────────────────────────

let derived: { ring: unknown; keys: Buffer[] } | undefined;

/** Signing keys derived from the credential key ring (active key first). */
function signingKeys(): Buffer[] {
  const ring = credentialKeyRing();
  if (derived?.ring === ring) return derived.keys;
  const ordered = [ring.keys.get(ring.activeKeyId)!, ...[...ring.keys].filter(([id]) => id !== ring.activeKeyId).map(([, k]) => k)];
  const keys = ordered.map((k) => Buffer.from(hkdfSync("sha256", k, "matiummail", "image-proxy-v1", 32)));
  derived = { ring, keys };
  return keys;
}

function hmac(key: Buffer, url: string): string {
  return createHmac("sha256", key).update(url, "utf8").digest("base64url").slice(0, 32);
}

const DAY_S = 86_400;

/**
 * Links expire 1–2 days after the message was rendered. The expiry is
 * day-aligned, so the same image keeps the same URL (browser cache) all day,
 * but a link copied out of an email can't be used as a proxy indefinitely.
 */
export function imageLinkExpiry(nowMs = Date.now()): number {
  return (Math.floor(nowMs / 1000 / DAY_S) + 2) * DAY_S;
}

export function signImageUrl(url: string, expires: number): string {
  return hmac(signingKeys()[0], `${url}|${expires}`);
}

export function verifyImageUrl(url: string, expires: number, signature: string, nowMs = Date.now()): boolean {
  if (!/^[A-Za-z0-9_-]{32}$/.test(signature) || !Number.isInteger(expires) || expires * 1000 < nowMs) return false;
  const given = Buffer.from(signature);
  return signingKeys().some((key) => {
    const expected = Buffer.from(hmac(key, `${url}|${expires}`));
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
}

/** http(s) URL suitable for proxying, normalised; null when it can't be proxied. */
export function normaliseRemoteUrl(raw: string): string | null {
  if (!raw || raw.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (!ALLOWED_PORTS.has(url.port)) return null;
  url.hash = "";
  return url.toString();
}

/**
 * Same-origin path that serves `url` through the proxy, or null if it can't be
 * proxied. The result never contains quotes, parentheses or whitespace, so it
 * can be placed in HTML attributes and CSS url('…') as-is.
 */
export function imageProxyUrl(raw: string): string | null {
  const url = normaliseRemoteUrl(raw);
  if (!url) return null;
  const encoded = encodeURIComponent(url).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const expires = imageLinkExpiry();
  return `${IMAGE_PROXY_PATH}?u=${encoded}&e=${expires}&s=${signImageUrl(url, expires)}`;
}

// ── Address checks ──────────────────────────────────────────────────────────

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

function embeddedIpv4(address: string): string | null {
  // IPv4-mapped (::ffff:a.b.c.d / ::ffff:7f00:1) and NAT64 (64:ff9b::a.b.c.d) forms.
  const m = /^(?:::ffff:|64:ff9b::)(?:(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(address);
  if (!m) return null;
  if (m[1]) return m[1];
  const hi = parseInt(m[2], 16);
  const lo = parseInt(m[3], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

/** True only for globally routable unicast addresses. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family !== 6) return false;
  const v4 = embeddedIpv4(address.toLowerCase());
  if (v4) return isIP(v4) === 4 && !blocked.check(v4, "ipv4");
  return !blocked.check(address, "ipv6");
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** dns.lookup that only ever hands public addresses to the socket. */
function publicLookup(hostname: string, options: LookupOneOptions | LookupAllOptions, callback: LookupCallback): void {
  lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    const list = addresses as LookupAddress[];
    if (list.length === 0 || !list.every((a) => isPublicAddress(a.address))) {
      const e = Object.assign(new Error("Address not allowed"), { code: "EADDRNOTALLOWED" });
      return callback(e, []);
    }
    if ((options as LookupAllOptions).all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  });
}

// ── Fetching ────────────────────────────────────────────────────────────────

/** Image type from the first bytes (servers often send application/octet-stream). */
export function sniffImageType(head: Uint8Array): string | null {
  const b = head;
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && ascii(0, 4) === "GIF8") return "image/gif";
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (b.length >= 12 && ascii(4, 8) === "ftyp" && /^avi[fs]$/.test(ascii(8, 12))) return "image/avif";
  if (b.length >= 2 && ascii(0, 2) === "BM") return "image/bmp";
  if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return "image/x-icon";
  return null;
}

export type RemoteImage = { ok: true; body: Buffer; contentType: string } | { ok: false; status: number };

type Hop = { kind: "redirect"; location: string } | RemoteImage;

function requestOnce(url: URL, deadline: number): Promise<Hop> {
  return new Promise((done) => {
    const literal = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(literal) && !isPublicAddress(literal)) return done({ ok: false, status: 403 });
    const remaining = deadline - Date.now();
    if (remaining <= 0) return done({ ok: false, status: 504 });
    // One hard deadline for the whole exchange, body included: a server that
    // drips bytes can't keep the function alive past it.
    let settled = false;
    const hardStop = setTimeout(() => {
      req.destroy();
      resolve({ ok: false, status: 504 });
    }, remaining);
    const resolve = (hop: Hop) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardStop);
      done(hop);
    };

    const client = url.protocol === "https:" ? https : http;
    const req = client.get(
      url,
      {
        agent: false,
        lookup: publicLookup as unknown as typeof lookup,
        timeout: remaining,
        headers: {
          accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8",
          "accept-encoding": "identity",
          "user-agent": "Mozilla/5.0 (compatible; MatiumMailImageProxy/1.0)",
        },
      },
      (res) => {
        const status = res.statusCode ?? 502;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ kind: "redirect", location: res.headers.location });
        }
        if (status !== 200) {
          res.resume();
          return resolve({ ok: false, status: status === 404 || status === 410 ? 404 : 502 });
        }
        const declared = Number(res.headers["content-length"] ?? 0);
        if (declared > MAX_IMAGE_BYTES) {
          res.destroy();
          return resolve({ ok: false, status: 413 });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_IMAGE_BYTES) {
            res.destroy();
            resolve({ ok: false, status: 413 });
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", () => resolve({ ok: false, status: 502 }));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          const declaredType = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
          const sniffed = sniffImageType(body.subarray(0, 16));
          const contentType = sniffed ?? (IMAGE_TYPES.has(declaredType) ? declaredType : null);
          if (!contentType) return resolve({ ok: false, status: 415 });
          resolve({ ok: true, body, contentType });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, status: 504 });
    });
    req.on("error", (err: NodeJS.ErrnoException) => resolve({ ok: false, status: err.code === "EADDRNOTALLOWED" ? 403 : 502 }));
  });
}

export async function fetchRemoteImage(rawUrl: string): Promise<RemoteImage> {
  const deadline = Date.now() + TIMEOUT_MS;
  let current = normaliseRemoteUrl(rawUrl);
  for (let hop = 0; current && hop <= MAX_REDIRECTS; hop++) {
    const result = await requestOnce(new URL(current), deadline);
    if ("kind" in result) {
      let next: string;
      try {
        next = new URL(result.location, current).toString();
      } catch {
        return { ok: false, status: 502 };
      }
      current = normaliseRemoteUrl(next);
      continue;
    }
    return result;
  }
  return { ok: false, status: current ? 508 : 400 };
}
