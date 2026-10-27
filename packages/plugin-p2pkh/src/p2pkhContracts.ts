// packages/plugin-p2pkh/src/p2pkhContracts.ts
// P2PKH 专属类型与 P2pkhService 契约。
// 设计缘由：硬切换后这些类型默认只在 plugin-p2pkh 内部使用，不进入全局 contracts。
// 包含 confirmed facts/projections、本地提交和协议资产兼容 claim。
//
// 硬切换 002 收尾（key 域彻底收尾）：
//   - P2PKH 资源 / UTXO / history / submission / claim / transfer input /
//   - `readyKeyIdentity` 收窄为只持有 `publicKeyHex` 等公开身份字段，
//     不再持有 vault 内部 surrogate id。
//   - `onKeyImported` / `onKeyRemoved` 入参改为 `publicKeyHex`。
//     当前打开的 namespace K-V 隐式表达（每个 key 的 namespace 独立 K-V）。
//     唯一 owner 真值，UTXO / history 过滤同 owner 时直接匹配 hex。

import { defineCapability } from "webloom-framework";
import type { BsvNetwork, KeyIdentity, P2pkhConnectPaymentFacts, P2pkhConnectPaymentPreview, P2pkhUtxoBinding } from "@keymaster/contracts";

// 余额广播契约属于全局 contracts；这里重导出旧路径，兼容插件内部和外部现有 import。
export type { P2pkhBalance, P2pkhBalanceBreakdown } from "@keymaster/contracts";

/** 转账/协议 DTO 的兼容网络资产标签，不再提供资产目录或余额查询选择器。 */
export type P2pkhAssetId = "bsv" | "bsvtest";

/**
 * P2PKH 资源：当前 active key namespace 下的一个网络资源。
 *
 * 硬切换 007 + 硬切换 002 收尾：
 *   - 资源归属通过当前打开的 namespace K-V（`publicKeyHex` 维度）隐式
 *     区分，不再需要资源字段上自带一个 key id。
 *   - resourceId 仅按 `p2pkh:<network>` 区分同 key 下的不同网络资源。
 */
export interface P2pkhKeyResource {
  resourceId: string;
  /** owner 公开身份：压缩公钥 hex；仅作为展示字段，与当前 namespace K-V 的归属一致。 */
  publicKeyHex: string;
  label: string;
  address: string;
  network: BsvNetwork;
  createdAt: string;
  lastSyncedAt?: string;
  /**
   * 代际：每次资源被重新派生（地址变化）或被删除重建时自增。
   * late commit 必须用 commit 时的 generation 与当前 store 里的 generation
   * 校验一致；不一致表示 key 已被删除/重建，丢弃响应。
   */
  generation: number;
}

/**
 * 链上历史记录（历史同步的唯一产物）。
 *
 * 设计缘由（2026-09-20 解耦）：
 *   - 历史同步只保存 WoC history 返回的 txid / height / fee 等元数据；
 *   - 不再下载 raw tx、不再派生 owned outpoint、UTXO、余额或花费关系；
 *   - raw transaction 只在打开详情页时按 txid 懒加载并临时解析。
 */
export interface P2pkhHistoryRecord {
  id: string;
  resourceId: string;
  publicKeyHex: string;
  network: BsvNetwork;
  address: string;
  txid: string;
  /** 确认高度；未确认记录为 0。 */
  height: number;
  /** WoC history 返回的手续费（聪）；缺失时省略。 */
  fee?: number;
  /** 本地首次写入该记录的时间。 */
  firstSeenAt: string;
}

/**
 * 本地交易的链上收敛状态。
 *
 * 只按“相同 txid”收敛：历史里看到同一 txid 才标 chain-confirmed。
 * 不再根据输入关系派生 conflicted、后代失效或本地交易 DAG。
 */
export type P2pkhLocalChainResolution = "unresolved" | "chain-confirmed";
export type P2pkhLocalLifecycleState = "prepared" | "submitting" | "local-confirmed" | "isolated";

export interface P2pkhBroadcastAttempt {
  id: string;
  submissionId: string;
  providerId: string;
  startedAt: string;
  finishedAt?: string;
  status: "accepted" | "already-known" | "failed" | "isolated";
  providerReference?: string;
  providerCode?: string;
  providerMessage?: string;
}

export interface P2pkhLocalTransaction {
  id: string;
  resourceId: string;
  publicKeyHex: string;
  network: BsvNetwork;
  txid: string;
  rawTxHex: string;
  localState: P2pkhLocalLifecycleState;
  chainResolution: P2pkhLocalChainResolution;
  inputOutpointKeys: string[];
  ownOutputs: Array<{ vout: number; value: number; scriptHex: string }>;
  createdAt: string;
  updatedAt: string;
  isolationReason?: string;
  /** 命中历史记录后写入的 P2pkhHistoryRecord.id。 */
  confirmedHistoryId?: string;
  resolvedAt?: string;
  attempts: P2pkhBroadcastAttempt[];
}

export type P2pkhLocalInputClaimV10State = "active" | "isolated" | "released" | "confirmed";

export interface P2pkhLocalInputClaimV10 {
  id: string;
  submissionId: string;
  resourceId: string;
  publicKeyHex: string;
  network: BsvNetwork;
  txid: string;
  vout: number;
  outpointKey: string;
  value?: number;
  state: P2pkhLocalInputClaimV10State;
  createdAt: string;
  updatedAt: string;
}

export interface P2pkhTransactionSyncState {
  id: string;
  resourceId: string;
  pagesSynced: number;
  transactionsSynced: number;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
}

export interface P2pkhUtxo {
  id: string;
  resourceId: string;
  publicKeyHex: string;
  network: BsvNetwork;
  address: string;
  txid: string;
  vout: number;
  value: number;
  height?: number;
  script?: string;
  status: "confirmed" | "unconfirmed";
  isSpentInMempoolTx: boolean;
  syncedAt: string;
}

/** 当前钱包 manager 的查询结果；hasResult 不表示链上同步完整或资金已授权。 */
export type P2pkhAvailableUtxos =
  | { hasResult: false; utxos: null; seq: null; syncedAt: null }
  | { hasResult: true; utxos: P2pkhUtxo[]; seq: number; syncedAt: string };

/** 查询始终绑定当前钱包，调用方只指定业务筛选与有界分页。 */
export interface P2pkhHistoryQuery {
  txid?: string;
  cursor?: string;
  limit?: number;
}

export interface P2pkhLocalTransactionQuery extends P2pkhHistoryQuery {
  submissionId?: string;
  includeResolved?: boolean;
}

export interface P2pkhPage<T> {
  items: T[];
  nextCursor?: string;
}

/**
 * UTXO 分配请求（硬切换 001 + 硬切换 002 收尾）。
 */
export interface UtxoAllocationRequest {
  amountSatoshis: number;
  feeReserveSatoshis?: number;
  strategy?: "smallest-first" | "largest-first";
  assetId: P2pkhAssetId;
}

/** UTXO 分配结果。 */
export interface UtxoAllocation {
  requestedSatoshis: number;
  feeReserveSatoshis: number;
  selected: P2pkhUtxo[];
  totalInputSatoshis: number;
  changeSatoshis: number;
}

/** 分配失败的错误载荷。 */
export interface UtxoAllocationError {
  required: number;
  available: number;
  feeReserve: number;
  reason: "insufficient" | "no-utxos" | "policy-denied" | "reserved";
}

/** 同步状态。 */
export type P2pkhSyncStatus = "idle" | "syncing" | "ok" | "failed" | "blocked";
export interface P2pkhSyncSnapshot {
  status: P2pkhSyncStatus;
  lastCompletedAt?: string;
  error?: string;
}

/** Pending transfer。 */
/** 历史/协议兼容的本地输入 claim；普通 P2PKH 转账不创建、不读取。 */
export type P2pkhLocalInputClaimState = P2pkhLocalInputClaimV10State;

export interface P2pkhLocalInputClaim {
  id: string;
  submissionId: string;
  resourceId: string;
  publicKeyHex: string;
  network: BsvNetwork;
  txid: string;
  vout: number;
  outpointKey?: string;
  value?: number;
  state: P2pkhLocalInputClaimState;
  createdAt: string;
  updatedAt: string;
}

/** 协议 spend 持久化提交。 */
export type P2pkhProtocolSubmissionStatus =
  | "prepared"
  | "broadcast-pending-woc"
  | "woc-observed-unconfirmed"
  | "woc-confirmed"
  | "woc-dropped"
  | "rejected"
  | "unknown"
  | "provider-inconsistent";

export interface P2pkhProtocolSubmission {
  id: string;
  resourceId: string;
  publicKeyHex: string;
  network: BsvNetwork;
  submissionId: string;
  canonicalTxid: string;
  inputs: Array<{ txid: string; vout: number }>;
  protectedClaimIds: string[];
  localInputClaimIds: string[];
  status: P2pkhProtocolSubmissionStatus;
  observation?: "unconfirmed" | "confirmed";
  droppedReason?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 转移输入参数（硬切换 001 + 硬切换 002 收尾）。
 *
 * `ownerPublicKeyHex` 是 session / caller 视角的 owner 真值，本参数
 */
export interface P2pkhTransferInput {
  /** 调用方注册的支付渠道；App 必须携带同一连接的会话，重试不得丢失。 */
  paymentContext?: { channelId: string; sessionId: string | null };
  assetId: P2pkhAssetId;
  /** session / caller 视角的 owner public key hex；UTXO 选币 / 签名 key / resourceId 全按该 owner 走。 */
  ownerPublicKeyHex: string;
  recipientAddress?: string;
  amountSatoshis: number;
  /** 使用所有可用输入；最终收款额在签名后按实际 fee 自动扣减。 */
  sendAll?: boolean;
  feeRateSatoshisPerKb?: number;
  /** Connect v1 strict payment facts; mutually exclusive with sendAll. */
  payment?: P2pkhConnectPaymentFacts;
}

/** 业务请求；钱包身份由服务实例自动绑定，调用者不能选择。 */
export type P2pkhTransferRequest = import("@keymaster/contracts").P2pkhTransferRequest;

/**
 * 转移预览结果（硬切换 002 收尾）。
 *
 * `ownerPublicKeyHex` 透传到 preview 上，让 submit 阶段可以校验 resource /
 * 签名 key 与该 owner 一致——owner 变了就拒绝广播。
 */
export interface P2pkhTransferPreview {
  paymentContext?: { channelId: string; sessionId: string | null };
  assetId: P2pkhAssetId;
  network: BsvNetwork;
  ownerPublicKeyHex: string;
  recipientAddress: string;
  amountSatoshis: number;
  feeRateSatoshisPerKb: number;
  allocation: UtxoAllocation;
  changeAddress: string;
  outputs: Array<{ address?: string; scriptHex?: string; value: number; role?: "business" | "change" }>;
  /** Present only on the strict Connect payment path. */
  payment?: P2pkhConnectPaymentPreview;
  estimatedFeeSatoshis: number;
  /** 签名后序列化大小上限；预览不会为了估费调用私钥。 */
  serializedSizeBytes: number;
  /** 预览尚未签名，无最终链上 txid，固定为空；提交结果返回真实 txid。 */
  txid: string;
  /** 未签名交易；不能用于广播，不含私钥签名。 */
  rawTxHex: string;
  /** Durable UTXO Manager allocation bound to this preview (production Worker path). */
  managerAllocationId?: string;
  /** 本次准备的内存标识；重试时用于区分每一轮提交。 */
  previewId: string;
  /** 组合阶段捕获的 UTXO 快照序号；纯兼容夹具可省略。 */
  utxoBinding?: P2pkhUtxoBinding;
  /** 是否为“全部发送”；重试时必须重新确认金额。 */
  sendAll?: boolean;
}

/** 转移结果。 */
export type P2pkhTransferResultStatus =
  | "local-confirmed"
  | "isolated"
  | "not-dispatched";

export interface P2pkhTransferResult {
  status: P2pkhTransferResultStatus;
  /** Final provider outcome when known; distinguishes fresh acceptance from already-known. */
  delivery?: "accepted" | "already-known";
  txid?: string;
  rawTxHex: string;
  error?: string;
  submissionId: string;
  localInputClaimIds: string[];
  /** 已尝试次数（含第一次）。 */
  attempts: number;
  /** 自动重试的终止原因。 */
  /** 终止诊断，不作为释放输入或重签的凭据。 */
  reason?: string;
}

/**
 * 交易详情（详情页懒加载解析结果，只用于展示）。
 *
 * 中文说明：inputs/outputs 来自打开详情时按 txid 临时获取的 raw transaction；
 * 不落盘、不参与余额/选币/历史同步。
 */
export interface P2pkhTransactionDetail {
  txid: string;
  network: BsvNetwork;
  inputs: Array<{ txid: string; vout: number; outpointKey: string }>;
  outputs: Array<{ vout: number; value: number; scriptHex: string }>;
  sizeBytes: number;
}

/** P2PKH 服务契约：plugin-p2pkh 内部使用，对应 capability "p2pkh.service"。 */
export interface P2pkhService {
  /** 完整前序证据的链上读接口；缺失时费用池不能退回盲签摘要。 */
  getRawTransaction(txid: string): Promise<string>;
  /** Pure local manager lookup; must never initiate signing/broadcast/chain polling. */
  getPaymentStatus(input: Pick<import("@keymaster/contracts").P2pkhPaymentLookupInput, "paymentId">): Promise<import("@keymaster/contracts").P2pkhPaymentLookupResult>;

  /** 同步观察的本地只读投影；不刷新链、不占用或释放输入。 */
  getAvailableUtxos(): Promise<P2pkhAvailableUtxos>;
  /** 主动刷新链上观察，经 manager 返回可用投影。 */
  refreshUtxos(): Promise<P2pkhAvailableUtxos>;
  /** 当前钱包链上历史，先筛选再分页。 */
  listHistory(query?: P2pkhHistoryQuery): Promise<P2pkhPage<P2pkhHistoryRecord>>;
  /** 当前钱包本地提交，默认仅未链上收敛记录；先筛选再分页。 */
  listLocalTransactions(query?: P2pkhLocalTransactionQuery): Promise<P2pkhPage<P2pkhLocalTransaction>>;
  /**
   * 详情页懒加载：按 txid 从 WoC 取 raw transaction 并临时解析。
   *
   * 解析结果只用于展示，不写任何派生状态、不进入选币或余额。
   */
  getTransactionDetail(input: { txid: string }): Promise<P2pkhTransactionDetail | undefined>;

  /** 转移：prepare / preview。 */
  prepareTransfer(input: P2pkhTransferRequest): Promise<P2pkhTransferPreview>;
  /** 转移：广播 preview 中已经生成好的最终交易。 */
  submitTransfer(preview: P2pkhTransferPreview): Promise<P2pkhTransferResult>;
  /**
   * 按预览 ID 提交 Worker 自己记住的那份预览（跨 Runtime 路径）。
   *
   * 中文说明：可选能力——只有 Worker 侧的 service 实现它。页面只能带
   * previewId，选币、金额、找零与 manager allocation 以 Worker 的记录为准。
   */
  submitPreparedTransfer?(previewId: string): Promise<P2pkhTransferResult>;
  /**
   * 外露 artifact 的占用：Connect/费用池交付已签名 artifact 之前，先让
   * UTXO Manager 占住它的钱包输入（跨 Runtime 路径，经受限 Coordinator）。
   */
  occupyDeliveredArtifact?(input: import("@keymaster/contracts").P2pkhArtifactRequest): Promise<import("@keymaster/contracts").P2pkhArtifactOccupyResult>;

  /** 当前绑定钱包的资料已就绪，补齐派生资源。 */
  onKeyImported(): Promise<void>;
  /** 清理当前实例的派生缓存与后台引用；不删除持久资金责任。 */
  onKeyRemoved(): Promise<void>;
  /** Vault 锁定时调用：取消当前所有 P2PKH 后台运行。 */
  onVaultLocked(): void;
  /** Vault 解锁时调用：重新绑定当前 key 并补齐资源。 */
  onVaultUnlocked(): Promise<void>;
  /** 补齐当前身份的地址资源并刷新投影；失效实例不能重新绑定新身份。 */
  rehydrate(): Promise<void>;
  /** 硬切换 001：宿主 teardown 时调用。幂等。 */
  dispose?(): void;
}

/** P2PKH 插件对外暴露的 capability key。 */
export const P2PKH_CAPABILITY = defineCapability<P2pkhService>({
  kind: "local",
  id: "p2pkh.service",
  version: "1",
});

/** assetId -> network 映射。P2PKH 内部使用，不导出到 contracts。 */
export function assetIdToNetwork(assetId: P2pkhAssetId): BsvNetwork {
  if (assetId === "bsv") return "main";
  if (assetId === "bsvtest") return "test";
  throw new Error(`Unknown P2PKH asset "${assetId}"`);
}

/**
 * Ready 状态 key 身份（硬切换 002 收尾）。
 *
 * KeyIdentity 已是 ready：canonical store 主键就是 publicKeyHex，Vault
 * 解锁完成后已经完成 canonical records / AAD 升级，所有"存活 key"都
 * 派生出了 identity。`ReadyKeyIdentity` 保留只是为了在 service 层里做
 * 窄类型投影，让"必须带 publicKeyHex"在静态检查层面成立。
 */
export interface ReadyKeyIdentity extends KeyIdentity {
  publicKeyHex: string;
  label: string;
  capabilities: string[];
  createdAt: string;
}

/**
 * 把 KeyIdentity 收窄为 ReadyKeyIdentity。
 * 设计缘由：业务边界显式断言 + 抛出英文错误；调用方无需再用 `!` 糊过去。
 *
 * 硬切换 002 收尾：系统中**不再**存在 `identityStatus = failed |
 * uninitialized` 的稳态；`KeyIdentity.publicKeyHex` 缺失即视为"非 ready"。
 * 本函数不再持有也不回填 vault 内部 surrogate id。
 */
export function requireReadyKey(key: KeyIdentity | undefined | null): ReadyKeyIdentity {
  if (!key) throw new Error("Active key is not ready");
  if (!key.publicKeyHex) throw new Error("Active key is not ready");
  return {
    bsvNetwork: key.bsvNetwork,
    publicKeyHex: key.publicKeyHex,
    label: key.label,
    capabilities: key.capabilities,
    createdAt: key.createdAt
  };
}

/**
 * 构造 P2PKH 资源 id。
 *
 * `p2pkh:<network>` 区分 main/test 两个网络资源，`publicKeyHex` 通过
 * 当前打开的 namespace K-V 隐式表达。
 */
export function makeResourceId(network: BsvNetwork): string {
  return `p2pkh:${network}`;
}

/** assetId 视角的 resourceId；与 makeResourceId(assetIdToNetwork(assetId)) 等价。 */
export function makeResourceIdForAsset(assetId: P2pkhAssetId): string {
  return `p2pkh:${assetIdToNetwork(assetId)}`;
}
