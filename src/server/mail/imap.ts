import "server-only";
import { isIP } from "node:net";
import { ImapFlow, type ImapFlowOptions } from "imapflow";
import { env, isLocalHost } from "../env";

/**
 * IMAP connection helpers.
 *
 * Security rules (never relaxed in production):
 *   - TLS always: implicit TLS ("TLS") or mandatory STARTTLS ("STARTTLS");
 *     there is no plaintext mode.
 *   - Certificates are verified against the hostname. The only exception is a
 *     localhost dev server (GreenMail) when DEV_ALLOW_SELF_SIGNED_LOCAL_MAIL is
 *     on and NODE_ENV is not production.
 *   - Protocol logging is off, so credentials can never reach logs.
 */

export type MailEndpoint = {
  host: string;
  port: number;
  security: "TLS" | "STARTTLS";
  /** Certificate name to verify, if it differs from `host`. */
  tlsServername?: string | null;
};

export type MailCredentials = { username: string; password: string };

export type ImapVerifyFailure = "auth_failed" | "tls_error" | "timeout" | "unreachable" | "protocol_error";
export type ImapVerifyResult = { ok: true } | { ok: false; reason: ImapVerifyFailure };

export function imapConnectionOptions(ep: MailEndpoint, creds: MailCredentials): ImapFlowOptions {
  const allowSelfSigned = env().allowSelfSignedLocalMail && isLocalHost(ep.host);
  // SNI must be a hostname; Node rejects IP addresses as TLS server names.
  const name = ep.tlsServername || ep.host;
  const servername = isIP(name) ? undefined : name;
  return {
    host: ep.host,
    port: ep.port,
    secure: ep.security === "TLS",
    doSTARTTLS: ep.security === "STARTTLS" ? true : undefined,
    servername,
    auth: { user: creds.username, pass: creds.password },
    tls: { rejectUnauthorized: !allowSelfSigned, minVersion: "TLSv1.2", servername },
    logger: false,
    emitLogs: false,
    disableAutoIdle: true,
    connectionTimeout: 10_000,
    greetingTimeout: 8_000,
    socketTimeout: 30_000,
  };
}

/** Classify a connection/login error without exposing server text to callers. */
export function classifyImapError(err: unknown): ImapVerifyFailure {
  const e = (err ?? {}) as { authenticationFailed?: boolean; code?: unknown; message?: unknown };
  if (e.authenticationFailed) return "auth_failed";
  const text = `${String(e.code ?? "")} ${String(e.message ?? "")}`;
  if (/CERT|SELF_SIGNED|ERR_TLS|UNABLE_TO_VERIFY|ALTNAME|certificate/i.test(text)) return "tls_error";
  if (/ETIMEDOUT|timeout|timed out/i.test(text)) return "timeout";
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ECONNRESET|NoConnection/i.test(text)) {
    return "unreachable";
  }
  return "protocol_error";
}

/**
 * Check a mailbox login: connect, authenticate, log out. Nothing else is read.
 * Never throws; returns a coarse reason on failure.
 */
export async function verifyImapLogin(ep: MailEndpoint, creds: MailCredentials): Promise<ImapVerifyResult> {
  const client = new ImapFlow({ ...imapConnectionOptions(ep, creds), verifyOnly: true });
  client.on("error", () => {
    /* surfaced through connect() rejection; prevent unhandled 'error' events */
  });
  try {
    await client.connect();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: classifyImapError(err) };
  } finally {
    client.close();
  }
}
