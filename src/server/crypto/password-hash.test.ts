import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password-hash";

describe("password hashing", () => {
  it("verifies the right password and rejects others", async () => {
    const stored = await hashPassword("abc123");
    expect(stored).toMatch(/^scrypt\$16\$8\$1\$[\w-]+\$[\w-]+$/);
    expect(await verifyPassword("abc123", stored)).toBe(true);
    expect(await verifyPassword("abc124", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });

  it("matches the same password in a different Unicode form", async () => {
    const stored = await hashPassword("café");
    expect(await verifyPassword("café", stored)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["wrong scheme", "bcrypt$16$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA"],
    ["missing parts", "scrypt$16$8$1$AAAAAAAAAAAAAAAAAAAAAA"],
    ["cost too high", "scrypt$30$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
    ["short key", "scrypt$16$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA"],
  ])("never matches a malformed hash (%s)", async (_label, stored) => {
    expect(await verifyPassword("anything", stored)).toBe(false);
  });
});
