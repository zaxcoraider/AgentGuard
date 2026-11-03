/** Fixed-window counter per key (e.g. per visitor IP). In memory: resets on restart. */
export class RateLimiter {
  private hits = new Map<string, { start: number; count: number }>();
  constructor(private readonly max: number, private readonly windowMs: number) {}

  allow(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || now - h.start >= this.windowMs) {
      this.hits.set(key, { start: now, count: 1 });
      if (this.hits.size > 10_000) this.prune(now);
      return true;
    }
    if (h.count >= this.max) return false;
    h.count += 1;
    return true;
  }

  private prune(now: number) {
    for (const [k, h] of this.hits) if (now - h.start >= this.windowMs) this.hits.delete(k);
  }
}

/**
 * Who is this visitor, for rate limits. Never trusts X-Forwarded-For: Render's proxy appends
 * to it without clearing it, so a client can put any address first. Render runs behind
 * Cloudflare, which overwrites True-Client-IP / CF-Connecting-IP itself. Locally those
 * headers are absent and the socket address is used. Override with CLIENT_IP_HEADERS
 * ("" = socket address only, e.g. when nothing trusted sits in front).
 */
export function clientIp(
  headers: Record<string, string | string[] | undefined>,
  socketAddress: string | undefined,
  trusted: string[] = ["true-client-ip", "cf-connecting-ip"],
): string {
  for (const h of trusted) {
    const v = headers[h];
    const ip = (Array.isArray(v) ? v[0] : v)?.trim();
    if (ip && ip.length <= 64) return ip;
  }
  return socketAddress || "unknown";
}
