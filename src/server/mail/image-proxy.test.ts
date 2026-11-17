import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

// Signing keys come from the credential key ring in the environment.
beforeAll(() => {
  process.env.CREDENTIAL_KEYS = `k1:${randomBytes(32).toString("base64")}`;
  process.env.CREDENTIAL_ACTIVE_KEY_ID = "k1";
  process.env.APP_URL ??= "http://localhost:3000";
  process.env.DB_HOST ??= "localhost";
  process.env.DB_USER ??= "test";
  process.env.DB_PASSWORD ??= "test";
  process.env.DB_NAME ??= "test";
  process.env.DB_TLS ??= "disabled";
});

const load = () => import("./image-proxy");

describe("isPublicAddress", () => {
  it.each([
    ["127.0.0.1", false],
    ["10.1.2.3", false],
    ["172.16.0.9", false],
    ["192.168.1.1", false],
    ["169.254.169.254", false], // cloud metadata
    ["100.64.0.1", false],
    ["0.0.0.0", false],
    ["::1", false],
    ["fd00::1", false],
    ["fe80::1", false],
    ["::ffff:127.0.0.1", false],
    ["::ffff:7f00:1", false],
    ["64:ff9b::a9fe:a9fe", false], // NAT64 form of 169.254.169.254
    ["64:ff9b::169.254.169.254", false],
    ["8.8.8.8", true],
    ["2606:4700:4700::1111", true],
    ["not-an-ip", false],
  ])("%s → %s", async (ip, expected) => {
    const { isPublicAddress } = await load();
    expect(isPublicAddress(ip)).toBe(expected);
  });
});

describe("normaliseRemoteUrl", () => {
  it("allows http(s) on normal ports only", async () => {
    const { normaliseRemoteUrl } = await load();
    expect(normaliseRemoteUrl("https://cdn.example/a.png#x")).toBe("https://cdn.example/a.png");
    expect(normaliseRemoteUrl("http://cdn.example:8080/a.png")).toBe("http://cdn.example:8080/a.png");
    expect(normaliseRemoteUrl("https://cdn.example:6379/a.png")).toBeNull();
    expect(normaliseRemoteUrl("file:///etc/passwd")).toBeNull();
    expect(normaliseRemoteUrl("https://user:pw@cdn.example/a.png")).toBeNull();
    expect(normaliseRemoteUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("signing", () => {
  it("only accepts URLs this server signed", async () => {
    const { imageProxyUrl, verifyImageUrl } = await load();
    const path = imageProxyUrl("https://cdn.example/logo.png?a=(1)")!;
    expect(path).toMatch(/^\/api\/img\?u=/);
    expect(path).not.toMatch(/['()\s"]/); // safe inside CSS url('…') and attributes
    const params = new URL(path, "http://x").searchParams;
    const u = params.get("u")!;
    const s = params.get("s")!;
    const e = Number(params.get("e"));
    expect(verifyImageUrl(u, e, s)).toBe(true);
    expect(verifyImageUrl("https://cdn.example/other.png", e, s)).toBe(false);
    expect(verifyImageUrl(u, e + 86_400, s)).toBe(false); // can't extend the expiry
    expect(verifyImageUrl(u, e, s.replace(/^./, s[0] === "A" ? "B" : "A"))).toBe(false);
    expect(verifyImageUrl(u, e, "short")).toBe(false);
  });

  it("links expire after one to two days and stay stable within a day", async () => {
    const { imageLinkExpiry, signImageUrl, verifyImageUrl } = await load();
    const now = Date.UTC(2026, 10, 18, 9, 0, 0);
    const e = imageLinkExpiry(now);
    expect(imageLinkExpiry(now + 3 * 3600_000)).toBe(e);
    expect(e * 1000 - now).toBeGreaterThan(86_400_000);
    const s = signImageUrl("https://cdn.example/a.png", e);
    expect(verifyImageUrl("https://cdn.example/a.png", e, s, now)).toBe(true);
    expect(verifyImageUrl("https://cdn.example/a.png", e, s, e * 1000 + 1)).toBe(false);
  });
});

describe("sniffImageType", () => {
  it("recognises raster formats and refuses others", async () => {
    const { sniffImageType } = await load();
    expect(sniffImageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(new TextEncoder().encode("GIF89a"))).toBe("image/gif");
    expect(sniffImageType(new TextEncoder().encode("RIFF\0\0\0\0WEBP"))).toBe("image/webp");
    expect(sniffImageType(new TextEncoder().encode("<svg xmlns="))).toBeNull();
    expect(sniffImageType(new TextEncoder().encode("<html>"))).toBeNull();
  });
});
