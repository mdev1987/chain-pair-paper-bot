import type { Position } from "./types.ts";
import type { ChainStat, PortfolioSnapshot } from "./portfolio.ts";
import { remainingPct, totalPnlPct, totalPnlUsd } from "./position.ts";

const CHAIN_ICONS: Record<string, string> = {
  solana: "◎",
  ethereum: "Ξ",
  base: "🔵",
  bsc: "🟡",
  arbitrum: "🔷",
  polygon: "🟣",
  avalanche: "🔺",
  robinhood: "🏹",
};

export function chainIcon(chain: string): string {
  return CHAIN_ICONS[chain.toLowerCase()] ?? "⛓️";
}

export function exitBadge(reason: string | undefined): string {
  switch (reason) {
    case "TRAIL_EXIT": return "📉 TRAILING EXIT";
    case "STOP_EXIT": return "🔴 STOP EXIT";
    case "EARLY_STOP": return "🛑 EARLY STOP";
    case "BREAKEVEN_STOP": return "🛟 BREAKEVEN STOP";
    case "TIME_EXIT": return "⏱ TIME EXIT";
    default: return `🏁 CLOSED (${reason ?? "unknown"})`;
  }
}

export function fmtUsd(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "$0.00";
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** Liquidity-style optional USD: "—" when unknown instead of $0.00. */
export function fmtOptUsd(value: number | undefined, digits = 0): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function fmtSignedUsd(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "$0.00";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${fmtUsd(Math.abs(value), digits)}`;
}

export function fmtPct(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "0.00%";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}

export function fmtPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  return `$${value.toPrecision(8)}`;
}

export function fmtDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(11, 19);
}

export interface BuyReport {
  position: Position;
  stopPrice: number;
  tpGains: readonly number[];
  trailActivationPct: number;
  trailDistancePct: number;
  maxHoldMin: number;
  balanceBeforeUsd: number;
  cashAfterUsd: number;
  openCount: number;
  maxOpen: number;
}

export function buildBuyMessage(r: BuyReport): string {
  const p = r.position;
  const lines = [
    `### 🟢 PAPER BUY — ${p.symbol || "UNKNOWN"}`,
    `🪙 ${p.tokenName || p.symbol} (${p.symbol}/${p.quoteSymbol})`,
    `${chainIcon(p.chain)} Chain: ${p.chain}  |  🏷️ DEX: ${p.dexId}`,
    `🔗 Pair: \`${p.pairAddress}\``,
    `🆔 CA: \`${p.tokenAddress}\``,
    ...(p.poolAddress ? [`🏊 Pool: \`${p.poolAddress}\``] : []),
    `💲 Entry: ${fmtPrice(p.entryPrice)}  |  📦 Size: ${fmtUsd(p.initialUsdSize)}`,
    `💧 Liquidity: ${fmtOptUsd(p.entryLiquidityUsd)}  |  ⏱️ Age at entry: ${p.entryAgeSec !== undefined ? `${Math.round(p.entryAgeSec)}s` : "—"}`,
    `🛡️ SL: ${fmtUsd(r.stopPrice)}  |  🎯 TP: ${r.tpGains.map((g) => `+${g}%`).join(" / ")}`,
    `🌀 Trail: +${r.trailActivationPct}% / ${r.trailDistancePct}%  |  ⏳ Max hold: ${r.maxHoldMin}m`,
    `💰 Balance before: ${fmtUsd(r.balanceBeforeUsd)}  |  Cash after reserve: ${fmtUsd(r.cashAfterUsd)}`,
    `📂 Open: ${r.openCount}/${r.maxOpen}`,
  ];
  if (p.pairUrl) lines.push(`[DexScreener](${p.pairUrl})`);
  return lines.join("\n");
}

export interface TpReport {
  position: Position;
  level: number;
  gainPct: number;
  sellPct: number;
  price: number;
  soldQty: number;
  proceedsUsd: number;
  equityUsd: number;
}

export function buildTpMessage(r: TpReport): string {
  const p = r.position;
  return [
    `### 💰 TP${r.level} — ${p.symbol} (${fmtPct(r.gainPct)})`,
    `${chainIcon(p.chain)} ${p.chain}  |  🏷️ ${p.dexId}  |  🔗 \`${p.pairAddress}\``,
    `💲 Price: ${fmtPrice(r.price)}`,
    `🤝 Sold: ${r.sellPct}% of original (${r.soldQty.toPrecision(6)} units) → ${fmtUsd(r.proceedsUsd)}`,
    `📈 Realized PnL: ${fmtSignedUsd(p.realizedPnlUsd)}  |  🧾 Total PnL: ${fmtSignedUsd(totalPnlUsd(p))} (${fmtPct(totalPnlPct(p))})`,
    `📦 Remaining: ${remainingPct(p).toFixed(1)}%`,
    `💰 Equity now: ${fmtUsd(r.equityUsd)}`,
  ].join("\n");
}

export function buildTrailActivatedMessage(position: Position, trailStop: number): string {
  return [
    `### 📈 TRAILING ACTIVATED — ${position.symbol}`,
    `${chainIcon(position.chain)} ${position.chain}  |  🏷️ ${position.dexId}`,
    `💲 Price: ${fmtPrice(position.currentPrice)}  |  🔝 High: ${fmtPrice(position.highestPrice)}`,
    `🌀 Trail stop now: ${fmtPrice(trailStop)}`,
    `📦 Remaining: ${remainingPct(position).toFixed(1)}%`,
  ].join("\n");
}

export function buildStopMovedMessage(position: Position, stopPrice: number): string {
  return [
    `### 🛟 STOP → BREAKEVEN — ${position.symbol}`,
    `${chainIcon(position.chain)} ${position.chain}  |  🏷️ ${position.dexId}`,
    `💲 Price: ${fmtPrice(position.currentPrice)}  |  🛡️ Stop now: ${fmtPrice(stopPrice)}`,
    `📦 Remaining: ${remainingPct(position).toFixed(1)}%`,
  ].join("\n");
}

export interface CloseReport {
  position: Position;
  snapshot: PortfolioSnapshot;
  chainStat: ChainStat;
  tokenTrades: number;
  tokenPnlUsd: number;
}

export function buildCloseMessage(r: CloseReport): string {
  const p = r.position;
  const pnlUsd = totalPnlUsd(p);
  const pnlPct = totalPnlPct(p);
  const outcome = pnlUsd > 0 ? "✅ WIN" : pnlUsd < 0 ? "❌ LOSS" : "➖ FLAT";
  const before = p.balanceBeforeUsd ?? NaN;
  const after = p.balanceAfterUsd ?? r.snapshot.equityUsd;
  const delta = Number.isFinite(before) ? after - before : pnlUsd;
  const holdMs = Math.max(0, (p.closedAt ?? Date.now()) - p.openedAt);
  const tpMarks = p.tpHit.map((hit, i) => (hit ? `TP${i + 1}✅` : `TP${i + 1}❌`)).join(" ");
  const chainWinRate = r.chainStat.trades === 0 ? 0 : (r.chainStat.wins / r.chainStat.trades) * 100;

  const lines = [
    `### ${exitBadge(p.closedReason)} — ${p.symbol} ${outcome}`,
    `🪙 ${p.tokenName || p.symbol} (${p.symbol}/${p.quoteSymbol})`,
    `${chainIcon(p.chain)} Chain: ${p.chain}  |  🏷️ DEX: ${p.dexId}`,
    `🔗 Pair: \`${p.pairAddress}\`  |  Token: \`${p.tokenAddress}\``,
    ...(p.poolAddress ? [`🏊 Pool: \`${p.poolAddress}\`  |  Quote: ${p.quoteSymbol}`] : []),
    `💲 Entry: ${fmtPrice(p.entryPrice)}  →  Exit: ${fmtPrice(p.currentPrice)}`,
    `💧 Liquidity: entry ${fmtOptUsd(p.entryLiquidityUsd)} → exit ${fmtOptUsd(p.exitLiquidityUsd)}  |  ⏱️ Age at entry: ${p.entryAgeSec !== undefined ? `${Math.round(p.entryAgeSec)}s` : "—"}`,
    `🔝 High: ${fmtPrice(p.highestPrice)}  |  🎯 TP: ${tpMarks}`,
    `📈 PnL: ${fmtSignedUsd(pnlUsd)} (${fmtPct(pnlPct)})`,
    `💸 Fees: ${fmtUsd(p.totalEntryFeeUsd + p.totalExitFeeUsd)}  |  🌊 Slippage: ${fmtUsd(p.totalSlippageUsd)}`,
    `💰 Balance: ${fmtUsd(before)} → ${fmtUsd(after)} (Δ ${fmtSignedUsd(delta)})`,
    `📦 Size: ${fmtUsd(p.initialUsdSize)}  |  ⏳ Duration: ${fmtDuration(holdMs)} (${fmtTime(p.openedAt)} → ${fmtTime(p.closedAt ?? Date.now())})`,
    `📊 Portfolio: #${r.snapshot.totalTrades}  |  Win ${r.snapshot.winRatePct.toFixed(1)}% (${r.snapshot.wins}W/${r.snapshot.losses}L)  |  Total ${fmtSignedUsd(r.snapshot.totalPnlUsd)}  |  Equity ${fmtUsd(r.snapshot.equityUsd)}`,
    `${chainIcon(p.chain)} ${p.chain}: ${r.chainStat.trades} trades, ${chainWinRate.toFixed(1)}% win, ${fmtSignedUsd(r.chainStat.pnlUsd)}`,
    `🪙 ${p.symbol} on ${p.chain}: ${r.tokenTrades} trades, ${fmtSignedUsd(r.tokenPnlUsd)}`,
  ];
  if (p.pairUrl) lines.push(`[DexScreener](${p.pairUrl})`);
  return lines.join("\n");
}

export function buildStartupMessage(args: {
  mode: string;
  chains: string[];
  discoveryMs: number;
  priceMs: number;
  autoEntry: boolean;
  positionSizeUsd: number;
  initialBalanceUsd: number;
  maxPositions: number;
  coingeckoWired: boolean;
  analytics?: string;
}): string {
  return [
    "### 🤖 BOT STARTED",
    `📝 Mode: ${args.mode}  |  🚪 Auto entry: ${args.autoEntry}`,
    `⛓️ Chains (${args.chains.length}): ${args.chains.join(", ")}`,
    `🔎 Discovery: ${args.discoveryMs}ms  |  💲 Price: ${args.priceMs}ms`,
    `💰 Initial balance: ${fmtUsd(args.initialBalanceUsd)}  |  📦 Pos size: ${fmtUsd(args.positionSizeUsd)}`,
    `📂 Max positions: ${args.maxPositions}`,
    `🔑 CoinGecko key: ${args.coingeckoWired ? "wired (enrichment only)" : "absent"}  |  Discovery: DexPaprika`,
    ...(args.analytics ? [`📊 Analytics: ${args.analytics}`] : []),
  ].join("\n");
}
