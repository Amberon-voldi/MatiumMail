/**
 * Apply Prisma migrations to the database configured in the environment
 * (the MilesWeb MariaDB), over the app's TLS-verified connection.
 *
 *   npm run db:migrate:remote            apply pending migrations
 *   npm run db:migrate:remote -- --status   list applied / pending, change nothing
 *
 * Why not `prisma migrate deploy`? The Prisma CLI can only verify TLS against a
 * CA + hostname; MilesWeb's MariaDB has a self-signed certificate on an IP
 * address, so the CLI would require disabling verification. This script uses
 * the same certificate pinning as the app instead, and records each migration
 * in Prisma's own `_prisma_migrations` table (same columns, SHA-256 checksum),
 * so `prisma migrate` tooling stays consistent with what was applied.
 *
 * MariaDB DDL is not transactional: if a migration fails part-way, the row is
 * left with finished_at = NULL and the error in `logs`, and the script stops.
 */
import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import mariadb from "mariadb";
import { buildDbTls } from "../src/server/db";
import { env } from "../src/server/env";

const MIGRATIONS_DIR = path.resolve("prisma/migrations");

type Applied = { migration_name: string; checksum: string; finished_at: Date | null; rolled_back_at: Date | null };

function localMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => statSync(path.join(MIGRATIONS_DIR, name)).isDirectory())
    .sort()
    .map((name) => {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");
      return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    });
}

async function main() {
  const statusOnly = process.argv.includes("--status");
  const e = env();
  const conn = await mariadb.createConnection({
    host: e.DB_HOST,
    port: e.DB_PORT,
    user: e.DB_USER,
    password: e.DB_PASSWORD,
    database: e.DB_NAME,
    ssl: buildDbTls(e),
    multipleStatements: true,
    connectTimeout: 15_000,
  });

  try {
    const [tls] = await conn.query("SHOW SESSION STATUS LIKE 'Ssl_version'");
    console.log(`Connected to ${e.DB_HOST}/${e.DB_NAME} (TLS: ${tls?.Value || "none"})`);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS _prisma_migrations (
        id                  VARCHAR(36)  NOT NULL PRIMARY KEY,
        checksum            VARCHAR(64)  NOT NULL,
        finished_at         DATETIME(3)  NULL,
        migration_name      VARCHAR(255) NOT NULL,
        logs                TEXT         NULL,
        rolled_back_at      DATETIME(3)  NULL,
        started_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        applied_steps_count INT UNSIGNED NOT NULL DEFAULT 0
      ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

    const applied: Applied[] = await conn.query(
      "SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations",
    );
    const byName = new Map(applied.filter((a) => !a.rolled_back_at).map((a) => [a.migration_name, a]));

    const failed = applied.find((a) => !a.finished_at && !a.rolled_back_at);
    if (failed) {
      throw new Error(
        `Migration ${failed.migration_name} previously failed part-way. Inspect the database and the row's logs, fix manually, then mark it rolled back before retrying.`,
      );
    }

    let pending = 0;
    for (const m of localMigrations()) {
      const done = byName.get(m.name);
      if (done) {
        if (done.checksum !== m.checksum) {
          throw new Error(`Migration ${m.name} was modified after it was applied (checksum mismatch). Refusing to continue.`);
        }
        console.log(`  ✓ ${m.name}`);
        continue;
      }
      pending++;
      if (statusOnly) {
        console.log(`  • ${m.name}  (pending)`);
        continue;
      }

      const id = randomUUID();
      await conn.query(
        "INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, applied_steps_count) VALUES (?, ?, ?, NOW(3), 0)",
        [id, m.checksum, m.name],
      );
      try {
        await conn.query(m.sql);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await conn.query("UPDATE _prisma_migrations SET logs = ? WHERE id = ?", [message.slice(0, 60_000), id]);
        throw new Error(`Migration ${m.name} failed: ${message}`);
      }
      await conn.query("UPDATE _prisma_migrations SET finished_at = NOW(3), applied_steps_count = 1 WHERE id = ?", [id]);
      console.log(`  ✓ ${m.name}  (applied now)`);
    }

    console.log(
      statusOnly
        ? `\n${pending} pending migration(s).`
        : pending
          ? `\nApplied ${pending} migration(s).`
          : "\nDatabase is up to date.",
    );
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
