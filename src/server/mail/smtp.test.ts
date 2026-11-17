import { describe, expect, it } from "vitest";
import { ehloName } from "./smtp";

describe("ehloName", () => {
  it("greets with the app's public hostname", () => {
    expect(ehloName("a@spinternationalpvtltd.com", "https://webmail.matiumtech.com")).toBe("webmail.matiumtech.com");
  });

  it("falls back to the sender's domain when the app URL isn't a public name", () => {
    expect(ehloName("a@spinternationalpvtltd.com", "http://localhost:3000")).toBe("spinternationalpvtltd.com");
    expect(ehloName("a@noida.fit", "http://127.0.0.1:3000")).toBe("noida.fit");
    expect(ehloName("a@noida.fit", "not a url")).toBe("noida.fit");
  });
});
