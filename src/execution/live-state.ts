/**
 * Process-wide live-trading state for the safety invariant.
 *
 * Phase 1.5 — durability: daily loss, loss-day, and the manual halt flag
 * persist to data/live-state.json (atomic writes). A UTC-day rollover on
 * load resets the loss accumulator; a manual halt stays sticky until
 * resume() is called. The invariant therefore survives restarts: entries
 * stay halted across a crash when loss already breached the limit.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

let dailyLossUsd = 0;
let halted = false;
let liveOpenCount = 0;
/**
 * Net realized live PnL for the UTC day (gains offset losses) and the live
 * open cost basis. The halt binds the tail two ways: realized net past the
 * limit, or realized net minus open exposure past the limit (stuck bags
 * assumed worthless — the simultaneous-total-loss bound).
 */
let dailyNetPnlUsd = 0;
let liveOpenExposureUsd = 0;
let lossDay = todayUtc();
const pendingOrders = new Set<string>();

/** Max acceptable realized live loss per UTC day before halting entries. */
export function dailyLossLimitUsd(): number {
  const raw = process.env.DAILY_LOSS_LIMIT_USD ?? "";
  if (raw === "") return 25;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid DAILY_LOSS_LIMIT_USD=${raw}`);
  }
  return value;
}

export const liveState = {
  /** Gross loss view (compat): net losses floored at zero. */
  get dailyLossUsd(): number {
    return Math.max(0, -dailyNetPnlUsd);
  },
  /** Net realized live PnL today (negative = losing). */
  get dailyNetPnlUsd(): number {
    return dailyNetPnlUsd;
  },
  get liveOpenCount(): number {
    return liveOpenCount;
  },
  get liveOpenExposureUsd(): number {
    return liveOpenExposureUsd;
  },
  isHalted(): boolean {
    const limit = dailyLossLimitUsd();
    return (
      halted ||
      dailyNetPnlUsd <= -limit ||
      dailyNetPnlUsd - liveOpenExposureUsd <= -limit
    );
  },
  halt(reason: string): void {
    halted = true;
    console.log(`🛑 live entries halted: ${reason}`);
  },
  recordRealizedPnl(pnlUsd: number): void {
    if (Number.isFinite(pnlUsd)) dailyNetPnlUsd += pnlUsd;
  },
  setLiveOpenCount(n: number): void {
    liveOpenCount = n;
  },
  setLiveOpenExposureUsd(usd: number): void {
    if (Number.isFinite(usd) && usd >= 0) liveOpenExposureUsd = usd;
  },
  addPending(positionId: string): void {
    pendingOrders.add(positionId);
  },
  removePending(positionId: string): void {
    pendingOrders.delete(positionId);
  },
  hasPending(positionId: string): boolean {
    return pendingOrders.has(positionId);
  },
  /** Manual halt stays sticky across restarts until explicitly resumed. */
  resume(): void {
    halted = false;
  },
  /** Tests only — production state is append-only within a process. */
  resetForTests(): void {
    dailyLossUsd = 0;
    dailyNetPnlUsd = 0;
    liveOpenExposureUsd = 0;
    halted = false;
    liveOpenCount = 0;
    lossDay = todayUtc();
    pendingOrders.clear();
  },
};

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function defaultLiveStatePath(): string {
  return process.env.LIVE_STATE_FILE ?? "data/live-state.json";
}

interface LiveStateFile {
  version: number;
  savedAt: number;
  lossDay: string;
  /** Legacy gross-loss field, still written for old readers. */
  dailyLossUsd: number;
  /** Net realized PnL today; preferred on restore. */
  dailyNetPnlUsd: number;
  halted: boolean;
}

/** Persist kill-switch state atomically. Call after every mutation. */
export function persistLiveState(path: string = defaultLiveStatePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const payload: LiveStateFile = {
    version: 1,
    savedAt: Date.now(),
    lossDay,
    dailyLossUsd: Math.max(0, -dailyNetPnlUsd),
    dailyNetPnlUsd,
    halted,
  };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload), "utf8");
  renameSync(tmp, path);
}

/**
 * Restore kill-switch state. A UTC-day rollover resets the loss
 * accumulator (limits are per-day); a manual halt stays sticky.
 * Missing/corrupt files mean a fresh day — boot never fails.
 */
export function restoreLiveState(path: string = defaultLiveStatePath()): void {
  if (!existsSync(path)) {
    lossDay = todayUtc();
    return;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LiveStateFile>;
    const losses = typeof parsed.dailyLossUsd === "number" && Number.isFinite(parsed.dailyLossUsd) && parsed.dailyLossUsd >= 0
      ? parsed.dailyLossUsd
      : 0;
    // Prefer the net field; pre-net ledgers only have gross losses.
    const net = typeof parsed.dailyNetPnlUsd === "number" && Number.isFinite(parsed.dailyNetPnlUsd)
      ? parsed.dailyNetPnlUsd
      : -losses;
    const day = typeof parsed.lossDay === "string" ? parsed.lossDay : todayUtc();
    if (day !== todayUtc()) {
      dailyNetPnlUsd = 0;
      lossDay = todayUtc();
    } else {
      dailyNetPnlUsd = net;
      lossDay = day;
    }
    dailyLossUsd = Math.max(0, -dailyNetPnlUsd);
    halted = parsed.halted === true;
  } catch {
    lossDay = todayUtc();
  }
}
