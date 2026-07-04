// packages/plugin-protocol/src/protocolCbor.ts
// Deterministic CBOR (RFC 8949 §4.2.1) 编码/解码 — protocol 层薄包装。
//
// 设计缘由（施工单 2026-07-04 004 §8.4）：
//   - 本文件**不再**自维护 CBOR 实现；底层 delegate 到
//     `packages/contracts/src/cbor.ts`（cborg library + RFC 8949 options）；
//   - 保留本文件作为 protocol 层"编码原语"单一入口：业务侧不直接 import
//     contracts/cbor；通过 `protocolCbor.ts` 拿到稳定 API；
//   - 编码策略 = RFC 8949 §4.2.1（最短数值编码 + map 按 bytewise 字典序）。
//
// 业务调用约束：
//   - identity envelope / signedEnvelope / cipher 内层结构**必须**用本
//     文件的 `cborEncode`，保证调用方拿到的 `*.bytes` 是最终真值字节；
//   - 解码必须用 `cborDecode`，**不**直接调 cborg；
//   - 任意 `CborValue` 必须落到白名单（uint / int / string / bytes /
//     array / map / null / bool）——其它类型（bigint / float / undefined）
//     走 cborg 抛错；这里**不**做二次封装。

export {
  cborEncode,
  cborDecode,
  type CborValue,
  type CborMap
} from "@keymaster/contracts";