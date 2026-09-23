import { config } from "./config.ts";
import type { Position } from "./types.ts";

/**
 * Shadow cost model for research (reported as NET_PNL_100BPS_1PCT).
 * Convention, kept explicit so ledger rows are never ambiguous:
 * modeled fee = 100 bps per side, modeled slippage = 1% per side,
 * both applied to fill notional. Accrued on every fill into
 * shadowFeeUsd/shadowSlipUsd and reported as net PnL in the ledger,
 * but NEVER applied to the simulated cash balance.
 */
export const SHADOW_FEE_BPS = 100;
export const SHADOW_SLIPPAGE_BPS = 100;
export const SHADOW_COST_MODEL = "NET_PNL_100BPS_1PCT";

export type PositionEvent =
  | { type: "TP"; level: 1 | 2 | 3; gainPct: number; sellPct: number; price: number; soldQty: number; proceedsUsd: number; realizedPnlUsd: number }
  | { type: "TRAIL_ACTIVATED"; price: number; trailStop: number }
  | { type: "STOP_MOVED"; mode: "BREAKEVEN"; price: number; stopPrice: number }
  | { type: "TRAIL_EXIT"; price: number; soldQty: number; proceedsUsd: number; realizedPnlUsd: number; gainPct: number }
  | { type: "STOP_EXIT"; price: number; soldQty: number; proceedsUsd: number; realizedPnlUsd: number; gainPct: number }
  | { type: "EARLY_EXIT"; price: number; soldQty: number; proceedsUsd: number; realizedPnlUsd: number; gainPct: number }
  | { type: "BREAKEVEN_EXIT"; price: number; soldQty: number; proceedsUsd: number; realizedPnlUsd: number; gainPct: number }
  | { type: "TIME_EXIT"; price: number; soldQty: number; proceedsUsd: number; realizedPnlUsd: number; gainPct: number };

function gainPct(position: Position, marketPrice: number): number {
  return ((marketPrice / position.entryPrice) - 1) * 100;
}

function closeExecutionPrice(marketPrice: number): number {
  return marketPrice * (1 - config.entry.slippageBps / 10_000);
}

function entryExecutionPrice(marketPrice: number): number {
  return marketPrice * (1 + config.entry.slippageBps / 10_000);
}

function exitFee(price: number, quantity: number): number {
  return price * quantity * (config.entry.feeExitBps / 10_000);
}

export function initialStopPrice(position: Position): number {
  return position.entryPrice * (1 - config.stops.initialPct / 100);
}

/** Dead-on-arrival stop for fresh positions (tighter than the initial stop). */
export function earlyStopPrice(position: Position): number {
  return position.entryPrice * (1 - config.earlyStop.stopPct / 100);
}

export function breakevenStopPrice(position: Position): number {
  return position.entryPrice * (1 + config.dynamic.breakevenBufferPct / 100);
}

export function trailingStopPrice(position: Position): number {
  return position.highestPrice * (1 - config.stops.trailDistancePct / 100);
}

/** Dynamic protective stop: trailing > breakeven (once armed) > initial.
 * The early stop is a separate time-windowed leg, not a standing price. */
export function effectiveStopPrice(position: Position): number {
  if (position.trailingActive) return trailingStopPrice(position);
  if (position.breakevenArmed) return breakevenStopPrice(position);
  return initialStopPrice(position);
}

function sellQuantity(
  position: Position,
  quantity: number,
  marketPrice: number,
): { qty: number; proceedsUsd: number } {
  const actualQty = Math.min(position.quantity, Math.max(0, quantity));
  if (actualQty <= 0) return { qty: 0, proceedsUsd: 0 };

  const fill = closeExecutionPrice(marketPrice);
  const grossPnl = actualQty * (fill - position.entryPrice);
  const fee = exitFee(fill, actualQty);

  position.realizedPnlUsd += grossPnl - fee;
  position.totalExitFeeUsd += fee;
  position.totalSlippageUsd += actualQty * Math.abs(fill - marketPrice);
  // Shadow accrual on executed/quoted notional (research only, not cash).
  position.shadowFeeUsd += actualQty * fill * (SHADOW_FEE_BPS / 10_000);
  position.shadowSlipUsd += actualQty * marketPrice * (SHADOW_SLIPPAGE_BPS / 10_000);
  position.quantity -= actualQty;
  return { qty: actualQty, proceedsUsd: actualQty * fill - fee };
}

function closePosition(position: Position, marketPrice: number, reason: Position["closedReason"], now: number): { soldQty: number; proceedsUsd: number } {
  const { qty, proceedsUsd } = sellQuantity(position, position.quantity, marketPrice);
  position.status = "CLOSED";
  position.closedReason = reason;
  position.closedAt = now;
  return { soldQty: qty, proceedsUsd };
}

export function openPosition(args: {
  id: string;
  chain: string;
  pairAddress: string;
  tokenAddress: string;
  symbol: string;
  tokenName: string;
  quoteSymbol: string;
  dexId: string;
  pairUrl?: string;
  marketPrice: number;
  usdSize: number;
  balanceBeforeUsd?: number;
  poolAddress?: string;
  entryLiquidityUsd?: number;
  entryAgeSec?: number;
  now?: number;
}): Position {
  if (!Number.isFinite(args.marketPrice) || args.marketPrice <= 0) {
    throw new Error("Cannot open a position at a non-positive price");
  }
  if (args.usdSize <= 0) {
    throw new Error("Position size must be positive");
  }

  const now = args.now ?? Date.now();
  const fillPrice = entryExecutionPrice(args.marketPrice);
  const entryFee = args.usdSize * (config.entry.feeEntryBps / 10_000);
  const quantity = Math.max(0, (args.usdSize - entryFee) / fillPrice);

  if (quantity <= 0) throw new Error("Position quantity became zero after entry friction");

  return {
    id: args.id,
    chain: args.chain,
    pairAddress: args.pairAddress,
    tokenAddress: args.tokenAddress,
    symbol: args.symbol,
    tokenName: args.tokenName,
    quoteSymbol: args.quoteSymbol,
    dexId: args.dexId,
    pairUrl: args.pairUrl,

    entryPrice: fillPrice,
    currentPrice: args.marketPrice,
    highestPrice: args.marketPrice,
    lowestPrice: args.marketPrice,
    highestAt: now,
    lowestAt: now,
    quantity,
    originalQuantity: quantity,
    initialUsdSize: args.usdSize,

    realizedPnlUsd: -entryFee,
    totalEntryFeeUsd: entryFee,
    totalExitFeeUsd: 0,
    totalSlippageUsd: quantity * Math.abs(fillPrice - args.marketPrice),
    // Shadow entry cost modeled on the full notional (research only).
    shadowFeeUsd: args.usdSize * (SHADOW_FEE_BPS / 10_000),
    shadowSlipUsd: args.usdSize * (SHADOW_SLIPPAGE_BPS / 10_000),

    openedAt: now,
    updatedAt: now,

    trailingActive: false,
    breakevenArmed: false,
    status: "OPEN",
    tpHit: [false, false, false],
    ...(args.balanceBeforeUsd !== undefined ? { balanceBeforeUsd: args.balanceBeforeUsd } : {}),
    ...(args.poolAddress !== undefined ? { poolAddress: args.poolAddress } : {}),
    ...(args.entryLiquidityUsd !== undefined ? { entryLiquidityUsd: args.entryLiquidityUsd } : {}),
    ...(args.entryAgeSec !== undefined ? { entryAgeSec: args.entryAgeSec } : {}),
  };
}

export function updatePosition(
  position: Position,
  marketPrice: number,
  now = Date.now(),
): PositionEvent[] {
  if (position.status !== "OPEN") return [];
  if (!Number.isFinite(marketPrice) || marketPrice <= 0) return [];

  position.currentPrice = marketPrice;
  position.updatedAt = now;
  // Full path tracking for MFE/MAE/giveback research (see tradeRecordFromPosition).
  if (marketPrice > position.highestPrice) {
    position.highestPrice = marketPrice;
    position.highestAt = now;
  }
  if (marketPrice < position.lowestPrice) {
    position.lowestPrice = marketPrice;
    position.lowestAt = now;
  }

  const events: PositionEvent[] = [];
  const gain = gainPct(position, marketPrice);
  // Epsilon for threshold crossings: binary floats rarely land exactly on a
  // boundary (e.g. 1.2x reads as +19.999999999996%), so compare tolerantly
  // rather than letting the boundary be decided by rounding luck.
  const EPS = 1e-9;

  for (let i = 0; i < config.tp.length; i++) {
    const level = config.tp[i]!;
    if (position.tpHit[i]) continue;
    // Order-independent: a level below the current gain must not block
    // later levels when TP gains are misordered. Startup config validation
    // requires strictly ascending gains; this loop stays correct regardless.
    if (gain + EPS < level.gainPct) continue;

    const { qty: sold, proceedsUsd } = sellQuantity(
      position,
      position.originalQuantity * (level.sellPct / 100),
      marketPrice,
    );
    position.tpHit[i] = true;

    if (sold > 0) {
      events.push({
        type: "TP",
        level: (i + 1) as 1 | 2 | 3,
        gainPct: gain,
        sellPct: level.sellPct,
        price: marketPrice,
        soldQty: sold,
        proceedsUsd,
        realizedPnlUsd: position.realizedPnlUsd,
      });
    }
  }

  // Dynamic SL leg 1: ratchet protection to breakeven (+ buffer) once the
  // position shows strength — at BREAKEVEN_ARM_PCT gain, or after TP1 as a
  // fallback — until the trailing stop takes over.
  if (
    !position.breakevenArmed &&
    (gain + EPS >= config.dynamic.breakevenArmPct ||
      (config.dynamic.breakevenAfterTp1 && position.tpHit[0] === true))
  ) {
    position.breakevenArmed = true;
    events.push({
      type: "STOP_MOVED",
      mode: "BREAKEVEN",
      price: marketPrice,
      stopPrice: breakevenStopPrice(position),
    });
  }

  if (!position.trailingActive && gain + EPS >= config.stops.trailActivationPct) {
    position.trailingActive = true;
    events.push({ type: "TRAIL_ACTIVATED", price: marketPrice, trailStop: trailingStopPrice(position) });
  }

  const trailingStop = trailingStopPrice(position);
  const breakevenStop = breakevenStopPrice(position);
  const initialStop = initialStopPrice(position);
  const earlyStop = earlyStopPrice(position);
  const withinEarlyWindow = now - position.openedAt < config.earlyStop.windowSec * 1000;

  if (position.trailingActive && marketPrice <= trailingStop) {
    const { soldQty, proceedsUsd } = closePosition(position, marketPrice, "TRAIL_EXIT", now);
    events.push({ type: "TRAIL_EXIT", price: marketPrice, soldQty, proceedsUsd, realizedPnlUsd: position.realizedPnlUsd, gainPct: gain });
  } else if (
    !position.trailingActive &&
    position.breakevenArmed &&
    marketPrice <= breakevenStop
  ) {
    const { soldQty, proceedsUsd } = closePosition(position, marketPrice, "BREAKEVEN_STOP", now);
    events.push({ type: "BREAKEVEN_EXIT", price: marketPrice, soldQty, proceedsUsd, realizedPnlUsd: position.realizedPnlUsd, gainPct: gain });
  } else if (
    config.earlyStop.enabled &&
    !position.trailingActive &&
    !position.breakevenArmed &&
    withinEarlyWindow &&
    marketPrice <= earlyStop
  ) {
    const { soldQty, proceedsUsd } = closePosition(position, marketPrice, "EARLY_STOP", now);
    events.push({ type: "EARLY_EXIT", price: marketPrice, soldQty, proceedsUsd, realizedPnlUsd: position.realizedPnlUsd, gainPct: gain });
  } else if (!position.trailingActive && !position.breakevenArmed && marketPrice <= initialStop) {
    const { soldQty, proceedsUsd } = closePosition(position, marketPrice, "STOP_EXIT", now);
    events.push({ type: "STOP_EXIT", price: marketPrice, soldQty, proceedsUsd, realizedPnlUsd: position.realizedPnlUsd, gainPct: gain });
  } else if (now - position.openedAt >= config.entry.maxPositionAgeMin * 60_000) {
    const { soldQty, proceedsUsd } = closePosition(position, marketPrice, "TIME_EXIT", now);
    events.push({ type: "TIME_EXIT", price: marketPrice, soldQty, proceedsUsd, realizedPnlUsd: position.realizedPnlUsd, gainPct: gain });
  }

  return events;
}

export function unrealizedPnlUsd(position: Position): number {
  return position.quantity * (position.currentPrice - position.entryPrice);
}

export function totalPnlUsd(position: Position): number {
  return position.realizedPnlUsd + unrealizedPnlUsd(position);
}

export function totalPnlPct(position: Position): number {
  return (totalPnlUsd(position) / position.initialUsdSize) * 100;
}

export function markedPriceGainPct(position: Position): number {
  return gainPct(position, position.currentPrice);
}

export function remainingPct(position: Position): number {
  return position.originalQuantity <= 0
    ? 0
    : (position.quantity / position.originalQuantity) * 100;
}
