import "server-only";
import { isIP } from "node:net";
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

export type OutgoingMessage = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string | null;
  references?: string[];
};

export type SendResult = { messageId: string; savedToSent: boolean };

export class SendError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "SendError";
  }
}

export async function sendMessage(auth: AuthorizedMailbox, msg: OutgoingMessage): Promise<SendResult> {
  if (!roleAllows(auth.role, "send")) throw new Error("Not permitted: send");
  const conn = await loadMailboxConnection(auth.mailboxId);

  const node = new MailComposer({
    from: { name: conn.displayName ?? "", address: conn.address },
    to: msg.to,
    cc: msg.cc?.length ? msg.cc : undefined,
    bcc: msg.bcc?.length ? msg.bcc : undefined,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    inReplyTo: msg.inReplyTo ?? undefined,
    references: msg.references?.length ? msg.references : undefined,
    date: new Date(),
    disableFileAccess: true,
    disableUrlAccess: true,
  }).compile();
  node.keepBcc = false; // Bcc recipients get the mail but never appear in its headers.
  const raw = await node.build();
  const envelope = node.getEnvelope();
  const messageId = node.messageId();

  const allowSelfSigned = env().allowSelfSignedLocalMail && isLocalHost(conn.smtp.host);
  const servername = conn.smtp.tlsServername || conn.smtp.host;
  const transport = nodemailer.createTransport({
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
    connectionTimeout: 20_000,
    greetingTimeout: 45_000,
    socketTimeout: 60_000,
    logger: false,
    debug: false,
  });

  try {
    await transport.sendMail({ envelope, raw });
  } catch (err) {
    const e = err as { code?: string; responseCode?: number };
    if (e.code === "EAUTH") throw new SendError("The mail server rejected the mailbox password.", e.code);
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
