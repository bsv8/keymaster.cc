import { defineCapability } from "webloom-framework";
import type { MarketPendingItem } from "./marketTypes.js";
/** 快照中单个市场的同步记录。 */
export interface MarketRecordSnapshot {
  id: string;
  name: string;
  directoryUrl: string;
  builtIn: boolean;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastRejected: Array<{ sourceId: string; appPublicKeyHex: string; status: string; reason?: string }>;
}
export interface MarketWorkerSnapshot {
  revision: number;
  markets: MarketRecordSnapshot[];
  pending: MarketPendingItem[];
  manual: MarketPendingItem[];
  appliedMarketCount: number;
}
export type MarketWorkerCommand =
  | { type: "snapshot" }
  | { type: "sync-now"; marketId?: string }
  | { type: "configure-market"; name: string; directoryUrl: string }
  | { type: "discard-market"; marketId: string }
  | { type: "add-manual"; url: string }
  | { type: "update-manual"; pendingId: string; url: string }
  | { type: "retry"; pendingId: string }
  | { type: "remove"; pendingId: string };
export interface MarketWorkerResponse { snapshot: MarketWorkerSnapshot; value?: unknown }
function command(value: unknown): MarketWorkerCommand {
  if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") throw new TypeError("Invalid Market command");
  return structuredClone(value) as MarketWorkerCommand;
}
export const MARKET_PRIVATE_COMMAND = defineCapability<MarketWorkerCommand, MarketWorkerResponse>({ kind: "rpc", id: "market.private.command", version: "1", request: { parse: command }, response: { parse: value => value as MarketWorkerResponse } });
export const MARKET_PRIVATE_EVENTS = defineCapability<Record<string, never>, { type: "state"; snapshot: MarketWorkerSnapshot }>({ kind: "stream", id: "market.private.events", version: "1", request: { parse: () => ({}) }, item: { parse: value => value as { type: "state"; snapshot: MarketWorkerSnapshot } } });
