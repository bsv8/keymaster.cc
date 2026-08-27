// Coordinator 侧的生产 transport proxy。
//
// 该模块不导入 libp2p/WebRTC，因此可以安全地被 SharedWorker 加载。真正的
// host 只存在于 Window executor；这里把受限 operation 转成专用 bridge RPC，
// 并把远端返回的 Uint8Array 交给 MsFileService 做最终 hash/尺寸校验。

import type {
  MsFileSupplierConfig,
  MsFileSupplierProbeResult,
  MsFileSupplierStat,
} from "@keymaster/contracts";
import type {
  MsFileTransport,
  MsFileTransportProbeInput,
  MsFileTransportReadInput,
  MsFileTransportReadOutcome,
  MsFileTransportStatInput,
} from "./msfileTransport.js";

export type MsFileExecutorOperation =
  | { type: "stat"; /** 供应商配置。 */ supplier: MsFileSupplierConfig; /** Seed 的 64 位 hex 哈希。 */ seedHashHex: string; /** 发起时的供应商配置世代。 */ supplierGeneration: number }
  | { type: "read"; /** 供应商配置。 */ supplier: MsFileSupplierConfig; /** 内容种类：seed 或 block。 */ kind: MsFileTransportReadInput["kind"]; /** 内容的 64 位 hex 哈希。 */ hashHex: string; /** 十进制聪上限。 */ maxPriceSatoshis: string; /** 发起时的供应商配置世代。 */ supplierGeneration: number }
  | { type: "probe"; /** 供应商配置。 */ supplier: MsFileSupplierConfig; /** 发起时的供应商配置世代。 */ supplierGeneration: number }
  | { type: "invalidate"; /** 要失效的供应商公钥；省略表示全部。 */ supplierPublicKeyHex?: string; /** 新的配置世代。 */ generation: number };

export interface MsFileExecutorBridge {
  /** 当前 Window executor 是否已取得 lease 且 host 可用。 */
  readonly available: boolean;
  /** 向 Window executor 发送一个受限数据面操作。 */
  request(operation: MsFileExecutorOperation, signal?: AbortSignal): Promise<unknown>;
  /** 释放 bridge 资源；调用可幂等。 */
  dispose?(): void;
}

function asStat(value: unknown): MsFileSupplierStat {
  if (!value || typeof value !== "object") throw new Error("executor returned an invalid Stat result");
  return value as MsFileSupplierStat;
}

function asRead(value: unknown): MsFileTransportReadOutcome {
  if (!value || typeof value !== "object" || !(["ok", "integrity-failed", "price-limit-exceeded", "supplier-error", "cancelled", "transport-failed"] as unknown[]).includes((value as { type?: unknown }).type)) {
    throw new Error("executor returned an invalid Read result");
  }
  if ((value as { type: string }).type === "ok" && !((value as { content?: unknown }).content instanceof Uint8Array)) {
    throw new Error("executor returned invalid Read content");
  }
  if ((value as { type: string }).type === "supplier-error" && !/^[a-z0-9_]{1,64}$/.test(String((value as { errorCode?: unknown }).errorCode ?? ""))) {
    throw new Error("executor returned invalid supplier error code");
  }
  return value as MsFileTransportReadOutcome;
}

function asProbe(value: unknown): MsFileSupplierProbeResult {
  if (!value || typeof value !== "object") throw new Error("executor returned an invalid probe result");
  return value as MsFileSupplierProbeResult;
}

/** 将 Window executor bridge 适配为既有 MsFileTransport 契约。 */
export function createMsFileExecutorTransport(bridge: MsFileExecutorBridge): MsFileTransport {
  return {
    get available() {
      return bridge.available;
    },
    async stat(input: MsFileTransportStatInput): Promise<MsFileSupplierStat> {
      return asStat(await bridge.request({
        type: "stat",
        supplier: input.supplier,
        seedHashHex: input.seedHashHex,
        supplierGeneration: input.supplierGeneration,
      }, input.signal));
    },
    async read(input: MsFileTransportReadInput): Promise<MsFileTransportReadOutcome> {
      return asRead(await bridge.request({
        type: "read",
        supplier: input.supplier,
        kind: input.kind,
        hashHex: input.hashHex,
        maxPriceSatoshis: input.maxPriceSatoshis.toString(10),
        supplierGeneration: input.supplierGeneration,
      }, input.signal));
    },
    async probe(input: MsFileTransportProbeInput): Promise<MsFileSupplierProbeResult> {
      return asProbe(await bridge.request({
        type: "probe",
        supplier: input.supplier,
        supplierGeneration: input.supplierGeneration,
      }, input.signal));
    },
    dispose: () => bridge.dispose?.(),
    invalidateSupplier: async (supplierPublicKeyHex, generation) => {
      if (!bridge.available) return;
      await bridge.request({ type: "invalidate", supplierPublicKeyHex, generation });
    },
  };
}
