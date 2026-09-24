import type { ClosedTrade } from "./portfolio.ts";

/**
 * Portfolio-level entry gates (pure, unit-tested). All read-only over the
 * closed-trade history — pausing and timers live in main.ts.
 */

/** Close reasons that count as stops for the breaker (incl. drained exits). */
export const BREAKER_STOP_REASONS: ReadonlySet<string> = new Set([
  "STOP_EXIT",
  "EARLY_STOP",
  "DRAIN_EXIT",
]);

/** Stops/drains on this chain within the trailing window. */
export function recentStopCount(
  closed: readonly ClosedTrade[],
  chain: string,
  now: number,
  windowMin: number,
): number {
  const cutoff = now - windowMin * 60_000;
  let count = 0;
  for (const t of closed) {
    if (t.chain === chain && t.closedAt >= cutoff && BREAKER_STOP_REASONS.has(t.reason)) {
      count += 1;
    }
  }
  return count;
}

/**
 * True when the last `lookback` closed trades on the chain net below zero.
 * Needs at least 5 trades — no data, no gate.
 */
export function rollingExpectancyNegative(
  closed: readonly ClosedTrade[],
  chain: string,
  lookback: number,
): boolean {
  const mine = closed.filter((t) => t.chain === chain);
  if (mine.length < Math.min(5, lookback)) return false;
  const window = mine.slice(-lookback);
  return window.reduce((sum, t) => sum + t.pnlUsd, 0) < 0;
}

function dayStartUtcMs(now: number): number {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

/** Today's closed PnL (UTC day). */
export function closedPnlToday(closed: readonly ClosedTrade[], now: number): number {
  const start = dayStartUtcMs(now);
  let sum = 0;
  for (const t of closed) {
    if (t.closedAt >= start) sum += t.pnlUsd;
  }
  return sum;
}

/** True when today's closed PnL breaches the limit. Non-positive limit disables. */
export function paperLossLimitBreached(
  closed: readonly ClosedTrade[],
  limitUsd: number,
  now: number,
): boolean {
  if (!(limitUsd > 0)) return false;
  return closedPnlToday(closed, now) <= -limitUsd;
}
