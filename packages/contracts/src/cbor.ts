// packages/contracts/src/cbor.ts
// 共享 Deterministic CBOR (RFC 8949 §4.2.1) 编码/解码原语。
//
// 设计缘由（施工单 2026-07-04 004 硬切换）：
//   - 本文件是 platform 共享原语，**不**再属于 plugin-protocol 私有；
//   - 三个 plugin（protocol / appmsg / hubmsg）都需要 deterministic
//     CBOR：identity envelope / signedEnvelope / cipher 内层结构 +
//     `AppMsgEnvelopeV1` + `HubFrame` + `SignedAppMsgEnvelopeV1` 都依赖
//     同一份编码真值；
//   - **不再**继续演化为项目自维护 CBOR 实现（施工单 §8.4）——底层
//     delegate 到成熟 `cborg` 库；
//   - 编码策略固定为 RFC 8949 §4.2.1（core deterministic）：最短数值编码 +
//     map 按 bytewise 字典序排序（施工单 §2.3 锁死"固定顺序数组，不用 map"，
//     业务数据只用 array，所以 map sort 仅在 cipher / identity 等仍用 map
//     的旧字段时生效）；
//   - 数组元素保持插入顺序——业务真值（envelope / frame body / signed
//     envelope）全部是 array 形态；
//   - `Uint8Array` 走 CBOR byte string（major type 2）；其它基本类型走
//     标准 CBOR 编码。

import { decode, encode, rfc8949EncodeOptions } from "cborg";

/** CBOR 编码输入：与 cborg 兼容的纯基础类型。 */
export type CborValue =
  | number // 仅支持整数（cborg 会拒绝非有限数）
  | string
  | Uint8Array
  | CborValue[]
  | CborMap
  | null
  | boolean;

export type CborMap = { [key: string]: CborValue };

/**
 * 编码入口：返回 deterministic CBOR 字节。
 *
 * 使用 cborg + `rfc8949EncodeOptions`（RFC 8949 §4.2.1）。
 * 任何非数组 / 非字节 / 非基础类型的输入都会被 cborg 拒绝。
 */
export function cborEncode(value: CborValue): Uint8Array {
  return encode(value, rfc8949EncodeOptions);
}

/**
 * 解码入口：返回原始 CBOR 解码结果。
 *
 * cborg 默认把 map 解码为 `Map` 对象；本接口**始终**返回 plain object
 * 以兼容上游已有调用方，避免 map 顺序 / Map 类型不一致。
 */
export function cborDecode(bytes: Uint8Array): CborValue {
  const v = decode(bytes);
  if (v instanceof Map) {
    return mapToObject(v);
  }
  return v as CborValue;
}

function mapToObject(m: Map<unknown, unknown>): CborMap {
  const out: CborMap = {};
  for (const [k, v] of m) {
    if (typeof k !== "string") {
      throw new Error("CBOR: only string-keyed maps are supported");
    }
    out[k] = normalizeDecoded(v);
  }
  return out;
}

function normalizeDecoded(v: unknown): CborValue {
  if (v instanceof Map) return mapToObject(v);
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) {
    return v.map((item) => normalizeDecoded(item));
  }
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") return v;
  // cborg 在 default decode 下 bigint 会抛错（allowBigInt=false），此处
  // 不应出现；保留兜底抛错。
  throw new Error(`CBOR: unsupported decoded value type ${typeof v}`);
}