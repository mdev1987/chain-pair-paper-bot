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

The bot filters by pool age, liquidity, 24h volume, and 24h transaction count. New pools are sorted newest-first; the age check is applied locally so the SDK stays on its documented network-scoped pool-search path. The evidence-backed band is pool age 60–120s (younger hasn't finished price discovery — those are retried later, not rejected) and liquidity $15k–$100k (the region with the strongest realized expectancy; above $100k behaves as a different regime).

### DexPaprika vs CoinGecko for discovery

Verdict: **DexPaprika stays; do not replace it with the CoinGecko TypeScript SDK** (`@coingecko/coingecko-typescript`, `client.simple.price.get()` style).

- DexPaprika is a purpose-built on-chain DEX API: `pools.listByNetwork(network, { orderBy: "created_at" })` returns the newest pools per chain, which is exactly this bot's discovery loop. Free key, credential-friendly polling budget, cache disabled for freshness.
- The CoinGecko SDK targets the curated CoinGecko coin API (IDs/symbols/markets). New memecoins only appear there after listing review — minutes to hours too late for a sub-2-minute new-pool watcher — and there is no per-chain `created_at` pool sort on that path. Its Demo plan is also capped around 100 calls/min shared across everything.
- CoinGecko's on-chain/new-pool coverage lives in the GeckoTerminal/Onchain API family, not in the TypeScript SDK discovery path above. That would be a separate adapter, not a drop-in replacement.
- The optional `COINGECKO_API` key in `.env` is therefore wired in `src/config.ts` for future enrichment only (established-token market context). Discovery and pricing stay DexPaprika + DexScreener.

### DexScreener

DexScreener is used only for market data and position pricing. A DEXPaprika pool ID is sent to DexScreener's `/latest/dex/pairs/{chainId}/{pairId}` endpoint. Active positions are grouped by chain and fetched in batches.

Discovery resolution is batched the same way: each chain's unseen pools are resolved with a single `getPairsByChain(chain, poolAddresses)` call per discovery cycle (internally chunked by `DEXSCREENER_PAIR_BATCH_SIZE`), so discovery costs ~1–2 requests per chain per cycle instead of one request per pool. Pools with no DexScreener match yet are simply retried next cycle.

A qualifying candidate is re-quoted once after `ENTRY_CONFIRM_DELAY_MS` before entry (`assessConfirmation` in `src/dexscreener.ts`, pure and unit-tested). Only deterioration rejects — a material price slide or liquidity collapse means the pool has already begun failing. Rising or flat re-quotes always pass; this is not a momentum gate, just a refusal to enter something visibly dying.

The client uses a sliding-window limiter below the 300 requests/minute API limit. Only active paper positions consume the high-frequency price budget.

## Default risk/position behavior

```text
Initial stop      -15%
Early stop        -10% within the first 3 minutes (dead-on-arrival exit)
Breakeven         arms at +20% (or after TP1 as fallback, buffer 0%)
TP1               +30%  → sell 25% of original quantity
TP2               +60%  → sell 25% of original quantity
TP3              +100%  → sell 25% of original quantity
Trailing start    +30%
Trailing distance  20%
Time exit          60 minutes
Entry impact guard skip pools where our $10 exit would move price > 5%
```

The remaining 25% after the three TP levels is intended to be managed by the trailing stop.

Effective stop order: trailing (once active) → breakeven (once armed) → early (fresh positions only) → initial stop. Breakeven arms at +20%, ahead of TP1/trailing at +30%, so protection ratchets up before the first partial. The early stop only binds when neither breakeven nor trailing has armed — the fast-collapse profile where the normal stop cannot execute in time.

## Paper portfolio

```text
INITIAL_BALANCE_USD=10000
POSITION_SIZE_USD=10
```

Cash starts at the initial balance. Entry reserves the position size; partial-TP and exit proceeds flow back to cash. Equity = cash + open-position market value. Each position stores balance-before at entry and balance-after at close; closes also record per-trade PnL plus portfolio, per-chain, and per-token stats for chain/token selection analysis. `CHAIN_POSITION_SIZES="solana:5"` overrides the size per chain (empty = uniform everywhere). Baseline weights Solana $5 — it produces the most opportunities but all of the catastrophic gaps — while keeping $10 elsewhere; Base is off the chain list (insufficient sample).

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

Every entry fill, TP partial, and final exit is appended to `fills`, and every closed position gets one summary row in `trades` (`src/analytics.ts`, `@duckdb/node-api`). Each trade row stores gross `pnl_usd` plus a shadow `net_pnl_usd` under cost model `NET_PNL_100BPS_1PCT` (100 bps fee + 1% slippage per side, research only — never applied to simulated cash, with the modeled components split out as `modeled_fee_usd` / `modeled_slip_usd`) and the full path (`mfe_pct`, `mae_pct`, `exit_pct`, `giveback_pp`, `time_to_mfe_s`, `time_to_mae_s`, `exit_trigger_pct`, `gap_through_stop`). The trigger/fill split separates *where the stop was* from *where the fill printed*: a fill materially worse than the trigger (beyond 1pp tolerance) flags a gap-through-stop, which makes stop-failure analysis a direct query. Open positions also emit a per-minute market snapshot (price, liquidity, txn mix) into `position_snapshots` — research input for studying pre-collapse deterioration in late gappers, never an exit signal. Older ledgers gain new columns automatically on open (`ADD COLUMN IF NOT EXISTS`). Contract addresses, pair, and pool IDs are stored **in full — no ellipsis truncation** (same for Telegram BUY/CLOSE messages). The ledger is best-effort: init/write failures are logged and trading continues; SIGTERM/SIGINT flushes a `CHECKPOINT` before exit.

Example analysis (any script with access to `src/analytics.ts`):

```ts
import { analyticsQuery } from "./src/analytics.ts";

// Win rate + gross vs modeled net per chain (net is the comparison metric)
console.log(await analyticsQuery(`
  SELECT chain, count(*) AS trades,
         count(*) FILTER (WHERE pnl_usd > 0) AS wins,
         round(sum(pnl_usd), 2) AS gross_usd,
         round(sum(modeled_fee_usd + modeled_slip_usd), 2) AS modeled_cost_usd,
         round(sum(net_pnl_usd), 2) AS net_usd
   FROM trades GROUP BY chain ORDER BY net_usd DESC`));

// Gap-through-stop audit: how often stops held vs gapped, and what gaps cost
console.log(await analyticsQuery(`
  SELECT reason, count(*) AS trades,
         count(*) FILTER (WHERE gap_through_stop) AS gaps,
         round(sum(pnl_usd) FILTER (WHERE gap_through_stop), 2) AS gap_pnl_usd
   FROM trades GROUP BY reason ORDER BY gaps DESC`));

// Best tokens by realized PnL
console.log(await analyticsQuery(`
  SELECT chain, symbol, ca, count(*) AS trades, round(sum(pnl_usd), 2) AS pnl_usd
  FROM trades GROUP BY chain, symbol, ca ORDER BY pnl_usd DESC LIMIT 20`));
```

## Execution layer (simulation stage)

`src/execution/` implements one `SwapExecutor` interface (quoteBuy/quoteSell/simulate/buy/sell) that the paper engine does **not** use yet — it keeps filling virtually at observed prices. The module is the Stage-1 foundation:

```text
src/execution/
├── types.ts        SwapExecutor, Quote, RiskPolicy, live-spend gate
├── risk.ts         pure RISK GATE (impact / tax / output / gas)
├── paper.ts        virtual executor (mark-price fills, for tests/dry runs)
├── evm/
│   ├── router.ts       aggregator-first routing, direct-DEX fallback
│   ├── zeroex.ts       0x Swap API quoter (primary EVM)
│   ├── uniswap.ts      direct on-chain V2 quoting (EVM fallback)
│   ├── pancakeswap.ts  stub (Stage 1: Smart Router)
│   ├── viem-client.ts  RPC/wallet clients (incl. Robinhood Chain 4663)
│   └── simulator.ts    eth_call simulation (Tenderly remains optional)
└── solana/
    └── jupiter.ts  Jupiter Swap V2 /order quoter (Meta-Aggregator)
```

Rules: quote/simulate are read-only and safe; network buy/sell throw unless `LIVE_TRADING_ENABLED=true` with a configured key. Fresh-pool reality is baked in — unquotable routes and Jupiter `transaction: ""` responses are normal routing signals handled by fallback, not errors. The Uniswap adapter deliberately avoids the hosted Trading API: since DexPaprika discovery already yields the exact pair contract, it reads `token0`/`getReserves` on-chain and applies constant-product math locally (viem + two minimal ABIs, no Uniswap SDK dependency yet — reach for `@uniswap/sdk-core` + v2/v3/v4 SDKs if multi-hop or concentrated-liquidity Quoter flows are ever needed).

Live simulation is already running: every paper BUY and final exit additionally fetches a real executable quote (Jupiter on Solana; 0x → direct-V2 on EVM) plus an eth_call simulation where calldata exists, and records the outcome in `quote_checks` — quoted amounts, risk verdict, sim result. The paper engine never reads that table; it is the fill-vs-mark dataset that decides whether the strategy transfers live. Entries spend known quote currencies (decimals mapped); EVM exits resolve token decimals on-chain; Solana exits are skipped until a token-decimals source is wired. Note the Jupiter cost detail this surfaced: `/order` charges **50 bps platform fee on new tokens** (<24h old, i.e. everything this bot trades), so live Solana cost is ≥50 bps/side before slippage — inside the `NET_PNL_100BPS_1PCT` shadow model, but barely.

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
- Close (📉 trailing / 🔴 stop / 🛑 early / 🛟 breakeven / ⏱ time): full pair + pool IDs, full token CA, entry → exit, high, TP hits, PnL $ + % plus the shadow net-model line, fees/slippage, entry → exit liquidity, age at entry, balance before → after, duration + timestamps, portfolio totals (trades, win rate, total PnL, equity), per-chain and per-token lines for analysis, DexScreener link.

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
