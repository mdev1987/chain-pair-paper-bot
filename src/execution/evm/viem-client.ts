import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Chain,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  arbitrum,
  avalanche,
  base,
  bsc,
  mainnet,
  polygon,
} from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Robinhood Chain (EVM L2, chain id 4663). Not in viem's built-in chain
 * list, so defined explicitly. RPC comes from EVM_RPC_URLS like the rest.
 */
export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://example.invalid"] } },
});

const KNOWN_CHAINS: Record<string, Chain> = {
  ethereum: mainnet,
  base,
  bsc,
  arbitrum,
  avalanche,
  polygon,
  robinhood: robinhoodChain,
};

export const EVM_CHAIN_IDS: Record<string, number> = {
  ethereum: 1,
  base: 8453,
  bsc: 56,
  arbitrum: 42161,
  avalanche: 43114,
  polygon: 137,
  robinhood: 4663,
};

/**
 * Public read-only RPC defaults so simulation (decimals reads, direct-V2
 * quotes, eth_call) works without private endpoints. Low-frequency use
 * only — configure private EVM_RPC_URLS for anything heavier. No entry
 * for chains without a reliable public endpoint (robinhood): those skip
 * simulation with an explicit reason until configured.
 */
const DEFAULT_PUBLIC_RPCS: Record<string, string> = {
  ethereum: "https://ethereum-rpc.publicnode.com",
  base: "https://mainnet.base.org",
  bsc: "https://bsc-dataseed.binance.org",
  arbitrum: "https://arb1.arbitrum.io/rpc",
  avalanche: "https://api.avax.network/ext/bc/C/rpc",
  polygon: "https://polygon-rpc.com",
};

function rpcUrls(): Record<string, string> {
  const merged: Record<string, string> = { ...DEFAULT_PUBLIC_RPCS };
  try {
    const parsed: unknown = JSON.parse(process.env.EVM_RPC_URLS ?? "{}");
    if (typeof parsed === "object" && parsed !== null) {
      for (const [chain, url] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof url === "string" && url) merged[chain] = url;
      }
    }
  } catch {
    // Malformed EVM_RPC_URLS falls back to public defaults below.
  }
  return merged;
}

function chainDef(chain: string): Chain {
  const def = KNOWN_CHAINS[chain];
  if (!def) throw new Error(`Unknown EVM chain "${chain}" (known: ${Object.keys(KNOWN_CHAINS).join(", ")})`);
  return def;
}

function rpcFor(chain: string): string {
  const url = rpcUrls()[chain];
  if (!url) {
    throw new Error(
      `No RPC configured for "${chain}" (set EVM_RPC_URLS, e.g. {"${chain}":"https://..."})`,
    );
  }
  return url;
}

const ERC20_DECIMALS_ABI = [
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

/** On-chain token decimals (needed to size simulated sells of position tokens). */
export async function getEvmTokenDecimals(chain: string, token: `0x${string}`): Promise<number> {
  const client = getEvmPublicClient(chain);
  return await client.readContract({ address: token, abi: ERC20_DECIMALS_ABI, functionName: "decimals" });
}

/** Read-only client for quotes, gas, and eth_call simulation. */
export function getEvmPublicClient(chain: string): PublicClient {
  return createPublicClient({ chain: chainDef(chain), transport: http(rpcFor(chain)) });
}

/**
 * Signing client for live spends. Requires TRADER_PRIVATE_KEY (isolated hot
 * wallet only — never commit) and LIVE_TRADING_ENABLED=true.
 */
export function getEvmWalletClient(chain: string): WalletClient {
  const key = process.env.TRADER_PRIVATE_KEY ?? "";
  if (!key) throw new Error("TRADER_PRIVATE_KEY is not configured");
  if ((process.env.LIVE_TRADING_ENABLED ?? "").toLowerCase() !== "true") {
    throw new Error("Refusing to build a signing client: LIVE_TRADING_ENABLED is not true");
  }
  const account = privateKeyToAccount(key as `0x${string}`);
  return createWalletClient({ account, chain: chainDef(chain), transport: http(rpcFor(chain)) });
}
