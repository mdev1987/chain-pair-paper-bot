import type { PublicClient } from "viem";
import type { SimulationResult } from "../types.ts";

export interface EvmCallRequest {
  from: `0x${string}`;
  to: `0x${string}`;
  calldata: `0x${string}`;
  value?: bigint;
}

/**
 * Transaction simulation via eth_call (the keyless half of "Tenderly or
 * eth_call/viem"): replays the exact calldata against current chain state
 * without spending anything. Catches reverts, transfer-tax traps,
 * insufficient output and bad calldata before real money is exposed.
 * Tenderly Simulation API remains the optional upgrade for richer traces.
 */
export async function simulateEvmCall(
  client: PublicClient,
  call: EvmCallRequest,
): Promise<SimulationResult> {
  try {
    const returnData = await client.call({
      account: call.from,
      to: call.to,
      data: call.calldata,
      ...(call.value !== undefined ? { value: call.value } : {}),
    });
    return { ok: true, returnData: returnData.data ?? null };
  } catch (error) {
    return { ok: false, reason: String(error).slice(0, 300) };
  }
}
