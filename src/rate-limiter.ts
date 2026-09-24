/**
 * Sliding-window rate limiter shared by the DexPaprika and DexScreener
 * clients. Allows at most `maxPerMinute` acquisitions per rolling 60s
 * window; excess callers sleep until the oldest timestamp ages out.
 */
export class SlidingWindowRateLimiter {
  private readonly timestamps: number[] = [];

  constructor(private readonly maxPerMinute: number) {}

  async acquire(): Promise<void> {
    while (true) {
      const now = Date.now();
      const cutoff = now - 60_000;
      while (this.timestamps.length > 0 && this.timestamps[0]! <= cutoff) {
        this.timestamps.shift();
      }
      if (this.timestamps.length < this.maxPerMinute) {
        this.timestamps.push(now);
        return;
      }
      const oldest = this.timestamps[0]!;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(25, oldest + 60_000 - now + 5)),
      );
    }
  }
}
