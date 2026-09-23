import { config } from "./config.ts";
import type { DexScreenerPair } from "./types.ts";

interface PairResponse {
  pairs?: DexScreenerPair[] | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SlidingWindowRateLimiter {
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
      await sleep(Math.max(25, oldest + 60_000 - now + 5));
    }
  }
}

const limiter = new SlidingWindowRateLimiter(config.dexScreener.maxRpm);

async function getJson<T>(url: URL): Promise<T> {
  await limiter.acquire();
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (response.status === 429) throw new Error("DexScreener HTTP 429 rate limit");
  if (!response.ok) throw new Error(`DexScreener HTTP ${response.status}`);
  return await response.json() as T;
}

export async function getPair(chain: string, pairAddress: string): Promise<DexScreenerPair | null> {
  const url = new URL(
    `${config.dexScreener.baseUrl}/latest/dex/pairs/${encodeURIComponent(chain)}/${encodeURIComponent(pairAddress)}`,
  );
  const data = await getJson<PairResponse>(url);
  return data.pairs?.[0] ?? null;
}

/**
 * Fetch many pair prices while keeping the documented endpoint request rate bounded.
 * The endpoint accepts one or multiple pair addresses for a chain.
 */
export async function getPairsByChain(
  chain: string,
  pairAddresses: string[],
): Promise<DexScreenerPair[]> {
  const unique = [...new Set(pairAddresses)].filter(Boolean);
  if (unique.length === 0) return [];

  const out: DexScreenerPair[] = [];
  for (let offset = 0; offset < unique.length; offset += config.dexScreener.batchSize) {
    const batch = unique.slice(offset, offset + config.dexScreener.batchSize);
    const path = batch.map((pair) => encodeURIComponent(pair)).join(",");
    const url = new URL(
      `${config.dexScreener.baseUrl}/latest/dex/pairs/${encodeURIComponent(chain)}/${path}`,
    );
    const data = await getJson<PairResponse>(url);
    out.push(...(data.pairs ?? []));
  }
  return out;
}

export function parsePrice(pair: DexScreenerPair): number | null {
  const price = Number(pair.priceUsd);
  return Number.isFinite(price) && price > 0 ? price : null;
}

export function pairLiquidityUsd(pair: DexScreenerPair): number {
  const value = Number(pair.liquidity?.usd ?? 0);
  return Number.isFinite(value) ? value : 0;
}
