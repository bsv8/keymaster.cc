import { defineCapability } from "webloom-framework";
import type { BsvNetwork } from "./vault.js";

/** 公共建议值与用户选择分离；刷新永远不覆盖手动模式。单位统一 sat/KB。 */
export type ChainFeePolicy = { mode: "automatic" } | { mode: "manual"; satoshisPerKb: number };
export type ChainFeePolicies = Record<BsvNetwork, ChainFeePolicy>;
export interface WocFeeRecommendation {
  fee_unit: "sat/KB";
  fee: number;
  mempool_min_fee: number;
}
export interface ChainFeeSnapshot {
  network: BsvNetwork;
  policy: ChainFeePolicy;
  effectiveSatoshisPerKb: number;
  source: "woc" | "manual" | "fallback";
  recommendation?: WocFeeRecommendation;
  updatedAtMs?: number;
  lastAttemptAtMs?: number;
  error?: string;
}
export type ChainFeeSnapshots = Record<BsvNetwork, ChainFeeSnapshot>;
export const CHAIN_FEE_SYNC_TASK_ID = "chain.fee-sync";
export const CHAIN_FEE_FALLBACK_SATOSHIS_PER_KB = 100;
export function defaultChainFeePolicies(): ChainFeePolicies {
  return { main: { mode: "automatic" }, test: { mode: "automatic" } };
}
export function parseChainFeePolicy(value: unknown): ChainFeePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid fee policy");
  const policy = value as Record<string, unknown>;
  if (policy.mode === "automatic" && Object.keys(policy).length === 1) return { mode: "automatic" };
  if (policy.mode === "manual" && Object.keys(policy).length === 2 && Number.isSafeInteger(policy.satoshisPerKb) && Number(policy.satoshisPerKb) > 0) return { mode: "manual", satoshisPerKb: Number(policy.satoshisPerKb) };
  throw new TypeError("Invalid fee policy");
}
export function parseWocFeeRecommendation(value: unknown): WocFeeRecommendation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid WoC fee recommendation");
  const row = value as Record<string, unknown>;
  // SDK 只接受整数 sat/KB；不静默更换单位或把无效建议降为零费率。
  if (row.fee_unit !== "sat/KB" || !Number.isSafeInteger(row.fee) || Number(row.fee) < 1
    || typeof row.mempool_min_fee !== "number" || !Number.isFinite(row.mempool_min_fee) || row.mempool_min_fee < 0) throw new TypeError("Invalid WoC fee recommendation");
  return { fee_unit: "sat/KB", fee: Number(row.fee), mempool_min_fee: row.mempool_min_fee };
}
export function resolveChainFeeSnapshot(network: BsvNetwork, policy: ChainFeePolicy, previous?: ChainFeeSnapshot): ChainFeeSnapshot {
  const recommendation = previous?.recommendation;
  return { ...previous, network, policy: { ...policy }, effectiveSatoshisPerKb: policy.mode === "manual" ? policy.satoshisPerKb : recommendation?.fee ?? CHAIN_FEE_FALLBACK_SATOSHIS_PER_KB,
    source: policy.mode === "manual" ? "manual" : recommendation ? "woc" : "fallback" };
}
export function emptyChainFeeSnapshots(): ChainFeeSnapshots {
  return { main: resolveChainFeeSnapshot("main", { mode: "automatic" }), test: resolveChainFeeSnapshot("test", { mode: "automatic" }) };
}
/** 纯内存读取；所有网络 I/O 交由中心后台调度。 */
export interface ChainFeeReader {
  get(): ChainFeeSnapshot;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}
export const CHAIN_FEE_READER_CAPABILITY = defineCapability<ChainFeeReader>({ kind: "local", id: "chain-fee.reader", version: "1" });

/** Policy writes are granted separately from the shared read-only fee snapshot. */
export interface ChainFeePolicyWriter {
  setPolicy(policy: ChainFeePolicy): Promise<void>;
}
export const CHAIN_FEE_POLICY_WRITER_CAPABILITY = defineCapability<ChainFeePolicyWriter>({ kind: "local", id: "chain-fee.policy-writer", version: "1" });
