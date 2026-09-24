/**
 * Process-wide live-trading state for the safety invariant.
 *
 * Step 1 (now): in-memory only. Steps 3 and 5 add durability —
 * pending-order file persistence (crash recovery) and durable daily-loss
 * accounting (kill switch that survives restart). Until then, a restart
 * clears pending/loss memory; the invariant still fails closed everywhere
 * else (live flag, limits, quote risk, simulation).
 */

let dailyLossUsd = 0;
let halted = false;
let liveOpenCount = 0;
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
  get dailyLossUsd(): number {
    return dailyLossUsd;
  },
  get liveOpenCount(): number {
    return liveOpenCount;
  },
  isHalted(): boolean {
    return halted || dailyLossUsd >= dailyLossLimitUsd();
  },
  halt(reason: string): void {
    halted = true;
    console.log(`🛑 live entries halted: ${reason}`);
  },
  recordRealizedPnl(pnlUsd: number): void {
    if (Number.isFinite(pnlUsd) && pnlUsd < 0) dailyLossUsd += -pnlUsd;
  },
  setLiveOpenCount(n: number): void {
    liveOpenCount = n;
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
  /** Tests only — production state is append-only within a process. */
  resetForTests(): void {
    dailyLossUsd = 0;
    halted = false;
    liveOpenCount = 0;
    pendingOrders.clear();
  },
};
