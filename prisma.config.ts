/**
 * Prisma CLI configuration (migrations, generate, studio).
 *
 * The CLI only ever talks to the LOCAL development database via DATABASE_URL.
 * The running app connects through the MariaDB driver adapter instead
 * (src/server/db.ts), which enforces TLS certificate pinning in production.
 */
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
