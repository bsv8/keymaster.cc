// 受保护 outpoint 契约。
//
// 设计缘由：
//   - 协议 plugin 可以声明某些 outpoint 不能被 plain funding 选中；
//   - runtime 只负责聚合和查询，不解释协议语义；
//   - 选择 funding input 的服务必须先查询该 registry，再做普通 BSV 选币。

import { defineCapability } from "webloom-framework";
import type { BsvNetwork } from "./vault.js";

/** 被保护的 outpoint。 */
export interface ProtectedOutpoint {
  txid: string;
  vout: number;
  network: BsvNetwork;
  /** 声明该 outpoint 的 owner plugin id。 */
  ownerPluginId: string;
  /** 可选说明，用于诊断。 */
  reason?: string;
  /** 协议标签。 */
  kind?: string;
  /** 关联的 active key。 */
  publicKeyHex?: string;
  /**
   * 保护来源标识（例如 `protocol-claim:<submissionId>`、
   * `protocol-funding:<fundingId>`）。
   *
   * 同一 outpoint 可以同时有多个保护来源：协议 submission 自己的输入占用
   * 是一种来源，专款记录是另一种。资金授权必须按来源分别判断：接管自己的
   * 占用不能顺带放掉别人的保护。
   */
  source?: string;
  /** `protocol-claim` 来源对应的 submission id。 */
  submissionId?: string;
}

/** 协议 plugin 提供受保护 outpoint 的能力。 */
export interface ProtectedOutpointProvider {
  id: string;
  /** 声明这个 provider 归属的协议插件 id。 */
  ownerPluginId?: string;
  listProtectedOutpoints(): Promise<ProtectedOutpoint[]> | ProtectedOutpoint[];
  onChange?(handler: () => void): () => void;
  dispose?(): void;
}

/** Wallet-owned protection store; explicit coordinates are responsibility evidence. */
export interface ProtectedOutpointStore {
  register(provider: ProtectedOutpointProvider): void;
  unregister(id: string): void;
  list(filter?: { publicKeyHex?: string; network?: BsvNetwork }): ProtectedOutpoint[];
  isProtected(input: { txid: string; vout: number; network: BsvNetwork; publicKeyHex?: string }): boolean;
  onChange(handler: () => void): () => void;
  claimProtectedInputs(input: {
    ownerPluginId: string;
    publicKeyHex?: string;
    network: BsvNetwork;
    inputs: Array<{ txid: string; vout: number }>;
  }): Promise<{ claimIds: string[] }>;
  releaseClaims(claimIds: string[]): Promise<void>;
  _ids(): string[];
}

/** Business view bound to the sole wallet; callers cannot select another wallet. */
export interface ProtectedOutpointRegistry extends Omit<ProtectedOutpointStore, "list" | "isProtected" | "claimProtectedInputs" | "_ids"> {
  list(): ProtectedOutpoint[];
  isProtected(input: { txid: string; vout: number }): boolean;
  claimProtectedInputs(input: { ownerPluginId: string; inputs: Array<{ txid: string; vout: number }> }): Promise<{ claimIds: string[] }>;
}

/** capability key。 */
export const PROTECTED_OUTPOINT_REGISTRY_CAPABILITY = defineCapability<ProtectedOutpointRegistry>({
  kind: "local",
  id: "protected-outpoint.registry",
  version: "1",
});
