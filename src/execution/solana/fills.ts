import type { VersionedTransactionResponse } from "@solana/web3.js";
import { getSolanaConnection } from "./client.ts";
import { traderPublicKey } from "./signer.ts";

/**
 * Phase 1.2 — actual-fill extraction. The paper engine fills virtually at
 * observed marks; live positions update ONLY from confirmed on-chain
 * results. Two sources, in order of preference:
 *
 * 1. Jupiter /execute response (totalInputAmount/totalOutputAmount) —
 *    already captured by executeJupiterSwap.
 * 2. This module: parse the confirmed transaction's pre/post token
 *    balances for the trader and net per-mint deltas. Independent of
 *    Jupiter — works for any Solana swap tx and cross-checks /execute.
 */

export interface ConfirmedFill {
  signature: string;
  slot: number;
  sellMint: string;
  sellAmountBaseUnits: string;
  buyMint: string;
  buyAmountBaseUnits: string;
  /** Network fee actually paid, lamports. */
  feeLamports: string;
}

/**
 * Pure: net per-mint deltas for the trader from a confirmed transaction.
 * Multiple accounts per mint (WSOL wrapping, intermediaries) are netted
 * first — the fill is the largest net outflow (sell) and largest net
 * inflow (buy). Throws when the tx failed or has no usable token deltas.
 */
export function parseFillFromTransaction(
  tx: VersionedTransactionResponse,
  trader: string,
  signature: string,
): ConfirmedFill {
  const meta = tx?.meta;
  if (!meta) throw new Error("Transaction has no meta (unconfirmed or pruned)");
  if (meta.err) {
    throw new Error(`Transaction failed on-chain: ${JSON.stringify(meta.err).slice(0, 200)}`);
  }
  const pre = ((meta.preTokenBalances ?? []) as unknown as Array<{
    mint: string;
    owner?: string;
    uiTokenAmount: { amount: string };
  }>);
  const post = ((meta.postTokenBalances ?? []) as unknown as Array<{
    mint: string;
    owner?: string;
    uiTokenAmount: { amount: string };
  }>);
  const net = new Map<string, bigint>();
  const bump = (mint: string, owner: string | undefined, amount: string, sign: 1n | -1n) => {
    if (owner !== trader) return;
    try {
      net.set(mint, (net.get(mint) ?? 0n) + sign * BigInt(amount));
    } catch {
      // Unparseable amount — ignore this row.
    }
  };
  for (const b of pre) bump(b.mint, b.owner, b.uiTokenAmount.amount, -1n);
  for (const b of post) bump(b.mint, b.owner, b.uiTokenAmount.amount, 1n);
  let sellMint = "";
  let sellAmount = 0n;
  let buyMint = "";
  let buyAmount = 0n;
  for (const [mint, delta] of net) {
    if (delta < 0n && -delta > sellAmount) {
      sellMint = mint;
      sellAmount = -delta;
    } else if (delta > 0n && delta > buyAmount) {
      buyMint = mint;
      buyAmount = delta;
    }
  }
  if (!sellMint || !buyMint || sellAmount <= 0n || buyAmount <= 0n) {
    throw new Error("No usable token deltas for trader in confirmed transaction");
  }
  const fee = (meta as { fee?: string | number }).fee;
  return {
    signature,
    slot: tx.slot,
    sellMint,
    sellAmountBaseUnits: sellAmount.toString(),
    buyMint,
    buyAmountBaseUnits: buyAmount.toString(),
    feeLamports: String(fee ?? "0"),
  };
}

/** Fetch a confirmed transaction and extract the trader's actual fill. */
export async function fetchConfirmedFill(
  signature: string,
): Promise<ConfirmedFill> {
  const trader = traderPublicKey();
  const connection = getSolanaConnection();
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) throw new Error(`Transaction not found (unlanded or pruned): ${signature}`);
  return parseFillFromTransaction(tx, trader, signature);
}
