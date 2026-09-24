import type { TransactionReceipt } from "viem";
import { getEvmPublicClient } from "./viem-client.ts";
import { parseEvmFillFromReceipt, traderEvmAddress, traderTokenBalance } from "./live.ts";
import type { ConfirmedFill } from "../solana/fills.ts";
import type { LiveOrder } from "../live-orders.ts";
import type { ChainTxStatus } from "../reconcile.ts";

/**
 * EVM flavor of startup-reconciliation deps (Robinhood + all EVM chains).
 * Plugs into the chain-agnostic reconcileLiveState() core:
 *
 * - getTxStatus: transaction receipt → missing / confirmed / failed.
 * - fetchFillFor: receipt Transfer-log parse for the trader. Needs the
 *   token pair, which lives on the journal order's meta (recorded by EVM
 *   strategy wiring). Shaped as ConfirmedFill; feeLamports carries the
 *   native-wei gas cost (gasUsed × effectiveGasPrice), documented here
 *   because the field name is Solana-flavored.
 * - getBalance: native or ERC20 trader balance.
 */

export function evmTxStatusFetcher(chain: string): (signature: string) => Promise<ChainTxStatus> {
  return async (signature: string) => {
    const receipt = await getEvmPublicClient(chain).getTransactionReceipt({
      hash: signature as `0x${string}`,
    });
    if (!receipt) return "missing";
    return receipt.status === "success" ? "confirmed" : "failed";
  };
}

export function evmFillFromReceipt(
  signature: string,
  receipt: TransactionReceipt,
  sellToken: string,
  buyToken: string,
): ConfirmedFill {
  const trader = traderEvmAddress();
  const parsed = parseEvmFillFromReceipt(
    (receipt.logs ?? []).map((l) => ({
      address: l.address,
      topics: [...l.topics],
      data: l.data,
    })),
    trader,
    sellToken,
    buyToken,
  );
  return {
    signature,
    slot: Number(receipt.blockNumber),
    sellMint: sellToken,
    sellAmountBaseUnits: parsed.sellAmount.toString(),
    buyMint: buyToken,
    buyAmountBaseUnits: parsed.buyAmount.toString(),
    feeLamports: (receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n)).toString(),
  };
}

export function evmFillFetcher(
  chain: string,
  findOrder: (signature: string) => LiveOrder | undefined,
): (signature: string) => Promise<ConfirmedFill> {
  return async (signature: string) => {
    const order = findOrder(signature);
    const meta = order?.meta;
    if (!meta?.sellToken || !meta?.buyToken) {
      throw new Error(`No token pair recorded for order ${signature} (cannot parse receipt fills)`);
    }
    const client = getEvmPublicClient(chain);
    const receipt = await client.getTransactionReceipt({ hash: signature as `0x${string}` });
    if (!receipt) throw new Error(`Receipt missing for ${signature}`);
    if (receipt.status !== "success") throw new Error(`Transaction reverted: ${signature}`);
    return evmFillFromReceipt(signature, receipt, meta.sellToken, meta.buyToken);
  };
}

export function evmBalanceFetcher(chain: string): (mint: string) => Promise<bigint | null> {
  return (mint: string) => traderTokenBalance(chain, mint);
}
