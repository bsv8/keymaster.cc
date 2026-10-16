import { decode } from "cborg";
import { parseAs } from "go-bitfs";
import type { BitfsArbitrationInfo } from "./arbitrationClient.js";

/** 费率来自认证 info，价格属于服务配置；Seed、尾块、完整块都是一个条目。 */
export function arbitrationFeeForItems(info: BitfsArbitrationInfo, count: number): bigint {
  if (info.unit !== "content-item" || !Number.isSafeInteger(info.baseSat) || info.baseSat < 1
    || !Number.isSafeInteger(info.perItemSat) || info.perItemSat < 0) throw new Error("仲裁服务条目费率无效");
  if (!Number.isSafeInteger(count) || count < 1 || count > 64) throw new Error("仲裁内容条目数必须为 1–64");
  return BigInt(info.baseSat) + BigInt(count) * BigInt(info.perItemSat);
}

/** SDK 先严格解析 Kind 8；只统计实际载荷数组，不使用字节数或卖方批次上限。 */
export function arbitrationContentItemCount(rawKind8: Uint8Array): number {
  const raw = parseAs(8, rawKind8).bytes();
  const outer = decode(raw) as unknown[];
  const payloads: unknown = decode(outer[4] as Uint8Array);
  if (!Array.isArray(payloads) || payloads.length < 1 || payloads.length > 64) throw new Error("仲裁载荷条目数无效");
  return payloads.length;
}
