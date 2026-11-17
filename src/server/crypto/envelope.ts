import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Envelope encryption for secrets at rest (mailbox passwords, TOTP secrets).
 *
 *   KEK (key-encryption key)  — from the key ring in the environment
 *     └─ wraps a per-secret DEK (data-encryption key, 32 random bytes)
 *          └─ encrypts the secret
 *
 * Both layers use AES-256-GCM. The additional authenticated data (AAD) binds
 * every ciphertext to its purpose, subject (e.g. mailbox id) and version, so a
 * ciphertext copied onto another row fails to decrypt.
 *
 * Rotation: add a new KEK, make it active, then `rewrapSecret()` each row —
 * only the 32-byte DEK is re-encrypted; the secret itself is untouched.
 */

const ALG = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

export type KeyRing = {
  readonly activeKeyId: string;
  readonly keys: ReadonlyMap<string, Buffer>;
};

export type SecretContext = {
  /** What the secret is, e.g. "mailbox-credential". */
  purpose: string;
  /** Row the secret belongs to, e.g. the mailbox id. */
  subjectId: string;
  /** Monotonic version of the secret for that subject. */
  version: number;
};

export type SealedSecret = {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  /** wrapIv (12) ‖ wrapTag (16) ‖ encrypted DEK (32) */
  wrappedDek: Buffer;
  keyId: string;
};

/** Parse "id1:base64,id2:base64" into a key ring. Throws on any malformed entry. */
export function parseKeyRing(spec: string, activeKeyId: string): KeyRing {
  const keys = new Map<string, Buffer>();
  for (const raw of spec.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const sep = entry.indexOf(":");
    if (sep <= 0) throw new Error("CREDENTIAL_KEYS: each entry must be '<keyId>:<base64>'");
    const id = entry.slice(0, sep);
    if (!KEY_ID.test(id)) throw new Error(`CREDENTIAL_KEYS: invalid key id '${id}'`);
    if (keys.has(id)) throw new Error(`CREDENTIAL_KEYS: duplicate key id '${id}'`);
    const key = Buffer.from(entry.slice(sep + 1), "base64");
    if (key.length !== KEY_BYTES) {
      throw new Error(`CREDENTIAL_KEYS: key '${id}' must decode to ${KEY_BYTES} bytes`);
    }
    keys.set(id, key);
  }
  if (!keys.has(activeKeyId)) {
    throw new Error("CREDENTIAL_ACTIVE_KEY_ID does not match any key in CREDENTIAL_KEYS");
  }
  return { activeKeyId, keys };
}

function aad(ctx: SecretContext, part: "data" | "dek"): Buffer {
  if (!ctx.purpose || !ctx.subjectId || !Number.isInteger(ctx.version) || ctx.version < 1) {
    throw new Error("invalid secret context");
  }
  return Buffer.from(`matiummail|${ctx.purpose}|${part}|${ctx.subjectId}|v${ctx.version}`, "utf8");
}

function encrypt(key: Buffer, plaintext: Buffer, additional: Buffer) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(additional);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, ciphertext, authTag: cipher.getAuthTag() };
}

function decrypt(key: Buffer, iv: Buffer, ciphertext: Buffer, authTag: Buffer, additional: Buffer) {
  const decipher = createDecipheriv(ALG, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(additional);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function wrapDek(ring: KeyRing, dek: Buffer, ctx: SecretContext): { wrappedDek: Buffer; keyId: string } {
  const kek = ring.keys.get(ring.activeKeyId);
  if (!kek) throw new Error("active key missing from key ring");
  const w = encrypt(kek, dek, aad(ctx, "dek"));
  return { wrappedDek: Buffer.concat([w.iv, w.authTag, w.ciphertext]), keyId: ring.activeKeyId };
}

function unwrapDek(ring: KeyRing, wrapped: Uint8Array, keyId: string, ctx: SecretContext): Buffer {
  const kek = ring.keys.get(keyId);
  if (!kek) throw new Error(`key '${keyId}' is not in the key ring (was it removed before re-wrapping?)`);
  const buf = Buffer.from(wrapped);
  if (buf.length !== IV_BYTES + TAG_BYTES + KEY_BYTES) throw new Error("malformed wrapped key");
  return decrypt(
    kek,
    buf.subarray(0, IV_BYTES),
    buf.subarray(IV_BYTES + TAG_BYTES),
    buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES),
    aad(ctx, "dek"),
  );
}

/** Encrypt a secret under a fresh DEK wrapped by the active KEK. */
export function sealSecret(ring: KeyRing, ctx: SecretContext, plaintext: string): SealedSecret {
  const dek = randomBytes(KEY_BYTES);
  try {
    const data = encrypt(dek, Buffer.from(plaintext, "utf8"), aad(ctx, "data"));
    return { ...data, ...wrapDek(ring, dek, ctx) };
  } finally {
    dek.fill(0);
  }
}

/** Decrypt a sealed secret. Throws if anything was tampered with or mismatched. */
export function openSecret(
  ring: KeyRing,
  ctx: SecretContext,
  sealed: { ciphertext: Uint8Array; iv: Uint8Array; authTag: Uint8Array; wrappedDek: Uint8Array; keyId: string },
): string {
  const dek = unwrapDek(ring, sealed.wrappedDek, sealed.keyId, ctx);
  try {
    return decrypt(
      dek,
      Buffer.from(sealed.iv),
      Buffer.from(sealed.ciphertext),
      Buffer.from(sealed.authTag),
      aad(ctx, "data"),
    ).toString("utf8");
  } finally {
    dek.fill(0);
  }
}

/** Re-wrap the DEK under the currently active KEK (key rotation). */
export function rewrapSecret(
  ring: KeyRing,
  ctx: SecretContext,
  sealed: { wrappedDek: Uint8Array; keyId: string },
): { wrappedDek: Buffer; keyId: string } {
  const dek = unwrapDek(ring, sealed.wrappedDek, sealed.keyId, ctx);
  try {
    return wrapDek(ring, dek, ctx);
  } finally {
    dek.fill(0);
  }
}
