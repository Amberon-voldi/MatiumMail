import { describe, expect, it } from "vitest";
import { MAX_ACCOUNTS, parseSessionCookie, serializeSessionCookie } from "./cookie";

const token = (n: number) => `tok${String(n).padStart(2, "0")}_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;

describe("session cookie", () => {
  it("reads a single-token cookie from before multi-account support", () => {
    expect(parseSessionCookie(token(1))).toEqual([token(1)]);
  });

  it("round-trips several tokens in order", () => {
    const tokens = [token(1), token(2), token(3)];
    expect(parseSessionCookie(serializeSessionCookie(tokens))).toEqual(tokens);
  });

  it("drops junk, duplicates and anything past the account limit", () => {
    expect(parseSessionCookie(undefined)).toEqual([]);
    expect(parseSessionCookie("")).toEqual([]);
    expect(parseSessionCookie(`${token(1)}..short.${token(1)}.bad token!`)).toEqual([token(1)]);
    const many = Array.from({ length: MAX_ACCOUNTS + 3 }, (_, i) => token(i));
    expect(parseSessionCookie(serializeSessionCookie(many))).toEqual(many.slice(0, MAX_ACCOUNTS));
  });
});
