import { DexPaprikaClient } from "dexpaprika-sdk";
import { config } from "./config.ts";

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
      await new Promise((resolve) => setTimeout(resolve, Math.max(25, this.timestamps[0]! + 60_000 - now + 5)));
    }
  }
}

const limiter = new SlidingWindowRateLimiter(config.dexPaprika.maxRpm);

const client = new DexPaprikaClient(
  config.dexPaprika.baseUrl,
  {},
  {
    ...(config.dexPaprika.apiKey ? { apiKey: config.dexPaprika.apiKey } : {}),
    retry: {
      maxRetries: 3,
      delaySequenceMs: [250, 750, 1500],
      retryableStatuses: [408, 429, 500, 502, 503, 504],
    },
    // Discovery must stay fresh. The SDK cache defaults to minutes, which
    // is inappropriate for a new-pool watcher.
    cache: {
      enabled: false,
    },
  },
);

interface SearchPoolToken {
  id?: string;
  symbol?: string;
  name?: string;
}

interface SearchPoolRow {
  id: string;
  created_at: string;
  dex_id?: string;
  dex_name?: string;
  volume_usd_24h?: number;
  liquidity_usd?: number;
  transactions_24h?: number;
  tokens?: SearchPoolToken[];
}

interface SearchResponse {
  results: SearchPoolRow[];
  has_next_page?: boolean;
  next_cursor?: string;
}

export interface DiscoveredPool {
  chain: string;
  poolAddress: string;
  createdAtMs: number;
  dexId: string;
  dexName: string;
  volume24hUsd: number;
  liquidityUsd: number;
  txns24h: number;
  tokens: Array<{ id: string; symbol: string; name: string }>;
}

function asFiniteNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export async function fetchNewestPools(chain: string): Promise<DiscoveredPool[]> {
  await limiter.acquire();
  const response = await client.pools.listByNetwork(chain, {
    limit: config.dexPaprika.limit,
    sort: "desc",
    orderBy: "created_at",
  }) as unknown as SearchResponse;

  const cutoffMs = Date.now() - config.dexPaprika.maxAgeSec * 1000;

  return response.results
    .map((pool) => {
      const createdAtMs = Date.parse(String(pool.created_at));
      return {
        chain,
        poolAddress: String(pool.id),
        createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
        dexId: String(pool.dex_id ?? ""),
        dexName: String(pool.dex_name ?? pool.dex_id ?? ""),
        volume24hUsd: asFiniteNumber(pool.volume_usd_24h),
        liquidityUsd: asFiniteNumber(pool.liquidity_usd),
        txns24h: asFiniteNumber(pool.transactions_24h),
        tokens: (pool.tokens ?? []).map((token) => ({
          id: String(token.id ?? ""),
          symbol: String(token.symbol ?? ""),
          name: String(token.name ?? ""),
        })),
      } satisfies DiscoveredPool;
    })
    .filter((pool) => pool.createdAtMs >= cutoffMs)
    .filter((pool) => pool.liquidityUsd >= config.dexPaprika.minLiquidityUsd)
    .filter((pool) => pool.volume24hUsd >= config.dexPaprika.minVolume24hUsd)
    .filter((pool) => pool.txns24h >= config.dexPaprika.minTxns24h);
}

export function getClient(): DexPaprikaClient {
  return client;
}
