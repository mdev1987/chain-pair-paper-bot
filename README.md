# Chain Pair Paper Bot — Node.js v0.4.0

A Node.js/TypeScript paper/emulation trading bot with a strict two-feed architecture:

```text
DEXPaprika SDK
    ↓
new pool discovery
    ↓
cheap candidate filters
    ↓
DexScreener pair resolution
    ↓
DexScreener price tracking
    ↓
dynamic TP + breakeven SL + trailing SL + hard SL + time exit
    ↓
paper portfolio ($10k / $10) → Telegram + DuckDB trade ledger
                                    ↓
                        state.json (positions recovery)
```

## Responsibilities

### DEXPaprika

DEXPaprika is used only for discovering new pools. The bot calls the official `dexpaprika-sdk` and uses `client.pools.listByNetwork(chain, { limit, sort: "desc", orderBy: "created_at" })`. The SDK client has caching disabled for this watcher so a new-pool search is not served from the SDK's normal multi-minute cache.

The bot filters by pool age, liquidity, 24h volume, and 24h transaction count. New pools are sorted newest-first; the age check is applied locally so the SDK stays on its documented network-scoped pool-search path.

### DexPaprika vs CoinGecko for discovery

Verdict: **DexPaprika stays; do not replace it with the CoinGecko TypeScript SDK** (`@coingecko/coingecko-typescript`, `client.simple.price.get()` style).

- DexPaprika is a purpose-built on-chain DEX API: `pools.listByNetwork(network, { orderBy: "created_at" })` returns the newest pools per chain, which is exactly this bot's discovery loop. Free key, credential-friendly polling budget, cache disabled for freshness.
- The CoinGecko SDK targets the curated CoinGecko coin API (IDs/symbols/markets). New memecoins only appear there after listing review — minutes to hours too late for a sub-2-minute new-pool watcher — and there is no per-chain `created_at` pool sort on that path. Its Demo plan is also capped around 100 calls/min shared across everything.
- CoinGecko's on-chain/new-pool coverage lives in the GeckoTerminal/Onchain API family, not in the TypeScript SDK discovery path above. That would be a separate adapter, not a drop-in replacement.
- The optional `COINGECKO_API` key in `.env` is therefore wired in `src/config.ts` for future enrichment only (established-token market context). Discovery and pricing stay DexPaprika + DexScreener.

### DexScreener

DexScreener is used only for market data and position pricing. A DEXPaprika pool ID is sent to DexScreener's `/latest/dex/pairs/{chainId}/{pairId}` endpoint. Active positions are grouped by chain and fetched in batches.

Discovery resolution is batched the same way: each chain's unseen pools are resolved with a single `getPairsByChain(chain, poolAddresses)` call per discovery cycle (internally chunked by `DEXSCREENER_PAIR_BATCH_SIZE`), so discovery costs ~1–2 requests per chain per cycle instead of one request per pool. Pools with no DexScreener match yet are simply retried next cycle.

The client uses a sliding-window limiter below the 300 requests/minute API limit. Only active paper positions consume the high-frequency price budget.

## Default risk/position behavior

```text
Initial stop      -15%
TP1               +30%  → sell 25% of original quantity
TP2               +60%  → sell 25% of original quantity
TP3              +100%  → sell 25% of original quantity
Breakeven         arms after TP1 (BREAKEVEN_AFTER_TP1=true, buffer 0%)
Trailing start    +30%
Trailing distance  20%
Time exit          40 minutes
```

The remaining 25% after the three TP levels is intended to be managed by the trailing stop.

Effective stop order: trailing (once active) → breakeven (once TP1 banked) → initial stop. The breakeven leg protects the TP1-to-trail gap whenever `TP1_PCT < TRAIL_ACTIVATION_PCT`; with the defaults (30/30) both arm together and the trailing stop dominates.

## Paper portfolio

```text
INITIAL_BALANCE_USD=10000
POSITION_SIZE_USD=10
```

Cash starts at the initial balance. Entry reserves the position size; partial-TP and exit proceeds flow back to cash. Equity = cash + open-position market value. Each position stores balance-before at entry and balance-after at close; closes also record per-trade PnL plus portfolio, per-chain, and per-token stats for chain/token selection analysis.

A pair is only ever entered once (`ONE_ENTRY_PER_POOL=true`): closed-trade history, restored from `STATE_FILE`, guards re-entry after restarts.

Close ordering is crash-safe: proceeds → close record → removal from the open map → `persist()` → analytics → Telegram. Reporting is best-effort and can never strand a position or leave `state.json` disagreeing with the portfolio.

## Positions recovery

```text
RECOVERY_ENABLED=true
STATE_FILE=data/state.json
```

Open positions, cash, and closed-trade history persist to `STATE_FILE` (`src/store.ts`, atomic tmp-file + rename) and are restored on boot, so `oxmgr reload` / daemon restarts never orphan paper positions. Saves are immediate on opens, fills, and closes, plus throttled (15s) on idle ticks so trailing-high progress survives too. A position whose max hold elapsed while the bot was down exits via time-exit on the first fresh price. Missing or corrupt state files boot fresh — recovery can never wedge startup. Disable with `RECOVERY_ENABLED=false`.

## DuckDB trade ledger

```text
ANALYTICS_ENABLED=true
DUCKDB_PATH=data/paper.duckdb
```

Every entry fill, TP partial, and final exit is appended to `fills`, and every closed position gets one summary row in `trades` (`src/analytics.ts`, `@duckdb/node-api`). Contract addresses, pair, and pool IDs are stored **in full — no ellipsis truncation** (same for Telegram BUY/CLOSE messages). The ledger is best-effort: init/write failures are logged and trading continues; SIGTERM/SIGINT flushes a `CHECKPOINT` before exit.

Example analysis (any script with access to `src/analytics.ts`):

```ts
import { analyticsQuery } from "./src/analytics.ts";

// Win rate + PnL per chain
console.log(await analyticsQuery(`
  SELECT chain, count(*) AS trades,
         count(*) FILTER (WHERE pnl_usd > 0) AS wins,
         round(sum(pnl_usd), 2) AS pnl_usd
  FROM trades GROUP BY chain ORDER BY pnl_usd DESC`));

// Best tokens by realized PnL
console.log(await analyticsQuery(`
  SELECT chain, symbol, ca, count(*) AS trades, round(sum(pnl_usd), 2) AS pnl_usd
  FROM trades GROUP BY chain, symbol, ca ORDER BY pnl_usd DESC LIMIT 20`));
```

## Paper friction

The paper engine supports:

```text
PAPER_ENTRY_FEE_BPS
PAPER_EXIT_FEE_BPS
PAPER_SLIPPAGE_BPS
```

Defaults are zero because fee/slippage assumptions differ significantly by chain and DEX. Set them to your measured assumptions before using paper PnL as a research result.

## First run

Requires [Bun](https://bun.sh):

```bash
bun install
cp .env.example .env
bun run check
bun test
bun start
```

Recommended first configuration:

```dotenv
MODE=paper
AUTO_ENTRY=false
TELEGRAM_ENABLED=false
```

This lets you verify DEXPaprika discovery and DexScreener pair resolution without creating paper positions.

Then enable:

```dotenv
AUTO_ENTRY=true
```

and set Telegram credentials when you are ready for continuous paper reporting.

## Telegram

The project uses:

```ts
import { Bot } from "grammy";
import { convert } from "telegram-markdown-v2";
```

Messages are authored in ordinary Markdown and converted before being sent with Telegram `parse_mode=MarkdownV2`. Report builders live in `src/report.ts` (pure functions, unit-tested in `tests/report.test.ts`); cash/equity accounting lives in `src/portfolio.ts`.

- 🟢 BUY: token, chain + icon, DEX, full pair + pool IDs, full token CA, quote, entry, size, entry liquidity + pool age at entry, SL/TP/trail config, balance-before → cash-after, open slots.
- Close (📉 trailing / 🔴 stop / 🛟 breakeven / ⏱ time): full pair + pool IDs, full token CA, entry → exit, high, TP hits, PnL $ + %, fees/slippage, entry → exit liquidity, age at entry, balance before → after, duration + timestamps, portfolio totals (trades, win rate, total PnL, equity), per-chain and per-token lines for analysis, DexScreener link.

Verbosity is intentionally minimal: only BUY + CLOSE are sent (`TELEGRAM_ANNOUNCE_CANDIDATES=false`, `TELEGRAM_TRADE_UPDATES=false`). Candidate "NEW PAIR" pings and interim 💰 TP / 🛟 breakeven / 📈 trailing messages stay in the daemon logs; set the flags to `true` to receive them on Telegram too.

## Packaging a source archive

Never ship runtime state inside a source ZIP. `data/state.json` (open positions, cash) and `data/paper.duckdb*` (trade ledger) are live bot files — anyone extracting an archive that contains them and running with `RECOVERY_ENABLED=true` would recover *your* positions instead of starting from a clean `$10,000` paper account. `.gitignore` already excludes them from git; apply the same exclusions when zipping:

```bash
zip -r chain-pair-paper-bot.zip . \
  -x 'node_modules/*' 'data/*.json' 'data/*.duckdb*' '.env' '*.log'
```

The archive should contain source, tests, docs, `package.json`, and `bun.lock` — nothing generated at runtime.

## Important limitations

This project is paper-only. It does not execute swaps, perform contract-level rug analysis, or guarantee that a discovered token is tradable.

DexPaprika discovery is a polling loop over the newest pools rather than a chain-level transaction subscription. DexScreener is the price source for the active-position loop by design.

Before using live execution, replace the paper-entry/exit layer with a chain-specific execution adapter and keep the position/risk engine separate.
