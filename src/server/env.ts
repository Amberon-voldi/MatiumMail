import "server-only";
import { z } from "zod";

/**
 * Server environment, validated once on first use.
 *
 * Validation is lazy (not at import time) so `next build` can analyse modules
 * without production secrets present. Error messages name the offending
 * variables but never echo their values.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.has(host.trim().toLowerCase());
}

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    APP_URL: z.url(),

    DB_HOST: z.string().min(1),
    DB_PORT: z.coerce.number().int().min(1).max(65535).default(3306),
    DB_USER: z.string().min(1),
    DB_PASSWORD: z.string().min(1),
    DB_NAME: z.string().min(1),
    DB_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(10).default(2),
    DB_TLS: z.enum(["pinned", "disabled"]),
    DB_TLS_CA_PEM_BASE64: z.string().optional(),

    CREDENTIAL_KEYS: z.string().min(1),
    CREDENTIAL_ACTIVE_KEY_ID: z.string().min(1),

    SESSION_IDLE_HOURS: z.coerce.number().positive().max(24 * 30).default(12),
    SESSION_ABSOLUTE_DAYS: z.coerce.number().positive().max(90).default(7),

    DEV_ALLOW_SELF_SIGNED_LOCAL_MAIL: z.stringbool().default(false),
  })
  .superRefine((e, ctx) => {
    if (e.DB_TLS === "disabled" && !isLocalHost(e.DB_HOST)) {
      ctx.addIssue({
        code: "custom",
        path: ["DB_TLS"],
        message: "DB_TLS=disabled is only allowed when DB_HOST is localhost",
      });
    }
    if (e.DB_TLS === "pinned" && !e.DB_TLS_CA_PEM_BASE64) {
      ctx.addIssue({
        code: "custom",
        path: ["DB_TLS_CA_PEM_BASE64"],
        message: "required when DB_TLS=pinned",
      });
    }
    if (e.NODE_ENV === "production") {
      if (e.DB_TLS !== "pinned") {
        ctx.addIssue({ code: "custom", path: ["DB_TLS"], message: "must be 'pinned' in production" });
      }
      if (!e.APP_URL.startsWith("https://")) {
        ctx.addIssue({ code: "custom", path: ["APP_URL"], message: "must be https:// in production" });
      }
    }
  });

export type ServerEnv = z.infer<typeof schema> & {
  /** True only outside production; self-signed certs are still limited to localhost hosts. */
  allowSelfSignedLocalMail: boolean;
};

let cached: ServerEnv | undefined;

export function env(): ServerEnv {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid server environment:\n${problems}`);
  }
  cached = {
    ...parsed.data,
    allowSelfSignedLocalMail:
      parsed.data.NODE_ENV !== "production" && parsed.data.DEV_ALLOW_SELF_SIGNED_LOCAL_MAIL,
  };
  return cached;
}

/** Test helper: forget the cached environment. */
export function resetEnvCacheForTests(): void {
  cached = undefined;
}
