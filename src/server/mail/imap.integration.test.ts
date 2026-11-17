/**
 * Integration tests against the local GreenMail container (docker compose).
 * Skipped automatically when GreenMail is not running.
 */
import net from "node:net";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetEnvCacheForTests } from "../env";
import { classifyImapError, verifyImapLogin } from "./imap";

const GREENMAIL = { host: "127.0.0.1", port: 3993, security: "TLS" as const };
const DEV = { username: "dev@dev.local", password: "devpass" };

function baseEnv(allowSelfSigned: boolean) {
  Object.assign(process.env, {
    NODE_ENV: "test",
    APP_URL: "http://localhost:3000",
    DB_HOST: "127.0.0.1",
    DB_USER: "x",
    DB_PASSWORD: "x",
    DB_NAME: "x",
    DB_TLS: "disabled",
    CREDENTIAL_KEYS: `t:${Buffer.alloc(32, 1).toString("base64")}`,
    CREDENTIAL_ACTIVE_KEY_ID: "t",
    DEV_ALLOW_SELF_SIGNED_LOCAL_MAIL: String(allowSelfSigned),
  });
  resetEnvCacheForTests();
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port, timeout: 1000 });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
    s.once("timeout", () => (s.destroy(), resolve(false)));
  });
}

let greenmailUp = false;
beforeAll(async () => {
  greenmailUp = await portOpen(GREENMAIL.port);
});
afterEach(() => resetEnvCacheForTests());

describe("verifyImapLogin (GreenMail)", () => {
  it("accepts the right password", async (ctx) => {
    if (!greenmailUp) ctx.skip();
    baseEnv(true);
    expect(await verifyImapLogin(GREENMAIL, DEV)).toEqual({ ok: true });
  });

  it("reports auth_failed for a wrong password", async (ctx) => {
    if (!greenmailUp) ctx.skip();
    baseEnv(true);
    expect(await verifyImapLogin(GREENMAIL, { ...DEV, password: "wrong" })).toEqual({
      ok: false,
      reason: "auth_failed",
    });
  });

  it("rejects the self-signed certificate when the dev exception is off", async (ctx) => {
    if (!greenmailUp) ctx.skip();
    baseEnv(false);
    expect(await verifyImapLogin(GREENMAIL, DEV)).toEqual({ ok: false, reason: "tls_error" });
  });

  it("reports unreachable for a closed port", async () => {
    baseEnv(true);
    const res = await verifyImapLogin({ ...GREENMAIL, port: 1 }, DEV);
    expect(res).toEqual({ ok: false, reason: "unreachable" });
  });
});

describe("classifyImapError", () => {
  it.each([
    [{ authenticationFailed: true }, "auth_failed"],
    [{ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }, "tls_error"],
    [{ code: "ERR_TLS_CERT_ALTNAME_INVALID" }, "tls_error"],
    [{ code: "ETIMEDOUT" }, "timeout"],
    [{ code: "ECONNREFUSED" }, "unreachable"],
    [{ code: "ENOTFOUND" }, "unreachable"],
    [{ message: "something odd" }, "protocol_error"],
    [undefined, "protocol_error"],
  ])("%j → %s", (err, expected) => {
    expect(classifyImapError(err)).toBe(expected);
  });
});
