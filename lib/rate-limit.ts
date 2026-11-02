import "server-only";

import { env } from "cloudflare:workers";

type Bucket = { count: number; reset_at: number };

export async function isRateLimited(request: Request, scope: string, limit: number, windowMs: number) {
  const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const key = `${scope}:${ip}`;
  const now = Date.now();
  const resetAt = now + windowMs;
  const bucket = await env.DB.prepare(
    `INSERT INTO rate_limit_buckets (scope_key, count, reset_at) VALUES (?, 1, ?)
     ON CONFLICT(scope_key) DO UPDATE SET
       count = CASE WHEN reset_at <= ? THEN 1 ELSE count + 1 END,
       reset_at = CASE WHEN reset_at <= ? THEN ? ELSE reset_at END
     RETURNING count, reset_at`,
  ).bind(key, resetAt, now, now, resetAt).first<Bucket>();
  if (crypto.getRandomValues(new Uint8Array(1))[0] === 0) {
    await env.DB.prepare("DELETE FROM rate_limit_buckets WHERE reset_at <= ?").bind(now).run();
  }
  return Number(bucket?.count ?? limit + 1) > limit;
}
