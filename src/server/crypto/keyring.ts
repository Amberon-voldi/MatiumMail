import "server-only";
import { env } from "../env";
import { parseKeyRing, type KeyRing, type SecretContext } from "./envelope";

let ring: KeyRing | undefined;

/** The credential key ring from the environment (parsed once per instance). */
export function credentialKeyRing(): KeyRing {
  if (!ring) {
    const e = env();
    ring = parseKeyRing(e.CREDENTIAL_KEYS, e.CREDENTIAL_ACTIVE_KEY_ID);
  }
  return ring;
}

/** Encryption context for a mailbox's stored IMAP/SMTP secret. */
export function mailboxCredentialContext(mailboxId: string, version: number): SecretContext {
  return { purpose: "mailbox-credential", subjectId: mailboxId, version };
}
