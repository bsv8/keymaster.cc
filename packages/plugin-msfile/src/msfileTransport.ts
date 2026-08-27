// packages/plugin-msfile/src/msfileTransport.ts
// Window executor 的传输接缝。
//
// 施工单 2026-08-26/001：remote signer / Window executor 架构 Spike PASS 前，
// 正式 libp2p runtime 不得施工。本文件冻结 executor 必须实现的接口；默认实现
// fail closed（msfile_unavailable）。Spike PASS 后按 002 施工真实 Window executor，
// Safari、公共 WSS 和目标 NAS 只属于 003 发布门禁，不阻止 runtime 编码。

import type { MsFileContentKind, MsFileSupplierConfig, MsFileSupplierProbeResult, MsFileSupplierStat } from "@keymaster/contracts";

export interface MsFileTransportReadInput {
  supplier: MsFileSupplierConfig;
  kind: MsFileContentKind;
  hashHex: string;
  /** 已解析的金额上限；"0" 表示显式不限。 */
  maxPriceSatoshis: bigint;
  /** 发起时的供应商配置世代；executor 用它丢弃旧世代连接上的迟到结果。 */
  supplierGeneration: number;
  signal?: AbortSignal;
}

export type MsFileTransportReadOutcome =
  | { type: "ok"; content: Uint8Array }
  | { type: "price-limit-exceeded" };

export interface MsFileTransportStatInput {
  supplier: MsFileSupplierConfig;
  seedHashHex: string;
  /** 发起时的供应商配置世代；executor 用它丢弃旧世代连接上的迟到结果。 */
  supplierGeneration: number;
  signal?: AbortSignal;
}

export interface MsFileTransportProbeInput {
  supplier: MsFileSupplierConfig;
  supplierGeneration: number;
  signal?: AbortSignal;
}

/**
 * executor 职责：拨号、身份 pin、Frame codec、背压与 hash/尺寸校验。
 *
 * 审查修复：invalidateSupplier 改为必选异步方法——配置写提交后 Coordinator
 * 必须等到旧连接与未决请求被关闭；实现不得静默吞错。
 */
export interface MsFileTransport {
  readonly available: boolean;
  stat(input: MsFileTransportStatInput): Promise<MsFileSupplierStat>;
  read(input: MsFileTransportReadInput): Promise<MsFileTransportReadOutcome>;
  probe(input: MsFileTransportProbeInput): Promise<MsFileSupplierProbeResult>;
  dispose(): void;
  /**
   * 配置世代推进时关闭指定供应商的旧连接并终止其未决请求。
   * supplierPublicKeyHex 为 undefined 表示全量失效。解析后的 Promise
   * 表示"旧连接已关闭"；失败必须向上传播，不得吞掉。
   */
  invalidateSupplier(supplierPublicKeyHex: string | undefined, generation: number): Promise<void>;
}

/** 架构 Spike/生产 Runtime 尚未就绪时的默认实现：一切数据面请求 fail closed。 */
export function createUnavailableMsFileTransport(reason = "MSFile runtime is not available yet"): MsFileTransport {
  const fail = (): never => {
    throw Object.assign(new Error(reason), { code: "msfile_unavailable" });
  };
  return {
    available: false,
    stat: () => Promise.reject(fail()),
    read: () => Promise.reject(fail()),
    probe: () => Promise.reject(fail()),
    dispose: () => undefined,
    invalidateSupplier: () => Promise.resolve(),
  };
}
