import "server-only";
import { db } from "../db";

/**
 * Fixed-window rate limiter stored in MariaDB (no Redis in v1).
 *
 * All time arithmetic happens in SQL with the database clock (NOW(3)), so
 * clock skew between Netlify function instances doesn't matter.
 */

export type RateLimit = {
  key: string;
  /** Allowed hits per window. */
  max: number;
  windowMs: number;
  /** How long to block once `max` is exceeded. */
  blockMs: number;
};

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterMs: number };

type BucketRow = { count: number | bigint; blockedMs: number | bigint | null };

export async function consume(limit: RateLimit): Promise<RateLimitResult> {
  const p = db();
  const windowUs = limit.windowMs * 1000;

  // MariaDB applies ON DUPLICATE KEY assignments left to right, so `count`
  // must be computed before `window_start` is moved.
  await p.$executeRaw`
    INSERT INTO rate_limit_buckets (\`key\`, count, window_start, blocked_until, updated_at)
    VALUES (${limit.key}, 1, NOW(3), NULL, NOW(3))
    ON DUPLICATE KEY UPDATE
      count = IF(window_start < NOW(3) - INTERVAL ${windowUs} MICROSECOND, 1, count + 1),
      window_start = IF(window_start < NOW(3) - INTERVAL ${windowUs} MICROSECOND, NOW(3), window_start),
      updated_at = NOW(3)`;

  const rows = await p.$queryRaw<BucketRow[]>`
    SELECT count,
           IF(blocked_until > NOW(3), TIMESTAMPDIFF(MICROSECOND, NOW(3), blocked_until) DIV 1000, NULL) AS blockedMs
    FROM rate_limit_buckets WHERE \`key\` = ${limit.key}`;
  const row = rows[0];
  if (!row) return { allowed: true };

  if (row.blockedMs !== null) {
    return { allowed: false, retryAfterMs: Math.max(1000, Number(row.blockedMs)) };
  }
  if (Number(row.count) > limit.max) {
    await p.$executeRaw`
      UPDATE rate_limit_buckets
      SET blocked_until = NOW(3) + INTERVAL ${limit.blockMs * 1000} MICROSECOND
      WHERE \`key\` = ${limit.key}`;
    return { allowed: false, retryAfterMs: limit.blockMs };
  }

  // Opportunistic cleanup of stale buckets (~1% of calls).
  if (Math.random() < 0.01) {
    await p.$executeRaw`DELETE FROM rate_limit_buckets WHERE updated_at < NOW(3) - INTERVAL 1 DAY`;
  }
  return { allowed: true };
}

export async function resetLimit(key: string): Promise<void> {
  await db().$executeRaw`DELETE FROM rate_limit_buckets WHERE \`key\` = ${key}`;
}

const MINUTE = 60_000;

/** Login limits: generous per IP (shared office networks), strict per address. */
export const loginLimits = {
  perIp: (ip: string): RateLimit => ({ key: `login:ip:${ip}`, max: 20, windowMs: 15 * MINUTE, blockMs: 15 * MINUTE }),
  perAccount: (emailHash: string): RateLimit => ({
    key: `login:email:${emailHash}`,
    max: 5,
    windowMs: 15 * MINUTE,
    blockMs: 15 * MINUTE,
  }),
};
