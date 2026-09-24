import { JupiterExecutor } from "./execution/solana/jupiter.ts";
import { fetchConfirmedFill } from "./execution/solana/fills.ts";
import { traderPublicKey } from "./execution/solana/signer.ts";
import { liveTradingEnabled } from "./execution/types.ts";
import {
  loadLiveOrders,
  markConfirmed,
  markFailed,
  markSubmitted,
  recordSignal,
  saveLiveOrders,
  type LiveOrder,
} from "./execution/live-orders.ts";
import {
  applyLiveFill,
  closeLivePosition,
  loadLivePositions,
  openLivePosition,
  saveLivePositions,
  sellFillStatus,
  type LivePosition,
} from "./execution/live-positions.ts";
import {
  buildLiveFillConfirmedMessage,
  buildLiveSubmittedMessage,
} from "./report.ts";
import { recordFill } from "./analytics.ts";
import type { LiveDeps } from "./live.ts";

/**
 * One-shot live round-trip test: $5 SOL → USDC → SOL through the
 * PRODUCTION buy()/sell() path (guard included). Explicitly env-gated
 * (LIVE_TEST_TRADE=true) and idempotent across restarts:
 *
 * - Fixed test id + fixed $5 size (not configurable — no fat fingers).
 * - Every stage persists to the journal before the next begins; a
 *   restart resumes from journal state via nextTestStep().
 * - Completion (BUY + SELL both CONFIRMED) short-circuits forever.
 * - Paper strategy untouched: no positions, no signals, no sizing.
 *
 * Prerequisites: LIVE_TRADING_ENABLED=true, funded throwaway wallets
 * (fresh pilot wallets — never the chat-exposed dev keys), Jupiter key.
 * Do NOT enable until the wallet holds only what you can lose.
 */

export const TEST_ID = "livetest:sol-usdc-roundtrip";
export const TEST_SIZE_USD = 5;
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qKVPkZRB3v3rv7THhYhr4GTAb";
const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;
const TEST_SLIPPAGE_BPS = 100; // 1%: deep pair, strict enough to mean something.

export type TestStep =
  | { kind: "done" }
  | { kind: "buy" }
  | { kind: "resume-buy"; signature: string }
  | { kind: "sell" }
  | { kind: "resume-sell"; signature: string };

/**
 * Pure resume planner: journal entries for TEST_ID → next action.
 * - BUY CONFIRMED + SELL CONFIRMED → done (never rerun).
 * - BUY SUBMITTED (sig) → resume-buy (resolve sig from chain).
 * - BUY CONFIRMED, no SELL → sell.
 * - SELL SUBMITTED (sig) → resume-sell.
 * - SELL CONFIRMED without BUY CONFIRMED → done (nothing to do; flagged).
 * - BUY SIGNAL (no sig) or nothing → buy from scratch.
 */
export function nextTestStep(orders: LiveOrder[]): TestStep {
  const mine = orders.filter((o) => o.positionId === TEST_ID);
  const buy = mine.find((o) => o.side === "BUY");
  const sell = mine.find((o) => o.side === "SELL");
  if (buy?.status === "CONFIRMED" && sell?.status === "CONFIRMED") return { kind: "done" };
  if (sell?.status === "SUBMITTED" && sell.signature) {
    return { kind: "resume-sell", signature: sell.signature };
  }
  if (sell?.status === "CONFIRMED") return { kind: "done" };
  if (buy?.status === "CONFIRMED") return { kind: "sell" };
  if (buy?.status === "SUBMITTED" && buy.signature) {
    return { kind: "resume-buy", signature: buy.signature };
  }
  return { kind: "buy" };
}

/** $5 → SOL lamports via CoinGecko (fail-closed on any pricing failure). */
export function lamportsForUsd(solPriceUsd: number, usd: number): string {
  if (!Number.isFinite(solPriceUsd) || solPriceUsd <= 0) {
    throw new Error(`Invalid SOL price: ${solPriceUsd}`);
  }
  const lamports = Math.floor((usd / solPriceUsd) * 10 ** SOL_DECIMALS);
  if (lamports <= 0) throw new Error("Test amount rounds to zero lamports");
  return String(lamports);
}

async function fetchSolPrice(deps: LiveDeps): Promise<number> {
  const key = process.env.COINGECKO_API ?? process.env.CG_API_KEY ?? "";
  const response = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
    {
      headers: key ? { "x-cg-demo-api-key": key } : {},
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) throw new Error(`CoinGecko HTTP ${response.status}`);
  const data = (await response.json()) as { solana?: { usd?: unknown } };
  const price = Number(data?.solana?.usd);
  if (!Number.isFinite(price) || price <= 0) throw new Error("CoinGecko returned no SOL price");
  return price;
}

const jupiter = new JupiterExecutor();

function baseOrder(side: "BUY" | "SELL") {
  return { positionId: TEST_ID, chain: "solana", side };
}

async function runBuyLeg(
  deps: LiveDeps,
  journal: LiveOrder[],
  mirror: LivePosition[],
): Promise<{ journal: LiveOrder[]; mirror: LivePosition[] }> {
  journal = recordSignal(journal, { ...baseOrder("BUY") });
  saveLiveOrders(journal);
  const trader = traderPublicKey();
  const solPrice = await fetchSolPrice(deps);
  const sellBase = lamportsForUsd(solPrice, TEST_SIZE_USD);
  deps.log(`🧪 live test: BUY $${TEST_SIZE_USD} SOL→USDC (${sellBase} lamports @ $${solPrice})`);
  const quote = await jupiter.quoteBuy({
    chain: "solana",
    sellToken: SOL_MINT,
    buyToken: USDC_MINT,
    sellAmountBaseUnits: sellBase,
    taker: trader,
    slippageBps: TEST_SLIPPAGE_BPS,
  });
  const res = await jupiter.buy({
    quote,
    taker: trader,
    slippageBps: TEST_SLIPPAGE_BPS,
    sizeUsd: TEST_SIZE_USD,
    positionId: TEST_ID,
  });
  if (!res.hash) throw new Error("live buy returned no signature");
  journal = markSubmitted(journal, TEST_ID, "BUY", res.hash);
  saveLiveOrders(journal);
  await deps.notify(buildLiveSubmittedMessage({
    symbol: "TEST/SOL→USDC", chain: "solana", side: "BUY", sizeUsd: TEST_SIZE_USD, signature: res.hash,
  }));
  const fill = await fetchConfirmedFill(res.hash);
  mirror = openLivePosition(mirror, {
    positionId: TEST_ID,
    chain: "solana",
    tokenMint: fill.buyMint,
    filledBaseUnits: fill.buyAmountBaseUnits,
    entryCostUsd: TEST_SIZE_USD,
  });
  saveLivePositions(mirror);
  journal = markConfirmed(journal, TEST_ID, "BUY");
  saveLiveOrders(journal);
  const qtyUsdc = Number(BigInt(fill.buyAmountBaseUnits)) / 10 ** USDC_DECIMALS;
  await recordFill({
    time: Date.now(), side: "BUY", positionId: TEST_ID, chain: "solana",
    dex: "jupiter", symbol: "TEST", tokenName: "live round-trip test",
    pair: `${SOL_MINT}/${USDC_MINT}`, pool: "", ca: USDC_MINT, quote: "USDC",
    price: TEST_SIZE_USD / qtyUsdc, qty: qtyUsdc, notionalUsd: TEST_SIZE_USD,
    feeUsd: 0, slipUsd: 0, detail: "LIVE_TEST_BUY", balanceAfterUsd: NaN,
    equityAfterUsd: NaN,
  });
  await deps.notify(buildLiveFillConfirmedMessage({
    symbol: "TEST/SOL→USDC", chain: "solana", kind: "ENTRY",
    price: TEST_SIZE_USD / qtyUsdc,
    sellAmount: fill.sellAmountBaseUnits, buyAmount: fill.buyAmountBaseUnits,
    signature: res.hash,
  }));
  return { journal, mirror };
}

async function runSellLeg(
  deps: LiveDeps,
  journal: LiveOrder[],
  mirror: LivePosition[],
): Promise<{ journal: LiveOrder[]; mirror: LivePosition[] }> {
  const live = mirror.find((p) => p.positionId === TEST_ID && p.status === "OPEN");
  if (!live) throw new Error("no open live test position (BUY leg incomplete)");
  const sellBase = live.remainingBaseUnits;
  journal = recordSignal(journal, { ...baseOrder("SELL") });
  saveLiveOrders(journal);
  const trader = traderPublicKey();
  deps.log(`🧪 live test: SELL ${sellBase} USDC→SOL`);
  const quote = await jupiter.quoteSell({
    chain: "solana",
    sellToken: USDC_MINT,
    buyToken: SOL_MINT,
    sellAmountBaseUnits: sellBase,
    taker: trader,
    slippageBps: TEST_SLIPPAGE_BPS,
  });
  const res = await jupiter.sell({ quote, taker: trader, slippageBps: TEST_SLIPPAGE_BPS });
  if (!res.hash) throw new Error("live sell returned no signature");
  journal = markSubmitted(journal, TEST_ID, "SELL", res.hash);
  saveLiveOrders(journal);
  await deps.notify(buildLiveSubmittedMessage({
    symbol: "TEST/USDC→SOL", chain: "solana", side: "SELL",
    sizeUsd: TEST_SIZE_USD, signature: res.hash,
  }));
  const fill = await fetchConfirmedFill(res.hash);
  mirror = applyLiveFill(mirror, TEST_ID, fill.sellAmountBaseUnits);
  saveLivePositions(mirror);
  mirror = closeLivePosition(mirror, TEST_ID);
  saveLivePositions(mirror);
  journal = markConfirmed(journal, TEST_ID, "SELL");
  saveLiveOrders(journal);
  const backSol = Number(BigInt(fill.buyAmountBaseUnits)) / 10 ** SOL_DECIMALS;
  await recordFill({
    time: Date.now(), side: "SELL", positionId: TEST_ID, chain: "solana",
    dex: "jupiter", symbol: "TEST", tokenName: "live round-trip test",
    pair: `${USDC_MINT}/${SOL_MINT}`, pool: "", ca: USDC_MINT, quote: "SOL",
    price: backSol <= 0 ? 0 : TEST_SIZE_USD / backSol, qty: backSol,
    notionalUsd: TEST_SIZE_USD, feeUsd: 0, slipUsd: 0,
    detail: "LIVE_TEST_SELL", balanceAfterUsd: NaN, equityAfterUsd: NaN,
  });
  await deps.notify(buildLiveFillConfirmedMessage({
    symbol: "TEST/USDC→SOL", chain: "solana", kind: "EXIT",
    price: null, sellAmount: fill.sellAmountBaseUnits, buyAmount: fill.buyAmountBaseUnits,
    signature: res.hash,
  }));
  return { journal, mirror };
}

/** Resume a SUBMITTED leg by resolving its signature from chain status. */
async function resumeLeg(
  deps: LiveDeps,
  journal: LiveOrder[],
  mirror: LivePosition[],
  side: "BUY" | "SELL",
  signature: string,
): Promise<{ journal: LiveOrder[]; mirror: LivePosition[] }> {
  deps.log(`🧪 live test: resuming ${side} ${signature}`);
  const fill = await fetchConfirmedFill(signature);
  if (side === "BUY") {
    // Crash window: mirror may already hold this fill (saved before the
    // CONFIRMED mark). Never double-open — proceed to the SELL leg.
    if (!mirror.some((p) => p.positionId === TEST_ID)) {
      mirror = openLivePosition(mirror, {
        positionId: TEST_ID,
        chain: "solana",
        tokenMint: fill.buyMint,
        filledBaseUnits: fill.buyAmountBaseUnits,
        entryCostUsd: TEST_SIZE_USD,
      });
      saveLivePositions(mirror);
    } else {
      deps.log("🧪 live test: mirror already holds BUY fill, continuing");
    }
    journal = markConfirmed(journal, TEST_ID, "BUY");
    saveLiveOrders(journal);
    return runSellLeg(deps, journal, mirror);
  }
  const live = mirror.find((p) => p.positionId === TEST_ID);
  if (!live || live.status !== "OPEN") {
    // Already applied in a previous attempt — verify on-chain, then close out.
    journal = markConfirmed(journal, TEST_ID, "SELL");
    saveLiveOrders(journal);
    deps.log("🧪 live test: SELL already applied previously, marked CONFIRMED");
    return { journal, mirror };
  }
  // Crash window: apply may already be saved without the CONFIRMED mark.
  switch (sellFillStatus(live, fill.sellAmountBaseUnits)) {
    case "applied":
      deps.log("🧪 live test: SELL fill already applied, skipping to close");
      break;
    case "fresh":
      mirror = applyLiveFill(mirror, TEST_ID, fill.sellAmountBaseUnits);
      saveLivePositions(mirror);
      break;
    case "conflict":
      throw new Error(
        `SELL fill state conflict for ${TEST_ID} (remaining ${live.remainingBaseUnits}, fill ${fill.sellAmountBaseUnits}) — manual review`,
      );
  }
  mirror = closeLivePosition(mirror, TEST_ID);
  saveLivePositions(mirror);
  journal = markConfirmed(journal, TEST_ID, "SELL");
  saveLiveOrders(journal);
  return { journal, mirror };
}

/**
 * Boot entrypoint. Runs only with LIVE_TEST_TRADE=true AND live trading
 * enabled; otherwise returns immediately. Never throws into boot — all
 * failures land in the journal + logs.
 */
export async function maybeLiveTestTrade(deps: LiveDeps): Promise<void> {
  if (process.env.LIVE_TEST_TRADE !== "true") return;
  if (!liveTradingEnabled()) {
    deps.log("🧪 LIVE_TEST_TRADE set but LIVE_TRADING_ENABLED is off — skipping");
    return;
  }
  try {
    let journal = loadLiveOrders();
    const mirror = loadLivePositions();
    const step = nextTestStep(journal);
    if (step.kind === "done") {
      deps.log("🧪 live test already completed (BUY+SELL CONFIRMED) — skipping");
      return;
    }
    deps.log(`🧪 live test starting at step: ${step.kind}`);
    if (step.kind === "buy") {
      const afterBuy = await runBuyLeg(deps, journal, mirror);
      await runSellLeg(deps, afterBuy.journal, afterBuy.mirror);
    } else if (step.kind === "sell") {
      await runSellLeg(deps, journal, mirror);
    } else if (step.kind === "resume-buy") {
      await resumeLeg(deps, journal, mirror, "BUY", step.signature);
    } else {
      await resumeLeg(deps, journal, mirror, "SELL", step.signature);
    }
    deps.log("🧪 live test round-trip complete — compare wallet vs ledger");
  } catch (error) {
    deps.log(`🧪 live test FAILED (funds may need manual review): ${String(error).slice(0, 300)}`);
  }
}
