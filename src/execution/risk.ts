import type { Quote, RiskAssessment, RiskPolicy } from "./types.ts";

/**
 * Pure risk gate for the doc's RISK GATE box: max impact, max buy/sell tax,
 * min output, max gas. Unknown venue fields warn but don't block — a fresh
 * pool's first quotable route often reports no impact figure, and blocking
 * on unknown would reject everything during price discovery.
 */
export function assessQuoteRisk(quote: Quote, policy: RiskPolicy): RiskAssessment {
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (quote.priceImpactPct === null || !Number.isFinite(quote.priceImpactPct)) {
    warnings.push("price-impact-unknown");
  } else if (quote.priceImpactPct > policy.maxPriceImpactPct) {
    reasons.push(
      `price-impact ${quote.priceImpactPct.toFixed(2)}% > ${policy.maxPriceImpactPct}%`,
    );
  }

  if (quote.buyTaxBps !== null && quote.buyTaxBps > policy.maxBuyTaxBps) {
    reasons.push(`buy-tax ${quote.buyTaxBps}bps > ${policy.maxBuyTaxBps}bps`);
  }
  if (quote.sellTaxBps !== null && quote.sellTaxBps > policy.maxSellTaxBps) {
    reasons.push(`sell-tax ${quote.sellTaxBps}bps > ${policy.maxSellTaxBps}bps`);
  }
  if (quote.buyTaxBps === null || quote.sellTaxBps === null) {
    warnings.push("transfer-tax-unknown");
  }

  if (policy.minBuyAmountBaseUnits) {
    try {
      if (BigInt(quote.buyAmount) < BigInt(policy.minBuyAmountBaseUnits)) {
        reasons.push(
          `output ${quote.buyAmount} < minimum ${policy.minBuyAmountBaseUnits}`,
        );
      }
    } catch {
      reasons.push("output-amount-unparseable");
    }
  }

  if (
    policy.maxGasUnits !== null &&
    policy.maxGasUnits !== undefined &&
    quote.estimatedGasUnits !== null &&
    quote.estimatedGasUnits > policy.maxGasUnits
  ) {
    reasons.push(`gas ${quote.estimatedGasUnits} > ${policy.maxGasUnits}`);
  }

  return { pass: reasons.length === 0, reasons, warnings };
}
