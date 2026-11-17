import "server-only";
import { X509Certificate } from "node:crypto";
import type { PeerCertificate } from "node:tls";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@/generated/prisma/client";
import { env, type ServerEnv } from "./env";

/**
 * Prisma client over the official MariaDB driver.
 *
 * Production (DB_TLS=pinned): TLS is mandatory and the server certificate must
 * be byte-for-byte the pinned one (SHA-256 fingerprint). MilesWeb's MariaDB
 * presents a long-lived self-signed certificate, so pinning is stronger than
 * trusting any CA. Plaintext is only possible for a localhost database
 * (enforced in env.ts).
 */

type TlsOptions = {
  ca: string;
  rejectUnauthorized: true;
  checkServerIdentity: (host: string, cert: PeerCertificate) => Error | undefined;
};

export function buildDbTls(e: Pick<ServerEnv, "DB_TLS" | "DB_TLS_CA_PEM_BASE64">): TlsOptions | undefined {
  if (e.DB_TLS === "disabled") return undefined;
  const pem = Buffer.from(e.DB_TLS_CA_PEM_BASE64 ?? "", "base64").toString("utf8");
  let pinned: string;
  try {
    pinned = new X509Certificate(pem).fingerprint256;
  } catch {
    throw new Error("DB_TLS_CA_PEM_BASE64 is not a valid base64-encoded PEM certificate");
  }
  return {
    ca: pem,
    rejectUnauthorized: true,
    checkServerIdentity: (_host, cert) =>
      cert.fingerprint256 === pinned
        ? undefined
        : new Error("Database TLS certificate does not match the pinned certificate"),
  };
}

function createClient(): PrismaClient {
  const e = env();
  const adapter = new PrismaMariaDb({
    host: e.DB_HOST,
    port: e.DB_PORT,
    user: e.DB_USER,
    password: e.DB_PASSWORD,
    database: e.DB_NAME,
    connectionLimit: e.DB_CONNECTION_LIMIT,
    connectTimeout: 10_000,
    ssl: buildDbTls(e),
  });
  return new PrismaClient({
    adapter,
    log: e.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

// Reuse one client per server instance (and across hot reloads in development).
const globalForPrisma = globalThis as unknown as { __matiumPrisma?: PrismaClient };

export function db(): PrismaClient {
  globalForPrisma.__matiumPrisma ??= createClient();
  return globalForPrisma.__matiumPrisma;
}
