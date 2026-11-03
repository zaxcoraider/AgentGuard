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
