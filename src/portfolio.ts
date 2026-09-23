import { totalPnlUsd } from "./position.ts";
import type { Position } from "./types.ts";

export interface ClosedTrade {
  id: string;
  chain: string;
  symbol: string;
  dexId: string;
  pnlUsd: number;
  pnlPct: number;
  reason: string;
  durationMs: number;
  openedAt: number;
  closedAt: number;
}

export interface ChainStat {
  chain: string;
  trades: number;
  wins: number;
  pnlUsd: number;
}

export interface PortfolioSnapshot {
  equityUsd: number;
  cashUsd: number;
  openValueUsd: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  totalPnlUsd: number;
}

/**
 * Paper portfolio: cash + open-position market value = equity.
 * Proceeds from partial TPs and final exits flow back to cash via
 * onProceeds(); closed trades accumulate for win-rate / per-chain analysis.
 */
export class Portfolio {
  readonly initialBalanceUsd: number;
  private cash: number;
  private readonly closed: ClosedTrade[] = [];

  constructor(initialBalanceUsd: number) {
    if (!Number.isFinite(initialBalanceUsd) || initialBalanceUsd <= 0) {
      throw new Error("Portfolio initial balance must be positive");
    }
    this.initialBalanceUsd = initialBalanceUsd;
    this.cash = initialBalanceUsd;
  }

  get cashUsd(): number {
    return this.cash;
  }

  get closedTrades(): readonly ClosedTrade[] {
    return this.closed;
  }

  /**
   * Restore cash + trade history after a restart (positions recovery).
   * Invalid values are ignored so a corrupt state file can never wedge boot.
   */
  restore(cashUsd: number, closedTrades: ClosedTrade[]): void {
    if (Number.isFinite(cashUsd) && cashUsd >= 0) this.cash = cashUsd;
    if (Array.isArray(closedTrades)) {
      for (const t of closedTrades) {
        if (
          typeof t.id === "string" &&
          typeof t.chain === "string" &&
          typeof t.symbol === "string" &&
          Number.isFinite(t.pnlUsd)
        ) {
          this.closed.push(t);
        }
      }
    }
  }

  openValueUsd(openPositions: Iterable<Position>): number {
    let value = 0;
    for (const p of openPositions) {
      if (p.status !== "OPEN") continue;
      value += Math.max(0, p.quantity) * Math.max(0, p.currentPrice);
    }
    return value;
  }

  equityUsd(openPositions: Iterable<Position>): number {
    return this.cash + this.openValueUsd(openPositions);
  }

  canOpen(costUsd: number): boolean {
    return Number.isFinite(costUsd) && costUsd > 0 && this.cash >= costUsd;
  }

  /** Reserve notional on entry. Returns false when cash is insufficient. */
  onOpen(costUsd: number): boolean {
    if (!this.canOpen(costUsd)) return false;
    this.cash -= costUsd;
    return true;
  }

  /** Partial TP proceeds and final exit proceeds flow back to cash. */
  onProceeds(amountUsd: number): void {
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) return;
    this.cash += amountUsd;
  }

  /** Record a fully closed position for stats. Returns the stored record. */
  onClose(position: Position): ClosedTrade {
    const pnlUsd = totalPnlUsd(position);
    const pnlPct = position.initialUsdSize > 0 ? (pnlUsd / position.initialUsdSize) * 100 : 0;
    const record: ClosedTrade = {
      id: position.id,
      chain: position.chain,
      symbol: position.symbol,
      dexId: position.dexId,
      pnlUsd,
      pnlPct,
      reason: position.closedReason ?? "unknown",
      durationMs: Math.max(0, (position.closedAt ?? Date.now()) - position.openedAt),
      openedAt: position.openedAt,
      closedAt: position.closedAt ?? Date.now(),
    };
    this.closed.push(record);
    return record;
  }

  snapshot(openPositions: Iterable<Position>): PortfolioSnapshot {
    const openValue = this.openValueUsd(openPositions);
    const totalTrades = this.closed.length;
    const wins = this.closed.filter((t) => t.pnlUsd > 0).length;
    const losses = this.closed.filter((t) => t.pnlUsd <= 0).length;
    return {
      equityUsd: this.cash + openValue,
      cashUsd: this.cash,
      openValueUsd: openValue,
      totalTrades,
      wins,
      losses,
      winRatePct: totalTrades === 0 ? 0 : (wins / totalTrades) * 100,
      totalPnlUsd: this.closed.reduce((sum, t) => sum + t.pnlUsd, 0),
    };
  }

  chainStats(): ChainStat[] {
    const map = new Map<string, ChainStat>();
    for (const t of this.closed) {
      const stat = map.get(t.chain) ?? { chain: t.chain, trades: 0, wins: 0, pnlUsd: 0 };
      stat.trades += 1;
      if (t.pnlUsd > 0) stat.wins += 1;
      stat.pnlUsd += t.pnlUsd;
      map.set(t.chain, stat);
    }
    return [...map.values()].sort((a, b) => b.pnlUsd - a.pnlUsd);
  }

  chainStat(chain: string): ChainStat {
    const all = this.chainStats();
    return all.find((s) => s.chain === chain) ?? { chain, trades: 0, wins: 0, pnlUsd: 0 };
  }

  tokenPnlUsd(chain: string, symbol: string): { trades: number; pnlUsd: number } {
    const rows = this.closed.filter((t) => t.chain === chain && t.symbol === symbol);
    return { trades: rows.length, pnlUsd: rows.reduce((sum, t) => sum + t.pnlUsd, 0) };
  }
}
