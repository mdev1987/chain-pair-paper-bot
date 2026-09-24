import type { Quote, QuoteRequest, SwapExecutor } from "../types.ts";

export type QuoteAdapter = Pick<SwapExecutor, "name" | "quoteBuy" | "quoteSell">;

function buyAmountValue(quote: Quote): bigint | null {
  try {
    const value = BigInt(quote.buyAmount);
    return value > 0n ? value : null;
  } catch {
    return null;
  }
}

/**
 * Pure best-quote selection: highest output wins; zero/unparseable outputs
 * are discarded. Aggregator indexing lags on fresh pools, so "no quotable
 * route" (null) is a normal outcome the caller handles via direct fallback.
 */
export function selectBestQuote(quotes: Quote[]): Quote | null {
  let best: Quote | null = null;
  let bestValue = 0n;
  for (const quote of quotes) {
    const value = buyAmountValue(quote);
    if (value === null || value <= bestValue) continue;
    best = quote;
    bestValue = value;
  }
  return best;
}

/**
 * Aggregator-first routing with direct-DEX fallback: try each adapter in
 * order, keep the best valid quote, and throw an aggregated error only when
 * nothing is quotable (fresh pools often aren't indexed yet — that is a
 * routing signal, not a bug).
 */
export async function routeQuote(
  adapters: QuoteAdapter[],
  request: QuoteRequest,
  kind: "buy" | "sell",
): Promise<Quote> {
  const quotes: Quote[] = [];
  const errors: string[] = [];
  for (const adapter of adapters) {
    // ZeroEx without a key always fails — skip the wasted round-trip.
    if (adapter.name === "0x" && !process.env.ZEROEX_API_KEY) {
      errors.push("0x: ZEROEX_API_KEY is not configured");
      continue;
    }
    try {
      const quote = kind === "buy"
        ? await adapter.quoteBuy(request)
        : await adapter.quoteSell(request);
      if (buyAmountValue(quote) !== null) quotes.push(quote);
      else errors.push(`${adapter.name}: zero/unparseable output`);
    } catch (error) {
      errors.push(`${adapter.name}: ${String(error).slice(0, 200)}`);
    }
  }
  const best = selectBestQuote(quotes);
  if (!best) {
    throw new Error(`No quotable route for ${request.sellToken} -> ${request.buyToken}: ${errors.join("; ")}`);
  }
  return best;
}
