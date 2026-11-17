import "server-only";
import { connect as netConnect, isIP, type Socket } from "node:net";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import { audit } from "../audit";
import type { AuthorizedMailbox } from "../auth/dal";
import { roleAllows } from "../auth/dal";
import { db } from "../db";
import { env, isLocalHost } from "../env";
import { loadMailboxConnection, withImap } from "./client";

/**
 * Sending mail through the mailbox's own SMTP server (MilesWeb), then saving
 * the identical bytes to the Sent folder over IMAP.
 *
 * MilesWeb's Postfix delays its SMTP greeting by ~23 s, hence the generous
 * greeting timeout. TLS is always verified (implicit TLS or required STARTTLS).
 */

export type OutgoingAttachment = {
  filename: string;
  contentType: string;
  content: Buffer;
  /** Content-ID for images shown inside the HTML body (cid:…). */
  cid?: string;
};

export type OutgoingMessage = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string | null;
  references?: string[];
  attachments?: OutgoingAttachment[];
  /** Extra headers (e.g. the composer's draft key). */
  headers?: Record<string, string>;
};

export type SendResult = { messageId: string; savedToSent: boolean };

export class SendError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "SendError";
  }
}

/**
 * RFC 5322 bytes for a message from this mailbox. Drafts keep their Bcc header
 * (so it survives re-opening); sent mail never carries it.
 */
export async function buildMime(
  from: { address: string; displayName: string | null },
  msg: OutgoingMessage,
  opts: { keepBcc?: boolean } = {},
) {
  const node = new MailComposer({
    from: { name: from.displayName ?? "", address: from.address },
    to: msg.to,
    cc: msg.cc?.length ? msg.cc : undefined,
    bcc: msg.bcc?.length ? msg.bcc : undefined,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    inReplyTo: msg.inReplyTo ?? undefined,
    references: msg.references?.length ? msg.references : undefined,
    attachments: msg.attachments?.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      content: a.content,
      ...(a.cid ? { cid: a.cid, contentDisposition: "inline" as const } : {}),
    })),
    headers: msg.headers,
    date: new Date(),
    disableFileAccess: true,
    disableUrlAccess: true,
  }).compile();
  node.keepBcc = Boolean(opts.keepBcc); // Bcc recipients get the mail but never appear in its headers.
  const raw = await node.build();
  return { raw, envelope: node.getEnvelope(), messageId: node.messageId() };
}

export async function sendMessage(auth: AuthorizedMailbox, msg: OutgoingMessage): Promise<SendResult> {
  if (!roleAllows(auth.role, "send")) throw new Error("Not permitted: send");
  const conn = await loadMailboxConnection(auth.mailboxId);
  const { raw, envelope, messageId } = await buildMime(conn, msg);

  const allowSelfSigned = env().allowSelfSignedLocalMail && isLocalHost(conn.smtp.host);
  const servername = conn.smtp.tlsServername || conn.smtp.host;
  const transport = nodemailer.createTransport({
    // Nodemailer resolves hostnames with its own IPv4-first DNS lookup and then
    // connects to the raw address, which fails on IPv6-only (NAT64) networks.
    // Open the TCP connection with the OS resolver instead (like ImapFlow);
    // Nodemailer still performs the TLS handshake/STARTTLS and verification.
    getSocket: (_options, callback) => {
      let settled = false;
      const settle = (err: Error | null, socket?: Socket) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          socket?.destroy();
          callback(err, false);
        } else callback(null, { connection: socket });
      };
      const socket = netConnect({ host: conn.smtp.host, port: conn.smtp.port });
      const timer = setTimeout(
        () => settle(Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT" }), socket),
        20_000,
      );
      socket.once("connect", () => settle(null, socket));
      socket.once("error", (err) => settle(err, socket));
    },
    host: conn.smtp.host,
    port: conn.smtp.port,
    secure: conn.smtp.security === "TLS",
    requireTLS: conn.smtp.security === "STARTTLS",
    auth: { user: conn.username, pass: conn.password },
    tls: {
      rejectUnauthorized: !allowSelfSigned,
      minVersion: "TLSv1.2",
      ...(isIP(servername) ? {} : { servername }),
    },
    // MilesWeb delays the TLS handshake on 465 (and the greeting on 587) by ~23 s;
    // for implicit TLS Nodemailer counts the handshake as part of "connection".
    connectionTimeout: 45_000,
    greetingTimeout: 45_000,
    socketTimeout: 60_000,
    logger: false,
    debug: false,
  });

  try {
    await transport.sendMail({ envelope, raw });
  } catch (err) {
    const e = err as { code?: string; responseCode?: number; command?: string };
    // Diagnostic only: error code / SMTP stage / response code — never credentials or content.
    console.error("[smtp] send failed", { code: e.code, command: e.command, responseCode: e.responseCode });
    if (e.code === "EAUTH") throw new SendError("The mail server rejected the mailbox password.", e.code);
    if (e.responseCode === 552) {
      throw new SendError("The message is too large for the mail server. Try smaller or fewer attachments.", e.code);
    }
    if (e.responseCode && e.responseCode >= 500) {
      throw new SendError("The mail server refused this message (check the recipient addresses).", e.code);
    }
    throw new SendError("Couldn't send right now. Please try again in a minute.", e.code);
  } finally {
    transport.close();
  }

  // Save a copy to Sent (MilesWeb's SMTP doesn't do this server-side).
  let savedToSent = false;
  try {
    const sent = await db().mailFolder.findFirst({
      where: { mailboxId: auth.mailboxId, specialUse: "SENT" },
      select: { path: true },
    });
    if (sent) {
      await withImap(auth.mailboxId, (client) => client.append(sent.path, raw, ["\\Seen"]));
      savedToSent = true;
    }
  } catch (err) {
    console.error("[smtp] sent, but saving to Sent failed", err instanceof Error ? err.message : err);
  }

  await audit({
    organizationId: conn.organizationId,
    action: "mail.sent",
    actorUserId: auth.userId,
    mailboxId: auth.mailboxId,
    metadata: { messageId, recipients: envelope.to.length, savedToSent },
  });
  return { messageId, savedToSent };
}
