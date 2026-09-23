import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ClosedTrade } from "./portfolio.ts";
import type { Position } from "./types.ts";

export const STATE_VERSION = 1;

export interface BotState {
  version: number;
  savedAt: number;
  cashUsd: number;
  closedTrades: ClosedTrade[];
  openPositions: Position[];
}

export function defaultState(): BotState {
  return { version: STATE_VERSION, savedAt: 0, cashUsd: NaN, closedTrades: [], openPositions: [] };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidClosedTrade(value: unknown): value is ClosedTrade {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.chain === "string" &&
    typeof t.symbol === "string" &&
    typeof t.dexId === "string" &&
    isFiniteNumber(t.pnlUsd) &&
    isFiniteNumber(t.pnlPct) &&
    typeof t.reason === "string" &&
    isFiniteNumber(t.durationMs) &&
    isFiniteNumber(t.openedAt) &&
    isFiniteNumber(t.closedAt)
  );
}

function isValidOpenPosition(value: unknown): value is Position {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    p.id.length > 0 &&
    typeof p.chain === "string" &&
    typeof p.pairAddress === "string" &&
    p.pairAddress.length > 0 &&
    typeof p.tokenAddress === "string" &&
    typeof p.symbol === "string" &&
    p.status === "OPEN" &&
    isFiniteNumber(p.entryPrice) &&
    (p.entryPrice as number) > 0 &&
    isFiniteNumber(p.currentPrice) &&
    isFiniteNumber(p.highestPrice) &&
    isFiniteNumber(p.quantity) &&
    (p.quantity as number) > 0 &&
    isFiniteNumber(p.originalQuantity) &&
    (p.originalQuantity as number) > 0 &&
    isFiniteNumber(p.initialUsdSize) &&
    (p.initialUsdSize as number) > 0 &&
    isFiniteNumber(p.realizedPnlUsd) &&
    isFiniteNumber(p.openedAt) &&
    typeof p.trailingActive === "boolean" &&
    typeof p.breakevenArmed === "boolean" &&
    Array.isArray(p.tpHit) &&
    (p.tpHit as unknown[]).length === 3
  );
}

/**
 * Load persisted bot state. Missing, unreadable, or corrupt files yield a
 * default (empty) state — the bot always boots. Invalid entries are dropped.
 */
export function loadState(path: string): BotState {
  const fallback = defaultState();
  if (!existsSync(path)) return fallback;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<BotState>;
    if (typeof parsed !== "object" || parsed === null) return fallback;
    return {
      version: STATE_VERSION,
      savedAt: isFiniteNumber(parsed.savedAt) ? parsed.savedAt : 0,
      cashUsd: isFiniteNumber(parsed.cashUsd) ? parsed.cashUsd : NaN,
      closedTrades: Array.isArray(parsed.closedTrades)
        ? parsed.closedTrades.filter(isValidClosedTrade)
        : [],
      openPositions: Array.isArray(parsed.openPositions)
        ? parsed.openPositions.filter(isValidOpenPosition)
        : [],
    };
  } catch {
    return fallback;
  }
}

/** Persist state atomically (tmp file + rename) so crashes never leave halves. */
export function saveState(path: string, state: BotState): void {
  mkdirSync(dirname(path), { recursive: true });
  const payload: BotState = { ...state, version: STATE_VERSION, savedAt: Date.now() };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload), "utf8");
  renameSync(tmp, path);
}
