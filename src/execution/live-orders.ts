import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Phase 1.3 — pending-order journal. Every live order moves
 * SIGNAL → SUBMITTED → CONFIRMED (or FAILED, terminal). If the process
 * dies between states, startup reconciliation resolves each order from
 * the chain rather than assuming anything — so every transition is
 * persisted atomically (tmp + rename) the moment it happens.
 */

export type LiveOrderStatus = "SIGNAL" | "SUBMITTED" | "CONFIRMED" | "FAILED";

export interface LiveOrder {
  positionId: string;
  chain: string;
  side: "BUY" | "SELL";
  /**
   * Fill label distinguishing multiple sells per position ("TP1", "EXIT").
   * Absent on older orders and one-shot flows (live test) — treated as "".
   */
  label?: string;
  status: LiveOrderStatus;
  /** On-chain signature once submitted; null while still a signal. */
  signature: string | null;
  createdAt: number;
  updatedAt: number;
  note?: string;
  /**
   * Optional routing context for chain-specific recovery (EVM receipt
   * fill parsing needs the token pair). Absent on older/strategy orders.
   */
  meta?: {
    sellToken?: string;
    buyToken?: string;
    sellAmountBaseUnits?: string;
  };
}

const TRANSITIONS: Record<LiveOrderStatus, LiveOrderStatus[]> = {
  SIGNAL: ["SUBMITTED", "FAILED"],
  SUBMITTED: ["CONFIRMED", "FAILED"],
  CONFIRMED: [],
  FAILED: [],
};

function isLiveOrder(value: unknown): value is LiveOrder {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  const meta = o.meta as Record<string, unknown> | undefined;
  const metaOk =
    meta === undefined ||
    (typeof meta === "object" &&
      meta !== null &&
      (meta.sellToken === undefined || typeof meta.sellToken === "string") &&
      (meta.buyToken === undefined || typeof meta.buyToken === "string") &&
      (meta.sellAmountBaseUnits === undefined || typeof meta.sellAmountBaseUnits === "string"));
  return (
    typeof o.positionId === "string" &&
    o.positionId.length > 0 &&
    typeof o.chain === "string" &&
    (o.side === "BUY" || o.side === "SELL") &&
    (o.label === undefined || typeof o.label === "string") &&
    (o.status === "SIGNAL" ||
      o.status === "SUBMITTED" ||
      o.status === "CONFIRMED" ||
      o.status === "FAILED") &&
    (o.signature === null || typeof o.signature === "string") &&
    typeof o.createdAt === "number" &&
    typeof o.updatedAt === "number" &&
    metaOk
  );
}

export function defaultOrdersPath(): string {
  return process.env.LIVE_ORDERS_FILE ?? "data/live-orders.json";
}

/** Load the journal. Missing/corrupt files yield an empty journal — boot never fails. */
export function loadLiveOrders(path: string = defaultOrdersPath()): LiveOrder[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const list = Array.isArray(parsed) ? parsed : (parsed as { orders?: unknown }).orders;
    if (!Array.isArray(list)) return [];
    return list.filter(isLiveOrder);
  } catch {
    return [];
  }
}

/** Persist the whole journal atomically. Callers pass the full in-memory list. */
export function saveLiveOrders(orders: LiveOrder[], path: string = defaultOrdersPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: Date.now(), orders }), "utf8");
  renameSync(tmp, path);
}

/** Orders neither confirmed nor failed — the startup-reconciliation worklist. */
export function openOrders(orders: LiveOrder[]): LiveOrder[] {
  return orders.filter((o) => o.status === "SIGNAL" || o.status === "SUBMITTED");
}

function transition(
  orders: LiveOrder[],
  positionId: string,
  side: "BUY" | "SELL",
  to: LiveOrderStatus,
  patch: Partial<LiveOrder> = {},
): LiveOrder[] {
  const now = Date.now();
  const label = patch.label ?? "";
  const idx = orders.findIndex(
    (o) => o.positionId === positionId && o.side === side && (o.label ?? "") === label,
  );
  if (idx === -1) {
    // Fresh journal entry. Only SIGNAL may be created from nothing —
    // anything else means the caller lost track of an order (fail closed).
    if (to !== "SIGNAL") {
      throw new Error(`No ${side} order for ${positionId}: cannot transition to ${to}`);
    }
    return [...orders, { positionId, chain: patch.chain ?? "", side, label, status: to, signature: null, createdAt: now, updatedAt: now, ...patch }];
  }
  const current = orders[idx]!;
  if (!TRANSITIONS[current.status].includes(to)) {
    throw new Error(`Illegal order transition ${current.status} → ${to} for ${positionId}`);
  }
  const next = [...orders];
  next[idx] = { ...current, ...patch, status: to, updatedAt: now };
  return next;
}

export function recordSignal(
  orders: LiveOrder[],
  input: {
    positionId: string;
    chain: string;
    side: "BUY" | "SELL";
    label?: string;
    meta?: LiveOrder["meta"];
  },
): LiveOrder[] {
  return transition(orders, input.positionId, input.side, "SIGNAL", {
    chain: input.chain,
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.meta !== undefined ? { meta: input.meta } : {}),
  });
}

export function markSubmitted(
  orders: LiveOrder[],
  positionId: string,
  side: "BUY" | "SELL",
  signature: string,
  label = "",
): LiveOrder[] {
  if (!signature) throw new Error("markSubmitted needs the on-chain signature");
  return transition(orders, positionId, side, "SUBMITTED", { signature, label });
}

export function markConfirmed(
  orders: LiveOrder[],
  positionId: string,
  side: "BUY" | "SELL",
  label = "",
): LiveOrder[] {
  return transition(orders, positionId, side, "CONFIRMED", { label });
}

export function markFailed(
  orders: LiveOrder[],
  positionId: string,
  side: "BUY" | "SELL",
  note: string,
  label = "",
): LiveOrder[] {
  return transition(orders, positionId, side, "FAILED", { note, label });
}

/**
 * Reopen a terminal FAILED order as a fresh SIGNAL for the exit manager's
 * retry loop (boot catch-up after a crash mid-execute). Only FAILED orders
 * reopen — every other state keeps its terminality.
 */
export function retrySignal(
  orders: LiveOrder[],
  positionId: string,
  side: "BUY" | "SELL",
  label = "",
  note = "",
): LiveOrder[] {
  const idx = orders.findIndex(
    (o) => o.positionId === positionId && o.side === side && (o.label ?? "") === label,
  );
  if (idx === -1) throw new Error(`No ${side} order for ${positionId}: cannot retry`);
  const current = orders[idx]!;
  if (current.status !== "FAILED") {
    throw new Error(`Only FAILED orders can retry (is ${current.status}) for ${positionId}`);
  }
  const next = [...orders];
  next[idx] = {
    ...current,
    status: "SIGNAL",
    signature: null,
    updatedAt: Date.now(),
    ...(note ? { note } : {}),
  };
  return next;
}
