import type { ConfirmedFill } from "./solana/fills.ts";
import {
  markConfirmed,
  markFailed,
  openOrders,
  type LiveOrder,
} from "./live-orders.ts";
import type { LivePosition } from "./live-positions.ts";

/**
 * Phase 1.7 — startup reconciliation. Order of operations, exactly as
 * specified:
 *
 *   wallet → pending transactions → internal positions → ledger
 *
 * Every order that was not CONFIRMED at shutdown is resolved FROM THE
 * CHAIN rather than assumed:
 * - confirmed on-chain → fetch the actual fill, mark CONFIRMED (the
 *   caller applies it to live positions + ledger)
 * - failed on-chain → mark FAILED with the note
 * - SIGNAL with no signature → nothing was ever submitted → FAILED
 *   ("never submitted"), flagged for operator review
 * - SUBMITTED but missing on-chain (unlanded/expired) → left SUBMITTED
 *   for the retry path; reported, never assumed either way
 *
 * Then live OPEN positions are cross-checked against on-chain token
 * balances; mismatches are reported, never auto-corrected.
 */

export type ChainTxStatus = "confirmed" | "failed" | "missing";

export interface ReconcileDeps {
  /** On-chain status of a signature (getSignatureStatuses). */
  getTxStatus: (signature: string) => Promise<ChainTxStatus>;
  /** Actual fill for a confirmed signature (fetchConfirmedFill). */
  fetchFill: (signature: string) => Promise<ConfirmedFill>;
  /** Trader's current balance of a mint on a chain, base units (null when unreadable). */
  getBalance: (chain: string, mint: string) => Promise<bigint | null>;
}

export interface ReconciledFill {
  order: LiveOrder;
  fill: ConfirmedFill;
}

export interface ReconcileReport {
  /** Orders moved to CONFIRMED with their actual fills (apply downstream). */
  confirmed: ReconciledFill[];
  /** Orders moved to FAILED (on-chain failure or never submitted). */
  failed: LiveOrder[];
  /** SUBMITTED orders still missing on-chain (left pending for retry). */
  stillMissing: LiveOrder[];
  /** Position-vs-wallet mismatches needing operator review. */
  discrepancies: string[];
  /** Journal after all transitions (persist it). */
  orders: LiveOrder[];
}

export async function reconcileLiveState(
  orders: LiveOrder[],
  positions: LivePosition[],
  deps: ReconcileDeps,
): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    confirmed: [],
    failed: [],
    stillMissing: [],
    discrepancies: [],
    orders,
  };
  let journal = orders;
  for (const order of openOrders(orders)) {
    // Labeled orders (TP1/EXIT) resolve under their own label.
    const label = order.label ?? "";
    const refind = (): LiveOrder =>
      journal.find((o) => o.positionId === order.positionId && o.side === order.side && (o.label ?? "") === label)!;
    if (order.status === "SIGNAL" || !order.signature) {
      journal = markFailed(journal, order.positionId, order.side, "never submitted (SIGNAL at shutdown)", label);
      report.failed.push(refind());
      continue;
    }
    let status: ChainTxStatus;
    try {
      status = await deps.getTxStatus(order.signature);
    } catch (error) {
      report.discrepancies.push(
        `status check failed for ${order.signature}: ${String(error).slice(0, 120)} (left ${order.status})`,
      );
      continue;
    }
    if (status === "confirmed") {
      try {
        const fill = await deps.fetchFill(order.signature);
        journal = markConfirmed(journal, order.positionId, order.side, label);
        report.confirmed.push({ order: refind(), fill });
      } catch (error) {
        report.discrepancies.push(
          `confirmed ${order.signature} but fill unreadable: ${String(error).slice(0, 120)}`,
        );
      }
    } else if (status === "failed") {
      journal = markFailed(journal, order.positionId, order.side, "failed on-chain before shutdown", label);
      report.failed.push(refind());
    } else {
      report.stillMissing.push(order);
    }
  }
  report.orders = journal;
  for (const position of positions) {
    if (position.status !== "OPEN") continue;
    try {
      const onchain = await deps.getBalance(position.chain, position.tokenMint);
      if (onchain === null) continue;
      if (onchain.toString() !== position.remainingBaseUnits) {
        report.discrepancies.push(
          `${position.positionId}: wallet ${onchain} vs recorded ${position.remainingBaseUnits}`,
        );
      }
    } catch (error) {
      report.discrepancies.push(
        `balance unreadable for ${position.positionId}: ${String(error).slice(0, 120)}`,
      );
    }
  }
  return report;
}
