/**
 * Prisma CLI configuration (migrations, generate, studio).
 *
 * The CLI only ever talks to the LOCAL development database via DATABASE_URL.
 * The running app connects through the MariaDB driver adapter instead
 * (src/server/db.ts), which enforces TLS certificate pinning in production.
 */
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  // Optional so `prisma generate` works in CI/Netlify builds without a database.
  ...(process.env.DATABASE_URL ? { datasource: { url: process.env.DATABASE_URL } } : {}),
});
