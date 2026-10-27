import { requireWocNetwork } from "@keymaster/contracts";
import { sameWalletSession, assertP2pkhTransferRequestFields } from "@keymaster/contracts";
import { sameNetworkIdentity, requireUnlockedWalletIdentity, bindWalletIdentity } from "@keymaster/contracts";
// packages/plugin-p2pkh/src/p2pkhService.ts
// P2PKH 服务实现（2026-09-20 UTXO / 历史解耦后）。
//
// 关键设计：
//   - 业务实例绑定权威钱包身份与代际；查询不接受 owner/network 选择。
//     异步结果交付前校验绑定，失效实例不重新绑定其他钱包。
//   - 钱包余额与 UTXO 集合唯一来源 = Coordinator Worker manager 投影；
//     service 通过 `coordinator.p2pkhUtxosGet / p2pkhUtxosRefresh` 读取，
//     本地不再保存或派生任何 UTXO。
//   - 历史 = WoC history 元数据（txid/height/fee）；raw tx 只在详情页
//     懒加载并临时解析。
//   - 转账 prepare/submit 更新链上观察；占用、签名意图及 exact 责任归 manager。
//   - key.deleting / vault.locked 时释放 owner K-V 句柄。

import type {
  BalanceBroadcaster,
  CentralBroadcastService,
  CoordinatorValueResult,
  GlobalBalanceSnapshot,
  VaultWalletState,
  BorrowedModuleFileStore,
  VaultService,
  WocService,
  P2pkhCoordinatorControl,
  P2pkhBroadcastSubmission,
  P2pkhUtxoBinding,
  P2pkhUtxoSnapshotResult,
  P2pkhWorkerTransferBinding,
} from "@keymaster/contracts";
import { emptyGlobalBalanceSnapshot } from "@keymaster/contracts";
import type { MessageBus } from "webloom-framework";
import type {
  P2pkhBalance,
  P2pkhBalanceBreakdown,
  P2pkhKeyResource,
  P2pkhService as IP2pkhService,
  P2pkhTransactionDetail,
  P2pkhUtxo,
  P2pkhAvailableUtxos,
  P2pkhTransferPreview,
  P2pkhTransferResult,
} from "./p2pkhContracts.js";
import {
  assetIdToNetwork,
  makeResourceId,
  requireReadyKey,
  type ReadyKeyIdentity
} from "./p2pkhContracts.js";
import { createP2pkhStateRepository, disposeP2pkhStateRepository, openP2pkhStateRepository, type P2pkhStateRepositoryBundle, type P2pkhStateRepositoryHandle } from "./storage/p2pkhStateRepository.js";
import { createP2pkhTransferService } from "./p2pkhTransferService.js";

import { P2PKH_MSG } from "./p2pkhMessages.js";
import { p2pkhAddressCodec } from "./p2pkhAddressCodec.js";
import { canonicalizeP2pkhUtxos } from "./p2pkhCanonical.js";
import { parseP2pkhTransaction, p2pkhAddressToScriptHex } from "./p2pkhTransactionParser.js";

export const P2PKH_TASK_TRANSACTIONS_SYNC = "p2pkh.transactions-sync";

function validateReadQuery(query: unknown, local: boolean): void {
  if (query === undefined) return;
  if (!query || typeof query !== "object" || Array.isArray(query)) throw new TypeError("P2PKH query must be an object");
  const fields = new Set(["txid", "cursor", "limit", ...(local ? ["submissionId", "includeResolved"] : [])]);
  for (const [key, value] of Object.entries(query)) {
    if (!fields.has(key)) throw new TypeError(`Unsupported P2PKH query field: ${key}`);
    if (value === undefined) continue;
    if (key === "limit" && (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 1000)) throw new TypeError("P2PKH page limit must be 1–1000");
    if (key === "txid" && (typeof value !== "string" || !/^[0-9a-f]{64}$/iu.test(value))) throw new TypeError("P2PKH query txid is invalid");
    if ((key === "cursor" || key === "submissionId") && (typeof value !== "string" || !value)) throw new TypeError(`P2PKH query ${key} is invalid`);
    if (key === "includeResolved" && typeof value !== "boolean") throw new TypeError("P2PKH includeResolved must be boolean");
  }
}

/** 未知余额的占位明细；这些 0 不能直接渲染为真实余额。 */
const EMPTY_BALANCE_BREAKDOWN: P2pkhBalanceBreakdown = {
  confirmed: 0,
  unconfirmed: 0,
  spendable: 0,
};

function unknownP2pkhBalance(): P2pkhBalance {
  return {
    total: 0,
    available: false,
    breakdown: { ...EMPTY_BALANCE_BREAKDOWN },
  };
}

function cloneP2pkhBalance(balance: P2pkhBalance): P2pkhBalance {
  return {
    ...balance,
    ...(balance.breakdown ? { breakdown: { ...balance.breakdown } } : {}),
  };
}

function cloneGlobalBalanceSnapshot(snapshot: GlobalBalanceSnapshot): GlobalBalanceSnapshot {
  return {
    ...snapshot,
    balance: cloneP2pkhBalance(snapshot.balance),
  };
}

function sameP2pkhBalance(left: P2pkhBalance | undefined, right: P2pkhBalance | undefined): boolean {
  if (!left || !right) return left === right;
  return left.total === right.total
    && left.available === right.available
    && JSON.stringify(left.breakdown ?? null) === JSON.stringify(right.breakdown ?? null);
}

function sameGlobalBalanceContent(left: GlobalBalanceSnapshot, right: GlobalBalanceSnapshot): boolean {
  if (left.publicKeyHex !== right.publicKeyHex || left.bsvNetwork !== right.bsvNetwork) return false;
  return sameP2pkhBalance(left.balance, right.balance);
}

/** UTXO 快照项 → service 内部 UTXO 视图（script 由地址确定性生成）。 */
function snapshotItemToUtxo(input: {
  item: NonNullable<P2pkhUtxoSnapshotResult["items"]>[number];
  resource: P2pkhKeyResource;
}): P2pkhUtxo {
  const { item, resource } = input;
  return {
    id: `utxo:${resource.resourceId}:${item.txid}:${item.vout}`,
    resourceId: resource.resourceId,
    publicKeyHex: resource.publicKeyHex,
    network: resource.network,
    address: resource.address,
    txid: item.txid,
    vout: item.vout,
    value: item.value,
    height: item.height,
    script: p2pkhAddressToScriptHex(resource.address, resource.network),
    status: item.status,
    isSpentInMempoolTx: item.isSpentInMempoolTx,
    syncedAt: new Date().toISOString(),
  };
}

/**
 * 余额明细：只由 UTXO 快照现算。
 *
 * 快照不可用时返回 `available: false`，调用方必须显示“未知/不可用”，
 * 不得把 total 当 0。
 */
export function calculateP2pkhBalanceBreakdown(input: {
  snapshot: P2pkhUtxoSnapshotResult;
}): P2pkhBalanceBreakdown {
  if (!input.snapshot.hasResult) {
    return { confirmed: 0, unconfirmed: 0, spendable: 0 };
  }
  const spendableItems = input.snapshot.items.filter((item) => !item.isSpentInMempoolTx);
  const confirmed = spendableItems.filter((item) => item.status === "confirmed").reduce((sum, item) => sum + item.value, 0);
  const unconfirmed = spendableItems.filter((item) => item.status === "unconfirmed").reduce((sum, item) => sum + item.value, 0);
  return {
    confirmed,
    unconfirmed,
    spendable: confirmed + unconfirmed,
  };
}

export interface P2pkhServiceDeps {
  vault: Pick<VaultService, "status" | "createActiveKeyCrypto">;
  coordinator?: Pick<P2pkhCoordinatorControl, "p2pkhUtxosGet" | "p2pkhUtxosRefresh" | "p2pkhArtifactOccupy">
    & Partial<Pick<P2pkhCoordinatorControl, "subscribeTopic" | "p2pkhPaymentStatus">>;
  messageBus: MessageBus;
  /** Issuing runtime instance; fences publications before asynchronous cleanup. */
  signal?: AbortSignal;
  walletState: VaultWalletState;
  /** Host 已按 manifest 声明绑定的当前 owner K-V 句柄。 */
  storage: BorrowedModuleFileStore;
  /** Worker-created durable UTXO Manager; absent only for Window read-only test fixtures. */
  utxoManager?: import("./p2pkhUtxoManager.js").P2pkhUtxoManager;
  /** Window production transfers are executed by the Worker-owned manager/signer path. */
  workerTransfer?: P2pkhWorkerTransferBinding;
  /** 详情页懒加载 raw transaction 的唯一来源。 */
  woc?: WocService;
  /** 页面侧唯一中心广播服务；普通转账和协议 spend 共用。 */
  centralBroadcastService?: CentralBroadcastService;
  /** SharedWorker 内部兼容面，仅供 sat top-up 装配；页面 manifest 不注入。 */
  broadcastWithCoordinator?: (input: { ownerPublicKeyHex: string; network: "main" | "test"; submissionId: string; submission?: P2pkhBroadcastSubmission }) => Promise<CoordinatorValueResult<unknown>>;
  /**
   * Worker 实际准备交易时的必需手续费端口：本次 prepare 开始构造计划时读取一次有效费率。
   * Window 路径（存在 workerTransfer）不得使用它，Window 原样转交可选费率，不补默认值。
   * 缺省/非法/未装配一律报错停止，不做 `?? 100` 降级；100 fallback 只在 chainFees 解析逻辑中保留。
   */
  effectiveFeeRate?: (network: "main" | "test") => number;
  /**
   * 选币前的门禁：等待受保护输出登记恢复完成。
   *
   * 专用资金的保护是**内存态**，重启后需要从磁盘记录重建。在这个恢复完成之前放行
   * 选币，一次普通转账就可能把仍属于用户的专用 UTXO 当成可用余额花掉。因此每个
   * 会消费 UTXO 的入口都必须先过这道门禁；拒绝（抛错）比放行安全。
   */
  awaitProtectionRestore?(): Promise<void>;
}

/** 门禁缺席时按「没有待恢复的保护」处理：不阻塞既有行为。 */
function protectionGate(deps: P2pkhServiceDeps): () => Promise<void> {
  return async () => {
    await deps.awaitProtectionRestore?.();
  };
}

export function createP2pkhService(deps: P2pkhServiceDeps): {
  service: IP2pkhService;
  balance: BalanceBroadcaster;
  dataChanges: { subscribe(handler: () => void): () => void };
} {
  if (!deps.storage) throw new Error("P2PKH central storage binding is required");
  const walletBinding = bindWalletIdentity(deps.walletState, deps.signal);
  const walletIdentity = walletBinding.identity;
  let disposed = false;
  const isCurrentInstance = () => !disposed && !deps.signal?.aborted;
  function assertWalletSession(): void {
    if (!isCurrentInstance()) throw new Error("P2PKH wallet session is no longer active");
    walletBinding.assertActive();
  }
  function publish<T>(type: string, payload: T): void {
    if (isCurrentInstance()) { const identity=deps.walletState.snapshot().activeKeyIdentity; deps.messageBus.publish(type, identity && payload && typeof payload === "object" ? {...payload,networkIdentity:{bsvNetwork:identity.bsvNetwork,publicKeyHex:identity.publicKeyHex}} : payload); }
  }
  let activeIdentity: ReadyKeyIdentity | undefined = requireReadyKey(walletIdentity);
  let balanceSnapshot = emptyGlobalBalanceSnapshot();
  const balanceListeners = new Set<(snapshot: GlobalBalanceSnapshot) => void>();
  let balanceRefreshGeneration = 0;
  let balanceRefreshInFlight: Promise<void> | undefined;
  let balanceRefreshRequested = false;

  const balanceBroadcaster: BalanceBroadcaster = {
    getSnapshot() {
      // 读取方可能在 walletState/session 事件落地前先拿到资源重载；不允许
      // 把上一个 owner 的快照短暂暴露给新 owner。
      const active = deps.walletState.snapshot().activePublicKeyHex?.trim().toLowerCase() ?? "";
      if (!isCurrentInstance() || !walletBinding.isActive() || deps.vault.status() !== "unlocked" || !active || balanceSnapshot.publicKeyHex !== active) {
        return emptyGlobalBalanceSnapshot();
      }
      return cloneGlobalBalanceSnapshot(balanceSnapshot);
    },
    subscribe(handler) {
      balanceListeners.add(handler);
      return () => balanceListeners.delete(handler);
    },
  };

  function publishBalanceSnapshot(next: Omit<GlobalBalanceSnapshot, "revision">): void {
    if (!isCurrentInstance()) return;
    const candidate: GlobalBalanceSnapshot = { ...next, revision: balanceSnapshot.revision };
    if (sameGlobalBalanceContent(balanceSnapshot, candidate)) return;
    balanceSnapshot = {
      ...candidate,
      revision: balanceSnapshot.revision + 1,
      balance: cloneP2pkhBalance(candidate.balance),
    };
    const published = cloneGlobalBalanceSnapshot(balanceSnapshot);
    publish(P2PKH_MSG.BALANCE_CHANGED, published);
    for (const listener of [...balanceListeners]) {
      try {
        listener(cloneGlobalBalanceSnapshot(published));
      } catch {
        // 余额观察者不能影响余额快照提交。
      }
    }

  }

  function clearBalanceSnapshot(): void {
    balanceRefreshGeneration++;
    const empty = emptyGlobalBalanceSnapshot();
    publishBalanceSnapshot({
      publicKeyHex: empty.publicKeyHex,
      bsvNetwork: empty.bsvNetwork,
      balance: empty.balance,
    });
  }

  /** 详情页懒加载缓存：只存解析结果，不落盘；上限 32 条。 */
  const transactionDetailCache = new Map<string, P2pkhTransactionDetail>();

  async function loadTransactionDetail(input: { txid: string }): Promise<P2pkhTransactionDetail | undefined> {
    assertWalletSession();
    const txid = input.txid.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/u.test(txid)) throw new Error("P2PKH transaction detail requires a valid txid");
    const cacheKey = txid;
    const cached = transactionDetailCache.get(cacheKey);
    if (cached) return cached;
    if (!deps.woc?.getRawTransaction) throw new Error("WoC raw transaction capability is unavailable");
    const rawTxHex = (await requireWocNetwork(deps.woc, walletIdentity.bsvNetwork).getRawTransaction(txid, { priority: "background" })).replace(/^0x/i, "").toLowerCase();
    assertWalletSession();
    const parsed = parseP2pkhTransaction(rawTxHex, txid);
    const detail: P2pkhTransactionDetail = {
      txid: parsed.canonicalTxid,
      network: walletIdentity.bsvNetwork,
      inputs: parsed.inputs.map((row) => ({ txid: row.prevTxid, vout: row.prevVout, outpointKey: row.outpointKey })),
      outputs: parsed.outputs,
      sizeBytes: rawTxHex.length / 2,
    };
    transactionDetailCache.set(cacheKey, detail);
    while (transactionDetailCache.size > 32) {
      const oldest = transactionDetailCache.keys().next().value;
      if (oldest === undefined) break;
      transactionDetailCache.delete(oldest);
    }
    return detail;
  }

  async function requireUtxoSnapshot(input: { ownerPublicKeyHex: string; network: "main" | "test" }, mode: "get" | "refresh"): Promise<P2pkhUtxoSnapshotResult> {
    if (!deps.coordinator) throw new Error("Coordinator UTXO snapshot capability is unavailable");
    const result = mode === "refresh"
      ? await deps.coordinator.p2pkhUtxosRefresh({ ownerPublicKeyHex: input.ownerPublicKeyHex, network: input.network })
      : await deps.coordinator.p2pkhUtxosGet({ ownerPublicKeyHex: input.ownerPublicKeyHex, network: input.network });
    if (result.status !== "ok") {
      const message = "message" in result ? result.message : "Coordinator UTXO snapshot request failed";
      throw new Error(message);
    }
    return result.value;
  }

  /** 返回原资源和内容编号；未取得结果时没有绑定，不授予资金权限。 */
  async function getUtxoBinding(input: { ownerPublicKeyHex: string; network: "main" | "test" }): Promise<P2pkhUtxoBinding | undefined> {
    const snapshot = await requireUtxoSnapshot(input, "get");
    if (!snapshot.hasResult) return undefined;
    return { resourceId: makeResourceId(input.network), seq: snapshot.seq };
  }

  /** 从快照得到该 owner/network 的可花费 UTXO（只排除内存池已花费输出）。 */
  async function listSpendableUtxosFromSnapshot(input: {
    resource: P2pkhKeyResource;
    snapshot: P2pkhUtxoSnapshotResult;
    ownerPublicKeyHex: string;
  }): Promise<P2pkhUtxo[]> {
    if (!input.snapshot.hasResult) return [];
    const candidates = input.snapshot.items
      .filter((item) => !item.isSpentInMempoolTx)
      .map((item) => snapshotItemToUtxo({ item, resource: input.resource }));
    return canonicalizeP2pkhUtxos(candidates);
  }

  /** 同一身份、同一 manager 投影；读取和刷新共享 DTO 与映射规则。 */
  async function readAvailableUtxos(mode: "get" | "refresh"): Promise<P2pkhAvailableUtxos> {
    assertWalletSession();
    const snapshot = await requireUtxoSnapshot({ ownerPublicKeyHex: walletIdentity.publicKeyHex, network: walletIdentity.bsvNetwork }, mode);
    assertWalletSession();
    if (!snapshot.hasResult) return { hasResult: false, utxos: null, seq: null, syncedAt: null };
    const resource: P2pkhKeyResource = {
      resourceId: makeResourceId(walletIdentity.bsvNetwork), publicKeyHex: walletIdentity.publicKeyHex,
      address: p2pkhAddressCodec.deriveAddress(walletIdentity.publicKeyHex, walletIdentity.bsvNetwork),
      network: walletIdentity.bsvNetwork, label: walletIdentity.label, createdAt: walletIdentity.createdAt, generation: 0,
    };
    return {
      hasResult: true, seq: snapshot.seq, syncedAt: snapshot.syncedAt,
      utxos: canonicalizeP2pkhUtxos(snapshot.items.filter(item => !item.isSpentInMempoolTx)
        .map(item => snapshotItemToUtxo({ item, resource }))),
    };
  }

  // 中文：每次 submit 都有独立取消信号；切 owner、锁仓或销毁 service
  // 时全部终止等待新快照，避免旧 owner 的重试继续运行。
  const transferRetryControllers = new Set<AbortController>();
  function abortTransferRetries(): void {
    for (const controller of transferRetryControllers) controller.abort();
    transferRetryControllers.clear();
  }

  const transfer = createP2pkhTransferService({
    async previousTransactions(network, inputs) {
      if (!deps.woc?.getRawTransaction) throw new Error("Previous transaction evidence is unavailable");
      const fetched = new Map<string, Promise<string>>();
      return Promise.all(inputs.map(input => {
        let raw = fetched.get(input.txid);
        if (!raw) { raw = requireWocNetwork(deps.woc!, network).getRawTransaction(input.txid); fetched.set(input.txid, raw); }
        return raw;
      }));
    },
    async assertInputsUnspent(network, inputs) {
      if (!deps.woc?.getSpentOutput) throw new Error("Spent-output evidence is unavailable");
      await Promise.all(inputs.map(async ({ txid, vout }) => {
        if (await requireWocNetwork(deps.woc!, network).getSpentOutput(txid, vout) !== null) throw new Error(`P2PKH input is already spent: ${txid}:${vout}`);
      }));
    },
    vault: deps.vault,
    utxoManager: deps.utxoManager,
    centralBroadcastService: deps.centralBroadcastService,
    broadcastWithCoordinator: deps.broadcastWithCoordinator,
    messageBus: deps.messageBus,
    getStore: (publicKeyHex) => ensureRepositoryForOwner(publicKeyHex),
    loadSpendableUtxos: async ({ ownerPublicKeyHex, resource, purpose }) => {
      // 转账与其它花 UTXO 的入口共用同一道门禁。
      await protectionGate(deps)();
      if (!deps.utxoManager) throw new Error("Wallet funding requires the Worker manager");
      let snapshot: P2pkhUtxoSnapshotResult;
      try {
        snapshot = await requireUtxoSnapshot({ ownerPublicKeyHex, network: resource.network }, "refresh");
      } catch (error) {
        // A failed provider observation cannot erase durable manager facts.
        // The manager still independently validates the held inputs and spend proofs.
        return { utxos: [] };
      }
      const utxos = await listSpendableUtxosFromSnapshot({ resource, snapshot, ownerPublicKeyHex });
      return { utxos };
    },
    getUtxoBinding: async ({ ownerPublicKeyHex, resource }) => getUtxoBinding({ ownerPublicKeyHex, network: resource.network }),
    getActiveKey: () => {
      const state = getVaultLifecycleSnapshot();
      if (!state.activePublicKeyHex) {
        throw new Error("Active key is required");
      }
      if (!activeIdentity) {
        throw new Error("Active key is not ready");
      }
      if (activeIdentity.publicKeyHex !== state.activePublicKeyHex) {
        throw new Error("Active key is not ready");
      }
      return activeIdentity;
    },
    getKeyForOwner: async (ownerPublicKeyHex: string) => {
      // 单 Key 本地钱包（docs/存储.md）：只有一把 Key，业务对象里的
      // ownerPublicKeyHex 仍然要与当前身份比对，但不是目录前缀，也不能用来
      // 列举或选择第二把 Key。
      const active = deps.walletState.snapshot().activePublicKeyHex;
      if (!active || active.toLowerCase() !== ownerPublicKeyHex.toLowerCase()) {
        throw new Error(`P2PKH owner key not found: ${ownerPublicKeyHex}`);
      }
      const key = requireUnlockedWalletIdentity(deps.walletState.snapshot());
      return {
        bsvNetwork: key.bsvNetwork,
        publicKeyHex: key.publicKeyHex,
        label: key.label,
        capabilities: key.capabilities,
        createdAt: key.createdAt
      } as ReadyKeyIdentity;
    }
  });

  const messageBusUnsubs: Array<() => void> = [];
  function trackSubscribe<TPayload>(type: string, handler: (p: TPayload) => void) {
    const off = deps.messageBus.subscribe<TPayload>(type, handler);
    messageBusUnsubs.push(off);
    return off;
  }
  function requireWorkerEffectiveFeeRate(): number {
    assertWalletSession();
    // Worker 必需端口：未装配、非法快照一律报错停止，不做 fallback 掩盖。
    if (!deps.effectiveFeeRate) throw new Error("P2PKH fee rate capability is unavailable");
    const rate = deps.effectiveFeeRate(walletIdentity.bsvNetwork);
    if (!Number.isSafeInteger(rate) || rate < 1) throw new Error("P2PKH effective fee rate is invalid");
    return rate;
  }

  function getVaultLifecycleSnapshot() {
    return deps.walletState.snapshot();
  }

  function requireActiveKeyIdentity(): ReadyKeyIdentity {
    const state = getVaultLifecycleSnapshot();
    if (!state.activePublicKeyHex) {
      throw new Error("Active key is required");
    }
    if (!activeIdentity || activeIdentity.publicKeyHex !== state.activePublicKeyHex.toLowerCase()) {
      throw new Error("Active key is not ready");
    }
    return activeIdentity;
  }

  async function ensureRepositoryForOwner(publicKeyHex: string): Promise<P2pkhStateRepositoryHandle> {
    assertWalletSession();
    const active = walletIdentity.publicKeyHex.toLowerCase();
    if (active !== publicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
    const bundle: P2pkhStateRepositoryBundle = await openP2pkhStateRepository(deps.storage);
    assertWalletSession();
    return createP2pkhStateRepository(bundle);
  }

  async function ensureRepository(): Promise<P2pkhStateRepositoryHandle> {
    const state = getVaultLifecycleSnapshot();
    if (!state.activePublicKeyHex) {
      throw new Error("Key storage is not ready");
    }
    return ensureRepositoryForOwner(state.activePublicKeyHex);
  }

  async function calculateBalanceBreakdown(network: "main" | "test"): Promise<{ breakdown: P2pkhBalanceBreakdown; available: boolean }> {
    const active = getVaultLifecycleSnapshot().activePublicKeyHex;
    if (!active) return { breakdown: { confirmed: 0, unconfirmed: 0, spendable: 0 }, available: false };
    let snapshot: P2pkhUtxoSnapshotResult;
    try {
      snapshot = await requireUtxoSnapshot({ ownerPublicKeyHex: active, network }, "get");
    } catch {
      // 快照不可用（冷启动/刷新失败）：余额未知，绝不当 0。
      snapshot = { hasResult: false, items: null, seq: null, syncedAt: null };
    }
    return { breakdown: calculateP2pkhBalanceBreakdown({ snapshot }), available: snapshot.hasResult };
  }

  /**
   * 从 Coordinator 内存 UTXO 快照重算余额广播。
   *
   * 这里只调用 p2pkhUtxosGet（窗口到 Worker 的内存读），不会触发 WoC 请求；
   * 所有 WoC 网络访问仍由 Worker 的单点刷新任务负责。
   */
  async function refreshBalanceSnapshotImpl(): Promise<void> {
    if (!isCurrentInstance()) return;
    if (!walletBinding.isActive()) { clearBalanceSnapshot(); return; }
    const session = deps.walletState.snapshot();
    const generation = ++balanceRefreshGeneration;
    const active = getVaultLifecycleSnapshot().activePublicKeyHex?.trim().toLowerCase() ?? "";
    const bsvNetwork = walletIdentity.bsvNetwork;
    if (!active || deps.vault.status() !== "unlocked") {
      clearBalanceSnapshot();
      return;
    }

    if (balanceSnapshot.publicKeyHex !== active || balanceSnapshot.bsvNetwork !== bsvNetwork) {
      publishBalanceSnapshot({ publicKeyHex: active, bsvNetwork, balance: unknownP2pkhBalance() });
    }
    const result = await calculateBalanceBreakdown(bsvNetwork);
    const balance: P2pkhBalance = {
      total: result.breakdown.spendable, available: result.available, breakdown: result.breakdown,
    };

    // 异步读取期间可能发生 owner/settings 切换；旧结果不能覆盖新 owner。
    if (!isCurrentInstance() || generation !== balanceRefreshGeneration || !sameWalletSession(session, deps.walletState.snapshot())) return;
    const currentOwner = getVaultLifecycleSnapshot().activePublicKeyHex?.trim().toLowerCase() ?? "";
    if (!currentOwner || currentOwner !== active || walletIdentity.bsvNetwork !== bsvNetwork || deps.vault.status() !== "unlocked") {
      return;
    }
    publishBalanceSnapshot({
      publicKeyHex: active,
      bsvNetwork,
      balance,
    });
  }

  function refreshBalanceSnapshot(): Promise<void> {
    // Coalesce reads, but do not lose an observation committed while an older
    // projection read is in flight. This is event-driven, never a poll loop.
    if (balanceRefreshInFlight) {
      balanceRefreshRequested = true;
      return balanceRefreshInFlight;
    }
    balanceRefreshRequested = false;
    const promise = refreshBalanceSnapshotImpl();
    balanceRefreshInFlight = promise;
    const finish = () => {
      if (balanceRefreshInFlight !== promise) return;
      balanceRefreshInFlight = undefined;
      if (balanceRefreshRequested && isCurrentInstance() && deps.vault.status() === "unlocked") {
        balanceRefreshRequested = false;
        void refreshBalanceSnapshot().catch(() => {});
      }
    };
    void promise.then(finish, finish);
    return promise;
  }

  async function rebindActiveKey() {
    assertWalletSession();
    const state = getVaultLifecycleSnapshot();
    if (!state.activePublicKeyHex) {
      activeIdentity = undefined;
      return;
    }
    // walletState 只投影「当前唯一 Key 是谁」；锁定/未初始化时 active() 缺省，
    // requireUnlockedWalletIdentity() 抛错由调用方收敛到锁定态。
    activeIdentity = requireReadyKey(requireUnlockedWalletIdentity(deps.walletState.snapshot()));
  }

  const walletStateUnsubs: Array<() => void> = [];
  function trackWalletStateSubscribe(handler: () => void) {
    const off = deps.walletState.subscribe(handler);
    walletStateUnsubs.push(off);
    return off;
  }
  let observedWalletSession = deps.walletState.snapshot();
  trackWalletStateSubscribe(() => {
    const nextSession = deps.walletState.snapshot();
    const sessionChanged = !sameWalletSession(observedWalletSession, nextSession);
    observedWalletSession = nextSession;
    abortTransferRetries();
    const nextOwner = getVaultLifecycleSnapshot().activePublicKeyHex?.trim().toLowerCase() ?? "";
    if (sessionChanged || balanceSnapshot.publicKeyHex !== nextOwner) {
      activeIdentity = undefined;
      clearBalanceSnapshot();
    }
    void (async () => {
      try {
        const state = getVaultLifecycleSnapshot();
        await rebindActiveKey();
        if (!isCurrentInstance() || !sameWalletSession(state, deps.walletState.snapshot())) return;
        await rehydrateResources();
        if (!isCurrentInstance() || !sameWalletSession(state, deps.walletState.snapshot())) return;
        await refreshBalanceSnapshot();
      } catch {
        // A revoked instance cannot reload resources or publish a fallback.
      }
    })();
  });

  trackSubscribe<{ publicKeyHex: string }>("key.deleting", () => {
    abortTransferRetries();
    clearBalanceSnapshot();
    try {
      disposeP2pkhStateRepository();
    } catch {
      // key.deleted handler below remains an idempotent safety net.
    }
  });
  trackSubscribe<{ publicKeyHex: string }>("key.deleted", async () => {
    abortTransferRetries();
    clearBalanceSnapshot();
    try {
      disposeP2pkhStateRepository();
    } catch {
      // swallow
    }
  });

  async function getOrCreateAddress(): Promise<P2pkhKeyResource> {
    assertWalletSession();
    const network = walletIdentity.bsvNetwork;
    const stateRepository = await ensureRepository();
    const resourceId = makeResourceId(network);
    const existing = await stateRepository.getResource(resourceId);
    assertWalletSession();
    if (existing) {
      if (existing.publicKeyHex !== walletIdentity.publicKeyHex || existing.network !== network) throw new Error("P2PKH stored resource identity mismatch");
      return existing;
    }
    const key = requireActiveKeyIdentity();
    const address = p2pkhAddressCodec.deriveAddress(key.publicKeyHex, network);
    const resource: P2pkhKeyResource = {
      resourceId,
      publicKeyHex: key.publicKeyHex,
      label: key.label,
      address,
      network,
      createdAt: key.createdAt,
      lastSyncedAt: undefined,
      generation: 0
    };
    await stateRepository.putAddress(resource);
    publish(P2PKH_MSG.ADDRESS_DERIVED, {
      publicKeyHex: key.publicKeyHex,
      network,
      address,
      generation: 0
    });
    return resource;
  }

  trackSubscribe("vault.locked", () => {
    onVaultLocked();
  });
  trackSubscribe("vault.unlocked", () => {
    void onVaultUnlocked();
  });

  function onVaultLocked() {
    abortTransferRetries();
    disposeP2pkhStateRepository();
    activeIdentity = undefined;
    transactionDetailCache.clear();
    clearBalanceSnapshot();
  }

  async function onVaultUnlocked() {
    try {
      await rebindActiveKey();
      await rehydrateResources();
      await refreshBalanceSnapshot();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      publish(P2PKH_MSG.REHYDRATE_ERROR, {
        error: msg
      });
    }
  }

  async function rehydrateResources(): Promise<void> {
    if (deps.vault.status() !== "unlocked") return;
    const state = getVaultLifecycleSnapshot();
    if (!state.activePublicKeyHex) return;
    if (!activeIdentity) return;
    let rehydrateError: unknown;
    try {
      await getOrCreateAddress();
    } catch (err) {
      rehydrateError = err;
    }
    if (rehydrateError) {
      const msg = rehydrateError instanceof Error ? rehydrateError.message : String(rehydrateError);
      publish(P2PKH_MSG.REHYDRATE_ERROR, {
        error: msg
      });
      return;
    }
    // 冷启动余额可见性：地址资源就绪后主动刷新一次内存 UTXO 快照。
    // 失败只保留“未知/不可用”，不写 0；成功由 Worker 发布 data-changed。
    void readAvailableUtxos("refresh").catch(() => undefined);
    void refreshBalanceSnapshot();
  }

  trackSubscribe(P2PKH_MSG.TRANSFER_BROADCAST, () => undefined);

  const dataChangedListeners = new Set<() => void>();
  const coordinatorUnsubs: Array<() => void> = [];
  function trackCoordinatorSubscribe(topic: "session.state" | "asset.data-changed", handler: (event: any) => void): void {
    if (!deps.coordinator || typeof deps.coordinator.subscribeTopic !== "function") return;
    coordinatorUnsubs.push(deps.coordinator.subscribeTopic(topic, handler));
  }

  // session.state 先于 walletState 异步回调到达时，也要立即清掉旧 owner 的余额。
  trackCoordinatorSubscribe("session.state", (event) => {
    if (event?.type !== "session.state.changed") return;
    const owner = event.vaultStatus === "unlocked" && typeof event.activePublicKeyHex === "string"
      ? event.activePublicKeyHex.trim().toLowerCase()
      : "";
    if (!owner || owner !== balanceSnapshot.publicKeyHex) {
      activeIdentity = owner ? activeIdentity : undefined;
      clearBalanceSnapshot();
    }
    // 不在这里直接重算：session.state 可能先于 walletState 的本地 owner 状态到达，
    // 此时读取 walletState 会拿到旧 owner，反而可能把刚清空的旧余额重新发布。
    // walletState 变化回调会在 owner 真正切换后负责重算。
  });

  trackCoordinatorSubscribe("asset.data-changed", (event) => {
    const session = getVaultLifecycleSnapshot();
    const active = session.activeKeyIdentity;
    if (event?.providerId !== "p2pkh" || event.sessionEpoch !== session.sessionEpoch || !active || !event.networkIdentity || !sameNetworkIdentity(active, event.networkIdentity)) return;
    void refreshBalanceSnapshot();
    for (const listener of dataChangedListeners) {
      try { listener(); } catch { /* observers do not affect money state */ }
    }
  });

  // 初次装配也发布一份当前 owner 的只读投影；无 active key 时保持空快照。
  void refreshBalanceSnapshot();

  const service: IP2pkhService = {
    async getPaymentStatus(input) {
      assertWalletSession();
      if (Object.keys(input).some(key => key !== "paymentId")) throw new TypeError("Payment status accepts only paymentId");
      if (typeof input.paymentId !== "string" || !input.paymentId) throw new TypeError("Payment status requires paymentId");
      const boundInput = { paymentId: input.paymentId, ownerPublicKeyHex: walletIdentity.publicKeyHex, network: walletIdentity.bsvNetwork };
      if (deps.utxoManager) {
        const result = await deps.utxoManager.paymentStatus(boundInput); assertWalletSession(); return result;
      }
      if (!deps.coordinator?.p2pkhPaymentStatus) throw new Error("Payment manager status RPC unavailable");
      const result = await deps.coordinator.p2pkhPaymentStatus(boundInput); assertWalletSession();
      if (result.status !== "ok") throw new Error("message" in result ? result.message : `Payment manager status: ${result.status}`);
      return result.value;
    },
    async getRawTransaction(txid) {
      assertWalletSession();
      if (!/^[0-9a-f]{64}$/iu.test(txid)) throw new TypeError("Transaction ID is invalid");
      if (!deps.woc?.getRawTransaction) throw new Error("Previous transaction evidence is unavailable");
      const raw = await requireWocNetwork(deps.woc, walletIdentity.bsvNetwork).getRawTransaction(txid);
      assertWalletSession();
      return raw;
    },
    getAvailableUtxos: () => readAvailableUtxos("get"),
    refreshUtxos: () => readAvailableUtxos("refresh"),
    async listHistory(query) {
      validateReadQuery(query, false);
      const filter = { ...query };
      const repository = await ensureRepository();
      const page = await repository.listHistoryPage({ ...filter, resourceId: makeResourceId(walletIdentity.bsvNetwork), network: walletIdentity.bsvNetwork });
      assertWalletSession();
      return page;
    },
    async listLocalTransactions(query) {
      validateReadQuery(query, true);
      const filter = { ...query };
      const repository = await ensureRepository();
      const page = await repository.listLocalTransactionsPage({ ...filter, resourceId: makeResourceId(walletIdentity.bsvNetwork) });
      assertWalletSession();
      return page;
    },
    async prepareTransfer(input) {
      assertWalletSession();
      assertP2pkhTransferRequestFields(input);
      // Window 只转交、不补默认值；Worker 在本次 prepare 开始构造计划时读取一次有效费率并冻结进预览。
      // 显式费率按现有契约校验后使用；修改策略不改变已有预览，重新 prepare 才使用新策略。
      if (deps.workerTransfer) {
        const worker = await deps.workerTransfer.getService();
        assertWalletSession();
        const result = await worker.prepareTransfer({ ...input }) as P2pkhTransferPreview;
        assertWalletSession();
        return result;
      }
      const feeRateSatoshisPerKb = input.feeRateSatoshisPerKb ?? requireWorkerEffectiveFeeRate();
      if (!Number.isSafeInteger(feeRateSatoshisPerKb) || feeRateSatoshisPerKb < 1) throw new Error("P2PKH effective fee rate is invalid");
      const preparedInput = { ...input, feeRateSatoshisPerKb, ownerPublicKeyHex: walletIdentity.publicKeyHex, assetId: walletIdentity.bsvNetwork === "test" ? "bsvtest" as const : "bsv" as const };
      const result: P2pkhTransferPreview = await transfer.prepare(preparedInput);
      assertWalletSession();
      return result;
    },
    async submitTransfer(preview) {
      assertWalletSession();
      if (preview.ownerPublicKeyHex !== walletIdentity.publicKeyHex || preview.network !== walletIdentity.bsvNetwork
        || assetIdToNetwork(preview.assetId) !== walletIdentity.bsvNetwork) throw new Error("Transfer preview wallet identity mismatch");
      if (deps.workerTransfer) {
        const worker = await deps.workerTransfer.getService(); assertWalletSession();
        const result = await worker.submitTransfer(preview); assertWalletSession(); return result;
      }
      const controller = new AbortController();
      transferRetryControllers.add(controller);
      try {
        const result = await transfer.submit(preview, { signal: controller.signal });
        assertWalletSession();
        return result;
      } finally { transferRetryControllers.delete(controller); }
    },

    /**
     * 外露 artifact 的占用（跨 Runtime 路径）。
     *
     * 中文说明：Window 不直接持有 Worker 的能力，只能经受限 Coordinator 请求
     * Worker 让 UTXO Manager 占住这件 artifact 的钱包输入。
     */
    async occupyDeliveredArtifact(input) {
      assertWalletSession();
      if ("ownerPublicKeyHex" in input || "network" in input) throw new TypeError("Artifact request cannot select a wallet");
      const occupy = deps.coordinator?.p2pkhArtifactOccupy;
      if (!occupy) throw new Error("P2PKH artifact occupation is unavailable");
      const result = await occupy({ ...input, ownerPublicKeyHex: walletIdentity.publicKeyHex, network: walletIdentity.bsvNetwork });
      assertWalletSession();
      if (result.status !== "ok") throw new Error(`P2PKH artifact occupation failed: ${result.status}`);
      return result.value;
    },

    /**
     * 按预览 ID 提交 Worker 自己记住的预览（跨 Runtime 路径）。
     *
     * 中文说明：Window 只带 previewId；选币、金额、找零与 manager allocation
     * 全部以 Worker 的记录为准，页面无法改写。
     */
    submitPreparedTransfer: (previewId: string) => {
      if (deps.workerTransfer) return Promise.reject(new Error("P2PKH prepared submit is worker-only"));
      const controller = new AbortController();
      transferRetryControllers.add(controller);
      return transfer.submitPrepared(previewId, { signal: controller.signal }).finally(() => {
        transferRetryControllers.delete(controller);
      });
    },

    async onKeyImported() {
      try {
        await rehydrateResources();
      } catch {
      }
    },
    async onKeyRemoved() {
      abortTransferRetries();
      clearBalanceSnapshot();
      try {
        disposeP2pkhStateRepository();
      } catch {
        // swallow
      }
    },
    onVaultLocked,
    onVaultUnlocked,
    async rehydrate() {
      await rebindActiveKey();
      await rehydrateResources();
      await refreshBalanceSnapshot();
    },
    async getTransactionDetail(input) {
      return loadTransactionDetail(input);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      balanceRefreshGeneration += 1;
      abortTransferRetries();
      for (const off of messageBusUnsubs) {
        try {
          off();
        } catch {
          // swallow
        }
      }
      messageBusUnsubs.length = 0;
      for (const off of walletStateUnsubs) {
        try {
          off();
        } catch {
          // swallow
        }
      }
      walletStateUnsubs.length = 0;
      for (const off of coordinatorUnsubs) {
        try {
          off();
        } catch {
          // swallow
        }
      }
      coordinatorUnsubs.length = 0;
      balanceListeners.clear();
      clearBalanceSnapshot();
      try {
        disposeP2pkhStateRepository();
      } catch {
        // swallow
      }
      transactionDetailCache.clear();
      dataChangedListeners.clear();
    }
  };
  return {
    service,
    balance: balanceBroadcaster,
    dataChanges: {
      subscribe(handler: () => void) {
        dataChangedListeners.add(handler);
        return () => dataChangedListeners.delete(handler);
      },
    },
  };
}
