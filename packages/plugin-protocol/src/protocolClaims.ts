// packages/plugin-protocol/src/protocolClaims.ts
// claim 解析、签名投影、resolvedClaims 组装。
//
// 设计缘由（施工单 001）：
//   - V1 协议只把已有真值来源的 claim 暴露出去。本次至少支持 `key.label`。
//   - 不存在的 claim 直接省略，不报错。
//   - 签名投影排序：按 claim 名 bytewise 字典序。
//   - 二进制 claim 投影：["binary", mime, sha256(bytes)]，mime 缺省时
//     投影第二项写空字符串。
//   - resolvedClaims 是业务可消费的真值；二进制 claim 返回本体。
//   - 不为 V1 发明 "claim provider registry" 平台能力。新的 claim 真值
//     来源应当直接在这里加表项；不要给 V2 提前开洞。

import type {
  IdentityGetParams,
  ResolvedClaimValue
} from "@keymaster/contracts";
import { sha256Bytes } from "./protocolCrypto.js";

/** claim 名 -> 真值获取器。返回 undefined 表示本地无此 claim。 */
export type ClaimResolver = (name: string) => ResolvedClaimValue | undefined;

/**
 * 内置 claim 真值来源。本次只把 `key.label` 暴露出去。
 *
 * 后续要新增 claim：在下面 case 列表里加一个分支，从 `context` 读取
 * 真值并返回；不要顺手造 provider registry。
 */
export interface BuiltinClaimContext {
  /** 当前 active key 的 label。 */
  activeKeyLabel: string | undefined;
  /**
   * 保留字段：未来要支持 `profile.avatar.image` 等二进制 claim 时，
   * 真正的二进制值从这里拿；当前 V1 固定为空。
   */
  binaryClaims?: Record<string, Uint8Array | undefined>;
}

/** 协议内建 claim 真值解析。 */
export function resolveBuiltinClaim(
  name: string,
  context: BuiltinClaimContext
): ResolvedClaimValue | undefined {
  switch (name) {
    case "key.label": {
      if (!context.activeKeyLabel) return undefined;
      return context.activeKeyLabel;
    }
    default:
      return undefined;
  }
}

/**
 * 解析 `params.claims` 与 `resolver`，组装 `resolvedClaims`。
 *
 * 约束：
 *   - `resolver` 对每个请求里点名要、但当前不存在的 claim 返回 undefined；
 *   - `resolvedClaims` 中**不**包含 undefined 字段；
 *   - 列表里点名但本地不存在的 claim 直接省略，不抛错。
 */
export function resolveClaims(
  requested: string[] | undefined,
  resolver: ClaimResolver
): Record<string, ResolvedClaimValue> {
  const out: Record<string, ResolvedClaimValue> = {};
  if (!requested) return out;
  for (const name of requested) {
    const val = resolver(name);
    if (val === undefined) continue;
    out[name] = val;
  }
  return out;
}

/**
 * 构造签名投影列表。
 *
 * 输入：
 *   - resolvedClaims：本次实际返回给调用方的 claim 真值；
 *   - binaryAccessor：可选。对二进制 claim，签名投影需要 sha256(bytes)；
 *     业务层在 service 里把 BinaryField -> Uint8Array 映射提供。
 *
 * 输出：按 claim 名 bytewise 字典序排序的二元组列表。
 */
export function buildClaimProjection(
  resolvedClaims: Record<string, ResolvedClaimValue>,
  binaryAccessor?: (value: ResolvedClaimValue) => Uint8Array | undefined,
  mimeAccessor?: (value: ResolvedClaimValue) => string | undefined
): CborProjectionEntry[] {
  const entries: { key: string; keyBytes: Uint8Array; val: CborProjectionEntry[1] }[] = [];
  for (const name of Object.keys(resolvedClaims)) {
    const raw = resolvedClaims[name] as ResolvedClaimValue;
    if (raw && typeof raw === "object" && raw instanceof Uint8Array) {
      // 业务层通常把 binary claim 表达为 { $type: "binary", bytes, mime }；
      // ResolvedClaimValue 是 union 包含 BinaryField；这里用运行时类型
      // 守卫兜底 Uint8Array。
      const bytes = binaryAccessor?.(raw);
      if (bytes) {
        const mime = mimeAccessor?.(raw) ?? "";
        const digest = sha256Bytes(bytes);
        entries.push({ key: name, keyBytes: new TextEncoder().encode(name), val: ["binary", mime, digest] });
        continue;
      }
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw) && "$type" in raw) {
      // BinaryField
      const field = raw as { $type: string; bytes: ArrayBuffer; mime?: string };
      if (field.$type === "binary") {
        const bytes = binaryAccessor?.(raw);
        if (bytes) {
          const mime = mimeAccessor?.(raw) ?? field.mime ?? "";
          const digest = sha256Bytes(bytes);
          entries.push({ key: name, keyBytes: new TextEncoder().encode(name), val: ["binary", mime, digest] });
          continue;
        }
      }
    }
    entries.push({ key: name, keyBytes: new TextEncoder().encode(name), val: raw });
  }
  entries.sort((a, b) => compareBytes(a.keyBytes, b.keyBytes));
  return entries.map((e) => [e.key, e.val]);
}

export type CborProjectionEntry = [string, unknown];

/** 入口：业务层只需要把 ResolvedClaimValue union 转成 bytewise 字典序的投影列表。 */
export function buildClaimProjectionFromParams(
  params: IdentityGetParams,
  context: BuiltinClaimContext
): {
  resolvedClaims: Record<string, ResolvedClaimValue>;
  projection: CborProjectionEntry[];
} {
  const resolvedClaims = resolveClaims(params.claims, (name) =>
    resolveBuiltinClaim(name, context)
  );
  const projection = buildClaimProjection(resolvedClaims);
  return { resolvedClaims, projection };
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const diff = (a[i] as number) - (b[i] as number);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}
