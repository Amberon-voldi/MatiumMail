import "server-only";
import { createHash, randomBytes } from "node:crypto";

/** URL-safe random token (default 256 bits). Used for session cookies. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Lower-case hex SHA-256 of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
