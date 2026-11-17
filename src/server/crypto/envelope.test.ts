import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openSecret, parseKeyRing, rewrapSecret, sealSecret, type SecretContext } from "./envelope";

const key = () => randomBytes(32).toString("base64");
const ctx: SecretContext = { purpose: "mailbox-credential", subjectId: "mbx-1", version: 1 };

describe("parseKeyRing", () => {
  it("parses multiple keys and checks the active id", () => {
    const ring = parseKeyRing(`a:${key()}, b:${key()}`, "b");
    expect(ring.activeKeyId).toBe("b");
    expect([...ring.keys.keys()]).toEqual(["a", "b"]);
  });

  it.each([
    ["missing separator", `abc`, "abc"],
    ["wrong key length", `a:${randomBytes(16).toString("base64")}`, "a"],
    ["bad key id", `a b:${key()}`, "a b"],
    ["unknown active id", `a:${key()}`, "zzz"],
  ])("rejects %s", (_label, spec, active) => {
    expect(() => parseKeyRing(spec, active)).toThrow();
  });

  it("rejects duplicate ids", () => {
    const k = key();
    expect(() => parseKeyRing(`a:${k},a:${k}`, "a")).toThrow(/duplicate/);
  });
});

describe("seal/open", () => {
  const ring = parseKeyRing(`k1:${key()}`, "k1");

  it("round-trips unicode secrets", () => {
    const secret = "pässwörd-🔐-" + "x".repeat(200);
    const sealed = sealSecret(ring, ctx, secret);
    expect(sealed.keyId).toBe("k1");
    expect(sealed.iv).toHaveLength(12);
    expect(sealed.authTag).toHaveLength(16);
    expect(sealed.wrappedDek).toHaveLength(60);
    expect(sealed.ciphertext.toString("utf8")).not.toContain("pässwörd");
    expect(openSecret(ring, ctx, sealed)).toBe(secret);
  });

  it("uses a fresh IV and DEK every time", () => {
    const a = sealSecret(ring, ctx, "same");
    const b = sealSecret(ring, ctx, "same");
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false);
  });

  it("fails when the ciphertext is moved to another mailbox", () => {
    const sealed = sealSecret(ring, ctx, "secret");
    expect(() => openSecret(ring, { ...ctx, subjectId: "mbx-2" }, sealed)).toThrow();
  });

  it("fails when the version or purpose differs", () => {
    const sealed = sealSecret(ring, ctx, "secret");
    expect(() => openSecret(ring, { ...ctx, version: 2 }, sealed)).toThrow();
    expect(() => openSecret(ring, { ...ctx, purpose: "totp" }, sealed)).toThrow();
  });

  it("fails on any tampering", () => {
    const sealed = sealSecret(ring, ctx, "secret");
    const flip = (b: Buffer) => {
      const c = Buffer.from(b);
      c[c.length - 1] ^= 0x01;
      return c;
    };
    expect(() => openSecret(ring, ctx, { ...sealed, ciphertext: flip(sealed.ciphertext) })).toThrow();
    expect(() => openSecret(ring, ctx, { ...sealed, authTag: flip(sealed.authTag) })).toThrow();
    expect(() => openSecret(ring, ctx, { ...sealed, wrappedDek: flip(sealed.wrappedDek) })).toThrow();
  });

  it("fails with a different key ring", () => {
    const sealed = sealSecret(ring, ctx, "secret");
    const other = parseKeyRing(`k1:${key()}`, "k1");
    expect(() => openSecret(other, ctx, sealed)).toThrow();
  });

  it("rejects an invalid context", () => {
    expect(() => sealSecret(ring, { ...ctx, version: 0 }, "x")).toThrow(/context/);
    expect(() => sealSecret(ring, { ...ctx, subjectId: "" }, "x")).toThrow(/context/);
  });
});

describe("key rotation", () => {
  it("re-wraps under the new active key without changing the secret", () => {
    const v1 = key();
    const v2 = key();
    const ringV1 = parseKeyRing(`v1:${v1}`, "v1");
    const sealed = sealSecret(ringV1, ctx, "rotate-me");

    const ringBoth = parseKeyRing(`v1:${v1},v2:${v2}`, "v2");
    const rewrapped = rewrapSecret(ringBoth, ctx, sealed);
    expect(rewrapped.keyId).toBe("v2");

    // After rotation the old key can be removed entirely.
    const ringV2Only = parseKeyRing(`v2:${v2}`, "v2");
    expect(openSecret(ringV2Only, ctx, { ...sealed, ...rewrapped })).toBe("rotate-me");
    // A row that was not re-wrapped can no longer be opened without v1.
    expect(() => openSecret(ringV2Only, ctx, sealed)).toThrow(/not in the key ring/);
  });
});
