// packages/plugin-p2pkh/src/p2pkhContracts.ts
// P2PKH 专属类型与 P2pkhService 契约。
// 设计缘由：硬切换后这些类型默认只在 plugin-p2pkh 内部使用，不进入全局 contracts。
// 包含 confirmed facts/projections、本地提交和本地输入占用。
//
// 硬切换 002 收尾（key 域彻底收尾）：
//   - P2PKH 资源 / UTXO / history / submission / claim / transfer input /
//   - `readyKeyIdentity` 收窄为只持有 `publicKeyHex` 等公开身份字段，
//     不再持有 vault 内部 surrogate id。
//   - `onKeyImported` / `onKeyRemoved` 入参改为 `publicKeyHex`。
//     当前打开的 namespace K-V 隐式表达（每个 key 的 namespace 独立 K-V）。
//     唯一 owner 真值，UTXO / history 过滤同 owner 时直接匹配 hex。

import type { BsvNetwork, KeyIdentity, P2pkhProviderRegistrySnapshot } from "@keymaster/contracts";

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

export interface P2pkhTransactionFact {
  id: string;
  resourceId: string;
  publicKeyHex: string;
  network: BsvNetwork;
  address: string;
  txid: string;
  rawTxHex: string;
  blockHeight?: number;
  blockHash?: string;
  blockTime?: number;
  inputOutpointKeys: string[];
  inputs: Array<{ txid: string; vout: number; outpointKey: string }>;
  ownedOutpointKeys: string[];
  ownedOutputs: Array<{ vout: number; value: number; scriptHex: string }>;
  firstConfirmedAt: string;
  lastConfirmedAt: string;
}

export type P2pkhOwnedOutpointChainState = "available" | "spent";

export interface P2pkhOwnedOutpointProjection {
  id: string;
  resourceId: string;
  publicKeyHex: string;
  network: BsvNetwork;
  address: string;
  txid: string;
  vout: number;
  outpointKey: string;
  value: number;
  scriptHex: string;
  chainState: P2pkhOwnedOutpointChainState;
  spentByTxid?: string;
  createdBlockHeight?: number;
  spentBlockHeight?: number;
  updatedAt: string;
}

export type P2pkhLocalLifecycleState = "prepared" | "submitting" | "local-confirmed" | "isolated";
export type P2pkhLocalChainResolution = "unresolved" | "chain-confirmed" | "conflicted";
export type P2pkhLocalOutpointState = "unavailable" | "available" | "claimed" | "isolated" | "invalidated";

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
  parentTxids: string[];
  createdAt: string;
  updatedAt: string;
  isolationReason?: string;
  confirmedFactId?: string;
  resolvedAt?: string;
  conflictSourceTxids?: string[];
  attempts: P2pkhBroadcastAttempt[];
}

export interface P2pkhLocalOutpoint {
  id: string;
  resourceId: string;
  txid: string;
  vout: number;
  value: number;
  scriptHex: string;
  submissionId: string;
  state: P2pkhLocalOutpointState;
  createdAt: string;
  updatedAt: string;
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
  completeHeadTxid?: string;
  inProgressProviderId?: string;
  inProgressProviderGeneration?: number;
  inProgressCursor?: string;
  runHeadTxid?: string;
  /** Transaction ids observed by the current resumable run for reorg audit. */
  runObservedTxids?: string[];
  runId?: string;
  pagesSynced: number;
  transactionsSynced: number;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
}

export interface P2pkhBalanceBreakdown {
  blockConfirmed: number;
  localSpendable: number;
  localConfirmedChange: number;
  pendingInputClaims: number;
  isolated: number;
}

/**
 * P2PKH 余额（硬切换 009 / 001）。
 * 设计缘由：余额不再是表、不是持久化实体，只是 service 基于当前 UTXO 快照
 * 的实时计算结果。WOC 当前返回的未花费 UTXO 集合是余额与可选输入的唯一链上
 * 真值；`confirmed / unconfirmed / spendable` 不再作为余额字段。
 */
export interface P2pkhBalance {
  total: number;
  breakdown?: P2pkhBalanceBreakdown;
}

/**
 * P2PKH 全局产品设置（硬切换 001）。
 * 设计缘由：这是产品级显示与同步范围配置，不是某一把 key 的链上状态，
 * 由 Coordinator 平台 K-V 保存，不属于任何单独的浏览器页面状态。
 */
export type P2pkhFeeRateTier = "low" | "medium" | "high";

/** BSV 交易费率按 sats/kB 计。中档是产品默认值；三档均可在系统设置调整。 */
export const P2PKH_DEFAULT_FEE_RATE_SATOSHIS_PER_KB: Record<P2pkhFeeRateTier, number> = {
  low: 500,
  medium: 1000,
  high: 2000
};

export interface P2pkhGlobalSettings {
  includeTestnet: boolean;
  /** 省略时回退到 `P2PKH_DEFAULT_FEE_RATE_SATOSHIS_PER_KB`。 */
  feeRateSatoshisPerKb?: Partial<Record<P2pkhFeeRateTier, number>>;
}

export function resolveP2pkhFeeRateSatoshisPerKb(settings?: P2pkhGlobalSettings): Record<P2pkhFeeRateTier, number> {
  const configured = settings?.feeRateSatoshisPerKb;
  const valueFor = (tier: P2pkhFeeRateTier) => {
    const value = configured?.[tier];
    return Number.isInteger(value) && value! > 0 ? value! : P2PKH_DEFAULT_FEE_RATE_SATOSHIS_PER_KB[tier];
  };
  return { low: valueFor("low"), medium: valueFor("medium"), high: valueFor("high") };
}

/** P2PKH UTXO。
 *
 * 硬切换 002 收尾：UTXO 持有 `publicKeyHex`（owner 真值），不再持有
 */
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

/**
 * UTXO 过滤条件（硬切换 002 收尾）。
 *
 * `ownerPublicKeyHex` 是 session / caller 视角的 owner 真值；plugin
 * 不再依赖 vault 内部 surrogate id 维度。
 *
 * 调用方语义：
 *   - 传 `ownerPublicKeyHex`：结果严格按该 owner 的 namespace K-V 过滤。
 *     跨 owner 调用（protocol feepool 等）**必须**传，不传就拿不到对
 *     的 value。底层硬门禁要求 `active === ownerPublicKeyHex`，由
 *     protocol 层 `assertSessionOwnerIsActive` 显式保证。
 *   - 不传：仅作 UI 本地读路径兜底，service 实现可回落到当前 active
 *     key namespace（老 widget / overview 仍可工作）；这**不**作
 *     为对外契约，跨 owner 调用禁止依赖此兜底。
 */
export interface P2pkhUtxoFilter {
  assetId?: P2pkhAssetId;
  /**
   * owner public key hex。跨 owner 调用必填；不传时仅作 UI 本地读
   * 路径兜底，行为**不**作为对外契约。
   */
  ownerPublicKeyHex?: string;
  resourceId?: string;
  /** Optional bounded page size for wallet/history projections. */
  limit?: number;
  /** Local audit read opt-in; UI history defaults to unresolved rows only. */
  includeResolvedLocalTransactions?: boolean;
}

/** Opaque cursor page used by the wallet's facts and coins views. */
export interface P2pkhPage<T> {
  items: T[];
  nextCursor?: string;
}

export interface P2pkhPageFilter extends P2pkhUtxoFilter {
  cursor?: string;
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
export type P2pkhSyncStatus = "idle" | "syncing" | "ok" | "failed" | "rate-limited" | "blocked";

/** Pending transfer。 */
/** 本地输入占用。
 *
 */
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
  assetId: P2pkhAssetId;
  /** session / caller 视角的 owner public key hex；UTXO 选币 / 签名 key / resourceId 全按该 owner 走。 */
  ownerPublicKeyHex: string;
  recipientAddress: string;
  amountSatoshis: number;
  /** 使用所有可用输入；最终收款额在签名后按实际 fee 自动扣减。 */
  sendAll?: boolean;
  feeRateSatoshisPerKb?: number;
}

/**
 * 转移预览结果（硬切换 002 收尾）。
 *
 * `ownerPublicKeyHex` 透传到 preview 上，让 submit 阶段可以校验 resource /
 * 签名 key 与该 owner 一致——owner 变了就拒绝广播。
 */
export interface P2pkhTransferPreview {
  assetId: P2pkhAssetId;
  network: BsvNetwork;
  ownerPublicKeyHex: string;
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
export type P2pkhTransferResultStatus =
  | "local-confirmed"
  | "isolated"
  | "conflicted"
  | "chain-confirmed"
  | "not-dispatched";

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

  /**
   * 订阅 P2PKH data-changed 事件。
   * 设计缘由：后台任务原子提交 K-V 后发布，页面收到后重读本地 K-V。
   * 不再依赖 sync status 变化猜测数据是否已提交。
   */
  onDataChanged(handler: () => void): () => void;

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
   * 应用新的全局设置：写 Coordinator 平台 K-V、更新进程内缓存、通知订阅者、
   * 并在 includeTestnet 由 false → true 时立即补齐 testnet 资源。
   * 设计缘由：硬切换 001 要求"再次开启 testnet 时立即把 testnet
   * 纳入运行范围"，但 storage 事件不会在本标签页触发，必须由写入
   * 路径主动通知 service。
   */
  applyGlobalSettings(settings: P2pkhGlobalSettings): Promise<void>;

  getAssetBalance(assetId: P2pkhAssetId): Promise<P2pkhBalance>;
  getResourceBalance(resourceId: string): Promise<P2pkhBalance>;

  listResources(assetId?: P2pkhAssetId): Promise<P2pkhKeyResource[]>;
  listUtxos(filter?: P2pkhUtxoFilter): Promise<P2pkhUtxo[]>;
  /** 不排除 protected outpoint 的原始 UTXO 读口，仅供协议级内部使用。 */
  listUtxosRaw?(filter?: P2pkhUtxoFilter): Promise<P2pkhUtxo[]>;
  listLocalInputClaims(resourceId?: string, limit?: number): Promise<P2pkhLocalInputClaim[]>;

  /** v10 fact/projection views. Optional keeps the public capability compatible with token consumers. */
  listTransactionFacts?(filter?: P2pkhUtxoFilter): Promise<P2pkhTransactionFact[]>;
  listOwnedOutpoints?(filter?: P2pkhUtxoFilter): Promise<P2pkhOwnedOutpointProjection[]>;
  listTransactionFactsPage?(filter?: P2pkhPageFilter): Promise<P2pkhPage<P2pkhTransactionFact>>;
  listOwnedOutpointsPage?(filter?: P2pkhPageFilter): Promise<P2pkhPage<P2pkhOwnedOutpointProjection>>;
  listOwnedOutpointValues?(resourceId: string, outpointKeys: string[]): Promise<Record<string, number>>;
  listLocalTransactions?(filter?: P2pkhUtxoFilter): Promise<P2pkhLocalTransaction[]>;
  listLocalOutpoints?(filter?: P2pkhUtxoFilter): Promise<P2pkhLocalOutpoint[]>;
  listLocalTransactionsPage?(filter?: P2pkhPageFilter): Promise<P2pkhPage<P2pkhLocalTransaction>>;
  listLocalOutpointsPage?(filter?: P2pkhPageFilter): Promise<P2pkhPage<P2pkhLocalOutpoint>>;
  listLocalInputClaimsPage?(filter?: P2pkhPageFilter): Promise<P2pkhPage<P2pkhLocalInputClaim>>;
  getBalanceBreakdown?(network?: BsvNetwork): Promise<P2pkhBalanceBreakdown>;
  getProviderSnapshot?(): P2pkhProviderRegistrySnapshot | undefined;

  allocateUtxos(request: UtxoAllocationRequest): Promise<UtxoAllocation>;

  /** 转移：prepare / preview。 */
  prepareTransfer(input: P2pkhTransferInput): Promise<P2pkhTransferPreview>;
  /** 转移：广播 preview 中已经生成好的最终交易。 */
  submitTransfer(preview: P2pkhTransferPreview): Promise<P2pkhTransferResult>;
  /** Explicitly revoke an initial submission only when no provider attempt exists. */
  abortUnattemptedLocalSubmission?(input: { ownerPublicKeyHex: string; submissionId: string; reason?: string }): Promise<void>;

  /**
   * 通知 P2PKH 新 key 已就绪（按 publicKeyHex 触发 rehydrate / background sync）。
   */
  onKeyImported(publicKeyHex: string): Promise<void>;
  /**
   * 通知 P2PKH 对应 publicKeyHex 的 key 已删除。service 应清理该 hex 的
   * 派生 cache / 取消 background 任务；但不要触碰 namespace K-V——该工作
   * 已经由 keyspace.deleteKey 在前面完成。
   */
  onKeyRemoved(publicKeyHex: string): Promise<void>;
  /** Vault 锁定时调用：取消当前所有 P2PKH 后台运行。 */
  onVaultLocked(): void;
  /** Vault 解锁时调用：重新绑定当前 key 并补齐资源。 */
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
 * Ready 状态 key 身份（硬切换 002 收尾）。
 *
 * KeyIdentity 已是 ready：canonical store 主键就是 publicKeyHex，Vault
 * 解锁完成后已经完成 canonical records / AAD 升级，所有"存活 key"都
 * 派生出了 identity。`ReadyKeyIdentity` 保留只是为了在 service 层里做
 * 窄类型投影，让"必须带 publicKeyHex"在静态检查层面成立。
 */
export interface ReadyKeyIdentity {
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
