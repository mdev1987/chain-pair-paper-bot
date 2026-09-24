import { config } from "../config.ts";
import { liveState, dailyLossLimitUsd } from "./live-state.ts";
import { liveTradingEnabled } from "./types.ts";

/**
 * The safety invariant: EVERY live buy requires ALL of these, otherwise
 * NO TRANSACTION. Fail-closed throughout — unknown/missing inputs refuse.
 *
 * Exits deliberately bypass this gate (see below): the bot must always be
 * able to exit an existing position, even with entries halted.
 */
export interface BuyGateInput {
  chain: string;
  /** Planned position size in USD. Non-finite or missing refuses. */
  sizeUsd: number;
  /** Quote risk verdict. Must be an explicit pass — null refuses. */
  riskPass: boolean | null;
  /**
   * Simulation outcome. Must be an explicit success, with one documented
   * exception: Solana/Jupiter has no local simulate path (its quotes
   * carry no calldata), so null is accepted ONLY for jupiter quotes —
   * Jupiter's /execute does managed landing + confirmation instead.
   */
  simOk: boolean | null;
  quoteSource: string;
  /** Position id for the pending-order check. Omitted skips that check. */
  positionId?: string;
}

export function maxSizeFor(chain: string): number {
  return config.entry.chainSizes.get(chain.toLowerCase()) ?? config.entry.positionSizeUsd;
}

export function checkBuyPreconditions(
  input: BuyGateInput,
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  if (!liveTradingEnabled()) {
    failures.push("LIVE_TRADING_ENABLED is not true");
  }
  if (liveState.isHalted()) {
    failures.push(
      `entries halted (loss $${liveState.dailyLossUsd.toFixed(2)} / limit $${dailyLossLimitUsd().toFixed(2)})`,
    );
  }
  if (liveState.liveOpenCount >= config.entry.maxOpenPositions) {
    failures.push(
      `too many live positions (${liveState.liveOpenCount}/${config.entry.maxOpenPositions})`,
    );
  }
  const maxSize = maxSizeFor(input.chain);
  if (!Number.isFinite(input.sizeUsd) || input.sizeUsd <= 0 || input.sizeUsd > maxSize) {
    failures.push(`size $${String(input.sizeUsd)} outside (0, $${maxSize}] on ${input.chain}`);
  }
  if (input.riskPass !== true) {
    failures.push("quote risk check did not explicitly pass");
  }
  const simOk =
    input.simOk === true ||
    (input.chain === "solana" && input.quoteSource === "jupiter" && input.simOk === null);
  if (!simOk) {
    failures.push("simulation did not succeed (non-Jupiter quotes need eth_call sim)");
  }
  if (input.positionId !== undefined && liveState.hasPending(input.positionId)) {
    failures.push(`pending order exists for ${input.positionId}`);
  }
  return { ok: failures.length === 0, failures };
}
