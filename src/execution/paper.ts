import type {
  ExecutionResult,
  Quote,
  QuoteRequest,
  SimulationResult,
  SwapExecutor,
  SwapRequest,
} from "./types.ts";

/**
 * Virtual executor for tests and dry runs. Fills at the caller-supplied
 * mark price with zero friction — the same model as the current paper
 * engine, so simulated swaps stay comparable with paper fills.
 * NOT wired into src/main.ts (Stage 0): the live paper loop is untouched.
 */
export class PaperExecutor implements SwapExecutor {
  readonly name = "paper";

  private mark(request: QuoteRequest): { price: number; sellDec: number; buyDec: number } {
    if (request.markPrice === undefined || !Number.isFinite(request.markPrice) || request.markPrice <= 0) {
      throw new Error("PaperExecutor quotes require a positive markPrice");
    }
    return {
      price: request.markPrice,
      sellDec: request.sellDecimals ?? 18,
      buyDec: request.buyDecimals ?? 18,
    };
  }

  private buildQuote(request: QuoteRequest): Quote {
    const { price, sellDec, buyDec } = this.mark(request);
    const sellBase = BigInt(request.sellAmountBaseUnits);
    if (sellBase <= 0n) throw new Error("PaperExecutor requires a positive sell amount");
    // buyBase = sellBase * price * 10^(buyDec - sellDec), integer math.
    const scale = 10n ** BigInt(Math.abs(buyDec - sellDec));
    const scaled = buyDec >= sellDec ? sellBase * scale : sellBase / scale;
    // price has decimals: multiply through 1e9 then divide back for precision.
    const buyBase = (scaled * BigInt(Math.round(price * 1e9))) / 1_000_000_000n;
    if (buyBase <= 0n) throw new Error("PaperExecutor mark implies zero output");
    return {
      source: "paper",
      chain: request.chain,
      sellToken: request.sellToken,
      buyToken: request.buyToken,
      sellAmount: sellBase.toString(),
      buyAmount: buyBase.toString(),
      priceImpactPct: 0,
      buyTaxBps: 0,
      sellTaxBps: 0,
      estimatedGasUnits: 0,
      raw: { markPrice: price },
    };
  }

  async quoteBuy(request: QuoteRequest): Promise<Quote> {
    return this.buildQuote(request);
  }

  async quoteSell(request: QuoteRequest): Promise<Quote> {
    return this.buildQuote(request);
  }

  async simulate(request: SwapRequest): Promise<SimulationResult> {
    try {
      const out = BigInt(request.quote.buyAmount);
      if (out <= 0n) return { ok: false, reason: "zero output" };
      return { ok: true };
    } catch {
      return { ok: false, reason: "unparseable output" };
    }
  }

  async buy(request: SwapRequest): Promise<ExecutionResult> {
    const sim = await this.simulate(request);
    if (!sim.ok) return { ok: false, sellAmount: "0", buyAmount: "0", reason: sim.reason };
    return { ok: true, sellAmount: request.quote.sellAmount, buyAmount: request.quote.buyAmount };
  }

  async sell(request: SwapRequest): Promise<ExecutionResult> {
    return this.buy(request);
  }
}
