import type { SwapExecutor } from "../types.ts";

/**
 * PancakeSwap Smart Router adapter (BSC direct-DEX fallback for pools the
 * aggregators haven't indexed yet).
 *
 * STAGE 1 WORK: backed by @pancakeswap/smart-router quoter calls against a
 * BSC RPC. Interface stub only — every method throws until implemented, so
 * the router treats it as "no route" rather than failing silently.
 */
export class PancakeSwapExecutor implements SwapExecutor {
  readonly name = "pancakeswap";

  async quoteBuy(): Promise<never> {
    throw new Error("PancakeSwap adapter not implemented yet (Stage 1: @pancakeswap/smart-router)");
  }

  async quoteSell(): Promise<never> {
    throw new Error("PancakeSwap adapter not implemented yet (Stage 1: @pancakeswap/smart-router)");
  }

  async simulate(): Promise<never> {
    throw new Error("PancakeSwap adapter not implemented yet (Stage 1: @pancakeswap/smart-router)");
  }

  async buy(): Promise<never> {
    throw new Error("PancakeSwap adapter not implemented yet (Stage 1: @pancakeswap/smart-router)");
  }

  async sell(): Promise<never> {
    throw new Error("PancakeSwap adapter not implemented yet (Stage 1: @pancakeswap/smart-router)");
  }
}
