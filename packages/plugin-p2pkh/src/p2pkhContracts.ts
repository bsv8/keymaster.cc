// packages/plugin-p2pkh/src/p2pkhContracts.ts
// P2PKH 专属类型与 P2pkhService 契约。
// 设计缘由：硬切换后这些类型默认只在 plugin-p2pkh 内部使用，不进入全局 contracts。
// 包含 WOC 硬切换后的扩展：recent sync、history backfill、本地提交、本地输入占用。

import type { BsvNetwork, KeyIdentity } from "@keymaster/contracts";

/** P2PKH 资产 id。设计缘由：bsv 和 bsvtest 是同一类资产的不同网络，不是不同 provider。 */
export type P2pkhAssetId = "bsv" | "bsvtest";

/** 资产定义。 */
export interface P2pkhAssetDef {
  assetId: P2pkhAssetId;
  label: string;
  network: BsvNetwork;
  unit: string;
  tags: string[];
}

/** 全部 P2PKH 资产。 */
export const P2PKH_ASSETS: Record<P2pkhAssetId, P2pkhAssetDef> = {
  bsv: {
    assetId: "bsv",
    label: "BSV",
    network: "main",
    unit: "sats",
    tags: ["p2pkh", "main"]
  },
  bsvtest: {
    assetId: "bsvtest",
    label: "BSV Testnet",
    network: "test",
    unit: "sats",
    tags: ["p2pkh", "test"]
  }
};

/** P2PKH 资源：当前 active key namespace 下的一个网络资源。
 *  设计缘由：硬切换 007 后 P2PKH 资源归属 publicKeyHash；keyId 仍保留为诊断字段，
 *  不再作为删除/隔离主路径。resourceId 不再拼接 keyId，改为
 *  `p2pkh:<network>:<scriptType>`，区分同 key 下的不同网络。 */
export interface P2pkhKeyResource {
  resourceId: string;
  /** Vault 内部 key id，诊断字段。 */
  keyId: string;
  /** active key 公钥 hash；硬切换后用于诊断与迁移回查。 */
  publicKeyHash: string;
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
 * P2PKH 余额（硬切换 009 / 001）。
 * 设计缘由：余额不再是表、不是持久化实体，只是 service 基于当前 UTXO 快照
 * 的实时计算结果。WOC 当前返回的未花费 UTXO 集合是余额与可选输入的唯一链上
 * 真值；`confirmed / unconfirmed / spendable` 不再作为余额字段。
 */
export interface P2pkhBalance {
  total: number;
}

/**
 * P2PKH 全局产品设置（硬切换 001）。
 * 设计缘由：这是产品级显示与同步范围配置，不是某一把 key 的链上状态，
 * 放在全局 localStorage 而不是 key-scoped DB。当前唯一字段是
 * `includeTestnet`：缺省 false。
 */
export interface P2pkhGlobalSettings {
  includeTestnet: boolean;
}

/** P2PKH UTXO。 */
export interface P2pkhUtxo {
  id: string;
  resourceId: string;
  /** 诊断字段，删除主路径不再依赖。 */
  keyId: string;
  publicKeyHash: string;
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

/** P2PKH 历史记录条目。 */
export interface P2pkhHistoryItem {
  id: string;
  resourceId: string;
  /** 诊断字段，删除主路径不再依赖。 */
  keyId: string;
  publicKeyHash: string;
  network: BsvNetwork;
  address: string;
  txid: string;
  height?: number;
  status: "confirmed" | "unconfirmed" | "pending" | "dropped";
  /** 历史来源：本地提交、WOC 未确认、WOC 确认。 */
  source: "local-submission" | "woc-unconfirmed" | "woc-confirmed";
  syncedAt: string;
  /**
   * 未观察到的 recent-sync 轮次；用于确认被 dropped 前必须连续多次 missing。
   * 设计缘由：单次 missing 可能是 WOC 短暂不一致；多次 missing 才表示交易真正
   * 从 mempool 消失。
   */
  missingObservationCount?: number;
}

/** UTXO 过滤条件。 */
export interface P2pkhUtxoFilter {
  assetId?: P2pkhAssetId;
  keyId?: string;
  resourceId?: string;
}

/**
 * UTXO 分配请求（硬切换 001）。
 * 设计缘由：移除 `allowUnconfirmed`。一旦"未在 WOC 未花费集合里"
 * 才会让该输入不参与分配——本地输入占用由 service 层过滤后传入。
 */
export interface UtxoAllocationRequest {
  amountSatoshis: number;
  feeReserveSatoshis?: number;
  strategy?: "smallest-first" | "largest-first";
  assetId: P2pkhAssetId;
  keyId?: string;
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
export type P2pkhSyncStatus = "idle" | "syncing" | "ok" | "failed" | "rate-limited";

/** Backfill 状态。 */
export type P2pkhBackfillStatus = "pending" | "running" | "complete" | "failed" | "paused";

/** Backfill state。 */
export interface P2pkhBackfillState {
  resourceId: string;
  status: P2pkhBackfillStatus;
  nextPageToken?: string;
  anchorTxids: string[];
  pagesSynced: number;
  recordsSynced: number;
  revision: number;
  lastError?: string;
  updatedAt: string;
}

/** Recent sync state。 */
export interface P2pkhRecentSyncState {
  resourceId: string;
  recentConfirmedTxids: string[];
  lastCheckedAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
}

/** Pending transfer。 */
export type P2pkhLocalSubmissionStatus = "submitting" | "broadcast" | "confirmed" | "failed" | "unknown" | "provider-inconsistent";

export interface P2pkhLocalSubmission {
  id: string;
  resourceId: string;
  keyId: string;
  publicKeyHash: string;
  network: BsvNetwork;
  assetId: P2pkhAssetId;
  canonicalTxid: string;
  rawTxHex: string;
  providerReturnedTxidRaw?: string;
  providerReturnedTxidNormalized?: string;
  txidIntegrity: "exact" | "reversed" | "mismatch" | "missing";
  recipientAddress: string;
  amountSatoshis: number;
  status: P2pkhLocalSubmissionStatus;
  inputOutpoints: Array<{ txid: string; vout: number; value: number }>;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

/** 本地输入占用。 */
export type P2pkhLocalInputClaimState = "claimed" | "observed-consumed" | "released";

export interface P2pkhLocalInputClaim {
  id: string;
  submissionId: string;
  resourceId: string;
  keyId: string;
  publicKeyHash: string;
  network: BsvNetwork;
  txid: string;
  vout: number;
  canonicalTxid?: string;
  state: P2pkhLocalInputClaimState;
  createdAt: string;
  updatedAt: string;
  missingObservationCount?: number;
}

/** 同步协调器提交所需参数。 */
export interface P2pkhBackfillCommit {
  resourceId: string;
  expectedRevision: number;
  /** 资源代际；与 store 当前 generation 不一致时丢弃响应。 */
  expectedGeneration: number;
  /** 资源元数据，用于在 history 记录中填入正确的 keyId/network/address。 */
  resource: P2pkhKeyResource;
  /** 当前页 history；按 (resourceId, txid) upsert。 */
  page: Array<{ txid: string; height: number; status: "confirmed"; source: "woc-confirmed" }>;
  /** 下一页 token；缺失则视为 complete。 */
  nextPageToken?: string;
}

/**
 * P2pkhRecentCommit（硬切换 001）。
 * 设计缘由：移除 `balance` 字段。recent-sync 不再请求 WOC balance
 * endpoint，也不再把余额写回 DB；余额真值由 service 每次基于当前
 * UTXO 快照现算。
 */
export interface P2pkhRecentCommit {
  resourceId: string;
  /** 资源代际；提交时与 store 当前 generation 不一致则拒绝写入。 */
  expectedGeneration?: number;
  /** 资源元数据，用于在 history 中填入正确的 keyId/network/address。 */
  resource?: P2pkhKeyResource;
  /** resource 替换式 UTXO 快照。 */
  utxos?: P2pkhUtxo[];
  /** 近期确认与未确认 history。 */
  recentHistory?: P2pkhHistoryItem[];
  unconfirmedHistory?: P2pkhHistoryItem[];
  /** 写入 recent watermark。 */
  recentConfirmedTxids?: string[];
  /** 本地输入占用对账结果。 */
  localInputClaims?: P2pkhLocalInputClaim[];
  /** 本地提交观察对账结果。 */
  localSubmissions?: P2pkhLocalSubmission[];
  /** lastSyncedAt 时间戳。 */
  lastSyncedAt?: string;
}

/**
 * 转移输入参数（硬切换 001）。
 * 设计缘由：移除 `allowUnconfirmed`。所有未在本地输入占用中
 * 占用的未花费 UTXO 都会参与选币；WOC 已看不到的输入也不会进入。
 */
export interface P2pkhTransferInput {
  assetId: P2pkhAssetId;
  keyId: string;
  recipientAddress: string;
  amountSatoshis: number;
  feeRateSatoshisPerKb?: number;
}

/** 转移预览结果。 */
export interface P2pkhTransferPreview {
  assetId: P2pkhAssetId;
  network: BsvNetwork;
  recipientAddress: string;
  amountSatoshis: number;
  feeRateSatoshisPerKb: number;
  allocation: UtxoAllocation;
  changeAddress: string;
  outputs: Array<{ address: string; value: number }>;
  estimatedFeeSatoshis: number;
  serializedSizeBytes: number;
  txid: string;
  rawTxHex: string;
}

/** 转移结果。 */
export type P2pkhTransferResultStatus = "broadcast" | "confirmed" | "rejected" | "unknown" | "provider-inconsistent";

export interface P2pkhTransferResult {
  status: P2pkhTransferResultStatus;
  txid?: string;
  rawTxHex: string;
  error?: string;
  submissionId: string;
  localInputClaimIds: string[];
}

/** P2PKH 服务契约：plugin-p2pkh 内部使用，对应 capability "p2pkh.service"。 */
export interface P2pkhService {
  syncStatus(): P2pkhSyncStatus;
  onSyncStatusChange(handler: (status: P2pkhSyncStatus) => void): () => void;

  /** 触发一次 recent-sync。 */
  triggerRecentSync(): Promise<void>;
  /** 触发 history-backfill（用户手动重试 / 继续）。 */
  triggerHistoryBackfill(resourceId?: string): Promise<void>;
  /** 暂停 history-backfill；返回的 Promise resolve 时表示旧实例已退出。 */
  pauseHistoryBackfill(resourceId?: string): Promise<void>;
  resumeHistoryBackfill(resourceId?: string): void;

  /**
   * 读取当前全局产品设置。始终返回最新同步值：
   * - 进程内缓存由 `applyGlobalSettings` 维护；
   * - 跨标签页变更通过 storage 事件被 service 接收并刷新缓存。
   * 设计缘由：所有 read 路径（listResources / listUtxos / listHistory /
   * getAssetBalance / getResourceBalance / allocateUtxos / transfer）
   * 在做 testnet 过滤时都必须拿到与上一次写一致的 `includeTestnet`，
   * 否则会出现"切换设置后同一次渲染仍按旧值过滤"的不一致。
   */
  getGlobalSettings(): P2pkhGlobalSettings;
  /**
   * 订阅全局设置变更。包括：
   * - 本标签页通过 `applyGlobalSettings` 写入的变更；
   * - 跨标签页由 storage 事件带回来的变更。
   * 返回取消订阅句柄。
   */
  onGlobalSettingsChange(handler: (settings: P2pkhGlobalSettings) => void): () => void;
  /**
   * 应用新的全局设置：写 localStorage、更新进程内缓存、通知订阅者、
   * 并在 includeTestnet 由 false → true 时立即触发 rehydrate +
   * recent-sync + history-backfill，让 testnet 重新进入运行范围。
   * 设计缘由：硬切换 001 要求"再次开启 testnet 时立即把 testnet
   * 纳入运行范围"，但 storage 事件不会在本标签页触发，必须由写入
   * 路径主动通知 service。
   */
  applyGlobalSettings(settings: P2pkhGlobalSettings): Promise<void>;

  getAssetBalance(assetId: P2pkhAssetId): Promise<P2pkhBalance>;
  getResourceBalance(resourceId: string): Promise<P2pkhBalance>;

  listResources(assetId?: P2pkhAssetId): Promise<P2pkhKeyResource[]>;
  listUtxos(filter?: P2pkhUtxoFilter): Promise<P2pkhUtxo[]>;
  listHistory(filter?: P2pkhUtxoFilter): Promise<P2pkhHistoryItem[]>;
  listBackfillStates(): Promise<P2pkhBackfillState[]>;
  /**
   * 列出各资源的 recent-sync 状态：lastCheckedAt / lastSuccessAt 是
   * "最近一次同步时间"的真实来源（recent-sync 不会回写 address store 的
   * lastSyncedAt）。UI 应使用此接口展示"最近同步"。
   */
  listRecentSyncStates(): Promise<P2pkhRecentSyncState[]>;
  listLocalSubmissions(): Promise<P2pkhLocalSubmission[]>;
  listLocalInputClaims(): Promise<P2pkhLocalInputClaim[]>;

  allocateUtxos(request: UtxoAllocationRequest): Promise<UtxoAllocation>;

  /** 转移：prepare / preview。 */
  prepareTransfer(input: P2pkhTransferInput): Promise<P2pkhTransferPreview>;
  /** 转移：广播 preview 中已经生成好的最终交易。 */
  submitTransfer(preview: P2pkhTransferPreview): Promise<P2pkhTransferResult>;

  onKeyImported(keyId: string): Promise<void>;
  onKeyRemoved(keyId: string): Promise<void>;
  /** Vault 锁定时调用：取消当前所有 P2PKH 后台运行。 */
  onVaultLocked(): void;
  /** Vault 解锁时调用：触发一次 recent-sync。 */
  onVaultUnlocked(): Promise<void>;
  /**
   * 关键修复：plugin 启动时调用，遍历 Vault 现有 key，补齐缺失的
   * main/test P2PKH 资源。Vault 仍处于 locked 时静默返回。
   */
  rehydrate(): Promise<void>;
  /** 硬切换 001：宿主 teardown 时调用。幂等。 */
  dispose?(): void;
}

/** P2PKH 插件对外暴露的 capability key。 */
export const P2PKH_CAPABILITY = "p2pkh.service";

/** assetId -> network 映射。P2PKH 内部使用，不导出到 contracts。 */
export function assetIdToNetwork(assetId: P2pkhAssetId): BsvNetwork {
  if (assetId === "bsv") return "main";
  if (assetId === "bsvtest") return "test";
  throw new Error(`Unknown P2PKH asset "${assetId}"`);
}

/**
 * 硬切换 008 收尾 + 硬切换 003 收尾：KeyIdentity 收窄类型。
 * 设计缘由：contract 的 KeyIdentity 字段 publicKeyHash / publicKeyHex
 * 是 optional（兼容 failed / uninitialized 状态），但 P2PKH 业务只在
 * ready 状态下运行。`requireReadyKey` 内部做断言后返回
 * `ReadyKeyIdentity`，调用方拿到的就是 publicKeyHash / publicKeyHex
 * 必填的窄类型，写入 P2pkhKeyResource.publicKeyHash 等必填字段时不再
 * 需要 `!`。
 *
 * 硬切换 003 收尾：`fingerprint` 字段已从 contract 中删除；
 * 短公钥属于 UI 展示格式，需要时由 UI 拿 `publicKeyHex` 调
 * `formatShortPublicKey()` 现算。本窄类型也不再持有 `fingerprint`。
 */
export interface ReadyKeyIdentity {
  keyId: string;
  publicKeyHex: string;
  publicKeyHash: string;
  label: string;
  capabilities: string[];
  createdAt: string;
  identityStatus?: "ready" | "uninitialized" | "failed";
  identityError?: string;
}

/**
 * 把 KeyIdentity 收窄为 ReadyKeyIdentity。
 * 设计缘由：业务边界显式断言 + 抛出英文错误；调用方无需再用 `!` 糊过去。
 * 错误信息保持英文，调用方应处理 "Active key is not ready" 这一支。
 *
 * 收尾建议：当前 keyspace.listActiveCandidates 已经过滤掉
 * `identityStatus !== "ready"`，所以运行期传进来的 key 通常要么
 * status === "ready" 要么是 undefined / 老记录（无 status）。
 * 这里仍然显式拒绝 "failed" 与 "uninitialized"——前者是 backfill
 * 解密失败（不能让 P2PKH 拿去做签名），后者是 backfill 未完成
 * 的中间态（不能让 P2PKH 在命名空间还没就绪时打开 DB）。同时
 * publicKeyHash / publicKeyHex 必须存在，老 v1/v2 记录缺字段时也会被拒。
 *
 * 硬切换 003 收尾：本函数不再检查或回填 `fingerprint`——该字段已
 * 从 KeyIdentity / ReadyKeyIdentity 中删除。短公钥由 UI 现算。
 */
export function requireReadyKey(key: KeyIdentity | undefined | null): ReadyKeyIdentity {
  if (!key) throw new Error("Active key is not ready");
  if (key.identityStatus === "failed") throw new Error("Active key is not ready");
  if (key.identityStatus === "uninitialized") throw new Error("Active key is not ready");
  if (!key.publicKeyHash) throw new Error("Active key is not ready");
  if (!key.publicKeyHex) throw new Error("Active key is not ready");
  return {
    keyId: key.keyId,
    publicKeyHex: key.publicKeyHex,
    publicKeyHash: key.publicKeyHash,
    label: key.label,
    capabilities: key.capabilities,
    createdAt: key.createdAt,
    identityStatus: key.identityStatus,
    identityError: key.identityError
  };
}

/**
 * 构造 P2PKH 资源 id。
 * 硬切换 007：resourceId 不再拼接 Vault keyId；同一 active key 下用
 * `p2pkh:<network>` 区分 main/test 两个网络资源。
 */
export function makeResourceId(_keyId: string, network: BsvNetwork): string {
  return `p2pkh:${network}`;
}

/** assetId 视角的 resourceId；与 makeResourceId("ignored", network) 等价。 */
export function makeResourceIdForAsset(assetId: P2pkhAssetId): string {
  return `p2pkh:${assetIdToNetwork(assetId)}`;
}
