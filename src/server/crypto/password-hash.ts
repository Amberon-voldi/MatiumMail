import "server-only";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Hashing for the app's own sign-in password (scrypt, built into Node).
 *
 * Stored as `scrypt$<log2 N>$<r>$<p>$<salt>$<hash>` (base64url), so the cost
 * can be raised later without invalidating existing hashes. 2^16 × 8 needs
 * 64 MiB per hash: well within a server function, slow enough to make
 * offline guessing of short passwords expensive.
 */

const LOG_N = 16;
const R = 8;
const P = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const MAX_MEM = 256 * 1024 * 1024;

function derive(password: string, salt: Buffer, logN: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // NFKC so the same password typed on different keyboards/OSes matches.
    scrypt(password.normalize("NFKC"), salt, KEY_BYTES, { N: 2 ** logN, r, p, maxmem: MAX_MEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, LOG_N, R, P);
  return ["scrypt", LOG_N, R, P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/** Constant-time check. A malformed stored hash never matches. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [logN, r, p] = parts.slice(1, 4).map(Number);
  // Bounds keep a corrupted row from asking for gigabytes of memory.
  if (!(logN >= 10 && logN <= 20 && r >= 1 && r <= 32 && p >= 1 && p <= 4)) return false;
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  if (salt.length < SALT_BYTES || expected.length !== KEY_BYTES) return false;
  const actual = await derive(password, salt, logN, r, p);
  return timingSafeEqual(actual, expected);
}
