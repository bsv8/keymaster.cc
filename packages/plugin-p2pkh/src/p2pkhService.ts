// packages/plugin-p2pkh/src/p2pkhService.ts
// P2PKH 服务实现（2026-09-20 UTXO / 历史解耦后）。
//
// 关键设计：
//   - 默认方法只读当前 active key namespace；跨 owner 读路径走
//     `ensureRepositoryForOwner(publicKeyHex)`。
//   - UTXO 唯一真值 = Coordinator Worker 内存中的 WoC `unspent/all` 快照；
//     service 通过 `coordinator.p2pkhUtxosGet / p2pkhUtxosRefresh` 读取，
//     本地不再保存或派生任何 UTXO。
//   - 历史 = WoC history 元数据（txid/height/fee）；raw tx 只在详情页
//     懒加载并临时解析。
//   - 转账 prepare/submit 前各刷新一次快照，并保留原子 input claim。
//   - key.deleting / vault.locked 时释放 owner K-V 句柄。

import type {
  AssetDataNotifier,
  BalanceBroadcaster,
  GlobalBalanceSnapshot,
  ProtectedOutpointRegistry,
  KeyspaceService,
  BorrowedOwnerFileStore,
  VaultService,
  WocService,
  P2pkhCoordinatorControl,
  P2pkhUtxoSnapshotResult,
} from "@keymaster/contracts";
import { BALANCE_NETWORK_KEYS, emptyGlobalBalanceSnapshot } from "@keymaster/contracts";
import type { MessageBus } from "webloom-framework";
import type {
  P2pkhBalance,
  P2pkhBalanceBreakdown,
  P2pkhGlobalSettings,
  P2pkhKeyResource,
  P2pkhLocalInputClaim,
  P2pkhService as IP2pkhService,
  P2pkhSyncStatus,
  P2pkhTransactionDetail,
  P2pkhUtxo,
  P2pkhUtxoFilter
} from "./p2pkhContracts.js";
import {
  assetIdToNetwork,
  makeResourceId,
  P2PKH_ASSETS,
  requireReadyKey,
  resolveP2pkhFeeRateSatoshisPerKb,
  type ReadyKeyIdentity
} from "./p2pkhContracts.js";
import { createP2pkhStateRepository, disposeP2pkhStateRepository, openP2pkhStateRepository, type P2pkhStateRepositoryBundle, type P2pkhStateRepositoryHandle } from "./storage/p2pkhStateRepository.js";
import { createP2pkhTransferService } from "./p2pkhTransferService.js";
import { allocateUtxos, P2pkhAllocationError } from "./utxoAllocator.js";
import { P2PKH_MSG } from "./p2pkhMessages.js";
import { canonicalizeP2pkhUtxos } from "./p2pkhCanonical.js";
import { parseP2pkhTransaction, p2pkhAddressToScriptHex } from "./p2pkhTransactionParser.js";

export const P2PKH_TASK_TRANSACTIONS_SYNC = "p2pkh.transactions-sync";

/** 未知余额的占位明细；这些 0 不能直接渲染为真实余额。 */
const EMPTY_BALANCE_BREAKDOWN: P2pkhBalanceBreakdown = {
  confirmed: 0,
  unconfirmed: 0,
  spendable: 0,
  pendingInputClaims: 0,
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
    balances: Object.fromEntries(
      Object.entries(snapshot.balances).map(([network, balance]) => [network, balance ? cloneP2pkhBalance(balance) : balance])
    ) as GlobalBalanceSnapshot["balances"],
  };
}

function sameP2pkhBalance(left: P2pkhBalance | undefined, right: P2pkhBalance | undefined): boolean {
  if (!left || !right) return left === right;
  return left.total === right.total
    && left.available === right.available
    && JSON.stringify(left.breakdown ?? null) === JSON.stringify(right.breakdown ?? null);
}

function sameGlobalBalanceContent(left: GlobalBalanceSnapshot, right: GlobalBalanceSnapshot): boolean {
  if (left.publicKeyHex !== right.publicKeyHex || left.includeTestnet !== right.includeTestnet) return false;
  const keys = new Set([...Object.keys(left.balances), ...Object.keys(right.balances)]);
  for (const key of keys) {
    if (!sameP2pkhBalance(left.balances[key as keyof GlobalBalanceSnapshot["balances"]], right.balances[key as keyof GlobalBalanceSnapshot["balances"]])) return false;
  }
  return true;
}

function sameGlobalSettings(left: P2pkhGlobalSettings, right: P2pkhGlobalSettings): boolean {
  if (left.includeTestnet !== right.includeTestnet) return false;
  const a = resolveP2pkhFeeRateSatoshisPerKb(left);
  const b = resolveP2pkhFeeRateSatoshisPerKb(right);
  return a.low === b.low && a.medium === b.medium && a.high === b.high;
}

/** UTXO 快照项 → service 内部 UTXO 视图（script 由地址确定性生成）。 */
function snapshotItemToUtxo(input: {
  item: P2pkhUtxoSnapshotResult["items"][number];
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
 * 余额明细：只由 UTXO 快照 + 本地 input claims 现算。
 *
 * 快照不可用时返回 `available: false`，调用方必须显示“未知/不可用”，
 * 不得把 total 当 0。
 */
export function calculateP2pkhBalanceBreakdown(input: {
  snapshot: P2pkhUtxoSnapshotResult;
  claims: P2pkhLocalInputClaim[];
  protectedOutpoints?: ReadonlySet<string>;
}): P2pkhBalanceBreakdown {
  if (!input.snapshot.available) {
    return { confirmed: 0, unconfirmed: 0, spendable: 0, pendingInputClaims: 0 };
  }
  const spendableItems = input.snapshot.items.filter((item) => !item.isSpentInMempoolTx);
  const confirmed = spendableItems.filter((item) => item.status === "confirmed").reduce((sum, item) => sum + item.value, 0);
  const unconfirmed = spendableItems.filter((item) => item.status === "unconfirmed").reduce((sum, item) => sum + item.value, 0);
  const seenClaims = new Set<string>();
  let pendingInputClaims = 0;
  for (const claim of input.claims) {
    if (claim.state !== "active" && claim.state !== "isolated") continue;
    const key = `${claim.txid}:${claim.vout}`;
    if (seenClaims.has(key)) continue;
    seenClaims.add(key);
    pendingInputClaims += claim.value ?? 0;
  }
  const protectedOutpoints = input.protectedOutpoints ?? new Set<string>();
  const protectedValue = spendableItems
    .filter((item) => protectedOutpoints.has(`${item.txid}:${item.vout}`))
    .reduce((sum, item) => sum + item.value, 0);
  return {
    confirmed,
    unconfirmed,
    spendable: Math.max(0, confirmed + unconfirmed - pendingInputClaims - protectedValue),
    pendingInputClaims,
  };
}

export interface P2pkhServiceDeps {
  vault: VaultService;
  coordinator?: P2pkhCoordinatorControl;
  messageBus: MessageBus;
  keyspace: KeyspaceService;
  /** Host 已按 manifest 声明绑定的当前 owner K-V 句柄。 */
  storage: BorrowedOwnerFileStore;
  /** 详情页懒加载 raw transaction 的唯一来源。 */
  woc?: WocService;
  protectedOutpoints?: ProtectedOutpointRegistry;
  assetDataNotifier?: AssetDataNotifier;
}

export function createP2pkhService(deps: P2pkhServiceDeps): IP2pkhService & { balanceBroadcaster: BalanceBroadcaster } {
  if (!deps.storage) throw new Error("P2PKH central storage binding is required");
  let activeIdentity: ReadyKeyIdentity | undefined;
  let cachedSettings: P2pkhGlobalSettings = {
    includeTestnet: deps.coordinator?.getBootstrapSnapshot().p2pkhSettings?.includeTestnet === true
  };
  const settingsListeners = new Set<(s: P2pkhGlobalSettings) => void>();
  let balanceSnapshot = emptyGlobalBalanceSnapshot();
  const balanceListeners = new Set<(snapshot: GlobalBalanceSnapshot) => void>();
  let balanceRefreshGeneration = 0;
  let balanceRefreshInFlight: Promise<void> | undefined;

  const balanceBroadcaster: BalanceBroadcaster = {
    getSnapshot() {
      // 读取方可能在 keyspace/session 事件落地前先拿到资源重载；不允许
      // 把上一个 owner 的快照短暂暴露给新 owner。
      const active = deps.keyspace.active().activePublicKeyHex?.trim().toLowerCase() ?? "";
      if (deps.vault.status() !== "unlocked" || !active || balanceSnapshot.publicKeyHex !== active) {
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
    const candidate: GlobalBalanceSnapshot = { ...next, revision: balanceSnapshot.revision };
    if (sameGlobalBalanceContent(balanceSnapshot, candidate)) return;
    balanceSnapshot = {
      ...candidate,
      revision: balanceSnapshot.revision + 1,
      balances: Object.fromEntries(
        Object.entries(candidate.balances).map(([network, balance]) => [network, balance ? cloneP2pkhBalance(balance) : balance])
      ) as GlobalBalanceSnapshot["balances"],
    };
    const published = cloneGlobalBalanceSnapshot(balanceSnapshot);
    deps.messageBus.publish(P2PKH_MSG.BALANCE_CHANGED, published);
    for (const listener of [...balanceListeners]) {
      try {
        listener(cloneGlobalBalanceSnapshot(published));
      } catch {
        // 余额观察者不能影响余额快照提交。
      }
    }
    // 余额快照提交后再次通过统一失效通知器广播，保证资产总览和 transfer
    // offer 不会停留在“失效事件先到、余额重算后到”造成的旧值上。
    deps.assetDataNotifier?.emit({
      providerId: "p2pkh",
      ...(published.publicKeyHex ? { publicKeyHex: published.publicKeyHex } : {}),
      revision: published.revision,
      kinds: ["balance"],
    });
  }

  function clearBalanceSnapshot(): void {
    balanceRefreshGeneration++;
    const empty = emptyGlobalBalanceSnapshot();
    publishBalanceSnapshot({
      publicKeyHex: empty.publicKeyHex,
      includeTestnet: empty.includeTestnet,
      balances: empty.balances,
    });
  }

  function setCachedSettingsAndEmit(next: P2pkhGlobalSettings): void {
    if (sameGlobalSettings(cachedSettings, next)) return;
    const includeTestnetChanged = cachedSettings.includeTestnet !== next.includeTestnet;
    cachedSettings = next;
    deps.messageBus.publish(P2PKH_MSG.SETTINGS_CHANGED, next);
    for (const l of [...settingsListeners]) l(next);
    if (includeTestnetChanged) void refreshBalanceSnapshot();
  }

  /** 详情页懒加载缓存：只存解析结果，不落盘；上限 32 条。 */
  const transactionDetailCache = new Map<string, P2pkhTransactionDetail>();

  async function loadTransactionDetail(input: { resourceId: string; network: "main" | "test"; txid: string }): Promise<P2pkhTransactionDetail | undefined> {
    const txid = input.txid.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/u.test(txid)) throw new Error("P2PKH transaction detail requires a valid txid");
    const cacheKey = `${input.resourceId}:${txid}`;
    const cached = transactionDetailCache.get(cacheKey);
    if (cached) return cached;
    if (!deps.woc?.getRawTransaction) throw new Error("WoC raw transaction capability is unavailable");
    const rawTxHex = (await deps.woc.getRawTransaction(input.network, txid, { priority: "background" })).replace(/^0x/i, "").toLowerCase();
    const parsed = parseP2pkhTransaction(rawTxHex, txid);
    const detail: P2pkhTransactionDetail = {
      txid: parsed.canonicalTxid,
      network: input.network,
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

  /** 从快照得到该 owner/network 的可花费 UTXO（排除 mempool 花费 / claims / protected）。 */
  async function listSpendableUtxosFromSnapshot(input: {
    resource: P2pkhKeyResource;
    snapshot: P2pkhUtxoSnapshotResult;
    ownerPublicKeyHex: string;
  }): Promise<P2pkhUtxo[]> {
    const stateRepository = await ensureRepositoryForOwner(input.ownerPublicKeyHex);
    const reservations = await stateRepository.listLocalInputClaimsByResource(input.resource.resourceId);
    const reserved = new Set(
      reservations.filter((row) => row.state === "active" || row.state === "isolated").map((row) => `${row.txid}:${row.vout}`)
    );
    const candidates = input.snapshot.items
      .filter((item) => !item.isSpentInMempoolTx)
      .map((item) => snapshotItemToUtxo({ item, resource: input.resource }))
      .filter((utxo) => !reserved.has(`${utxo.txid}:${utxo.vout}`))
      .filter((utxo) => !deps.protectedOutpoints?.isProtected({ txid: utxo.txid, vout: utxo.vout, network: utxo.network, publicKeyHex: input.ownerPublicKeyHex }));
    return canonicalizeP2pkhUtxos(candidates);
  }

  /** 聚合读路径：按 filter 解析 owner/network，再从快照取可花费集合。 */
  async function collectUtxos(filter: P2pkhUtxoFilter | undefined, excludeProtected: boolean): Promise<P2pkhUtxo[]> {
    const ownerHex = filter?.ownerPublicKeyHex ?? getActiveKeyState().activePublicKeyHex;
    if (!ownerHex) return [];
    const network = filter?.assetId ? assetIdToNetwork(filter.assetId) : filter?.resourceId ? (/^p2pkh:test$/.test(filter.resourceId) ? "test" : "main") : undefined;
    const networks = network ? [network] : (getCurrentSettings().includeTestnet ? ["main", "test"] as const : ["main"] as const);
    const rows: P2pkhUtxo[] = [];
    for (const current of networks) {
      const snapshot = await requireUtxoSnapshot({ ownerPublicKeyHex: ownerHex, network: current }, "get");
      const resource = await (await ensureRepositoryForOwner(ownerHex)).getResource(makeResourceId(current));
      if (!resource) continue;
      const utxos = snapshot.items
        .filter((item) => !item.isSpentInMempoolTx)
        .map((item) => snapshotItemToUtxo({ item, resource }));
      const stateRepository = await ensureRepositoryForOwner(ownerHex);
      const reservations = await stateRepository.listLocalInputClaimsByResource(resource.resourceId);
      const reserved = new Set(reservations.filter((row) => row.state === "active" || row.state === "isolated").map((row) => `${row.txid}:${row.vout}`));
      rows.push(...utxos.filter((utxo) =>
        !reserved.has(`${utxo.txid}:${utxo.vout}`)
        && (!excludeProtected || !deps.protectedOutpoints?.isProtected({ txid: utxo.txid, vout: utxo.vout, network: utxo.network, publicKeyHex: ownerHex }))
      ));
    }
    const settings = getCurrentSettings();
    const visible = settings.includeTestnet ? rows : rows.filter((u) => u.network === "main");
    return canonicalizeP2pkhUtxos(filterUtxos(visible, filter));
  }

  const transfer = createP2pkhTransferService({
    vault: deps.vault,
    protectedOutpoints: deps.protectedOutpoints,
    broadcastWithCoordinator: deps.coordinator ? async (input) => {
      return deps.coordinator!.p2pkhBroadcast(input);
    } : undefined,
    messageBus: deps.messageBus,
    assetDataNotifier: deps.assetDataNotifier,
    getStore: (publicKeyHex) => ensureRepositoryForOwner(publicKeyHex),
    loadSpendableUtxos: async ({ ownerPublicKeyHex, resource }) => {
      // 准备/提交前刷新一次 `unspent/all`；刷新失败即拒绝继续，
      // 不允许用可能已过期的快照签署交易。
      const snapshot = await requireUtxoSnapshot({ ownerPublicKeyHex, network: resource.network }, "refresh");
      if (!snapshot.available) throw new Error("P2PKH UTXO snapshot is unavailable");
      return listSpendableUtxosFromSnapshot({ resource, snapshot, ownerPublicKeyHex });
    },
    getActiveKey: () => {
      const state = getActiveKeyState();
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
      const key = await deps.keyspace.getKey(ownerPublicKeyHex);
      if (!key) {
        throw new Error(`P2PKH owner key not found: ${ownerPublicKeyHex}`);
      }
      if (!key.publicKeyHex) {
        throw new Error(`P2PKH owner key not ready: ${ownerPublicKeyHex}`);
      }
      return {
        publicKeyHex: key.publicKeyHex,
        label: key.label,
        capabilities: key.capabilities,
        createdAt: key.createdAt
      } as ReadyKeyIdentity;
    }
  });

  const statusListeners = new Set<(s: P2pkhSyncStatus) => void>();
  const messageBusUnsubs: Array<() => void> = [];
  function trackSubscribe<TPayload>(type: string, handler: (p: TPayload) => void) {
    const off = deps.messageBus.subscribe<TPayload>(type, handler);
    messageBusUnsubs.push(off);
    return off;
  }
  let status: P2pkhSyncStatus = "idle";

  function setStatus(next: P2pkhSyncStatus) {
    status = next;
    for (const l of statusListeners) l(next);
    deps.messageBus.publish(P2PKH_MSG.SYNC, { status: next });
  }

  function getCurrentSettings(): P2pkhGlobalSettings {
    return cachedSettings;
  }

  async function listAllResources(): Promise<P2pkhKeyResource[]> {
    const stateRepository = await ensureRepository();
    const all = await stateRepository.listAddresses();
    const settings = getCurrentSettings();
    if (settings.includeTestnet) return all;
    return all.filter((r) => r.network === "main");
  }

  function getActiveKeyState() {
    return deps.keyspace.active();
  }

  function requireActiveKeyIdentity(): ReadyKeyIdentity {
    const state = getActiveKeyState();
    if (!state.activePublicKeyHex) {
      throw new Error("Active key is required");
    }
    if (!activeIdentity || activeIdentity.publicKeyHex !== state.activePublicKeyHex) {
      throw new Error("Active key is not ready");
    }
    return activeIdentity;
  }

  async function ensureRepositoryForOwner(publicKeyHex: string): Promise<P2pkhStateRepositoryHandle> {
    const active = deps.keyspace.active().activePublicKeyHex?.toLowerCase();
    if (active !== publicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
    const bundle: P2pkhStateRepositoryBundle = await openP2pkhStateRepository(deps.storage);
    return createP2pkhStateRepository(bundle);
  }

  async function ensureRepository(): Promise<P2pkhStateRepositoryHandle> {
    const state = getActiveKeyState();
    if (!state.activePublicKeyHex) {
      throw new Error("Key storage is not ready");
    }
    return ensureRepositoryForOwner(state.activePublicKeyHex);
  }

  function protectedOutpointKeys(network?: "main" | "test"): ReadonlySet<string> {
    const rows = deps.protectedOutpoints?.list({ ...(network ? { network } : {}), publicKeyHex: getActiveKeyState().activePublicKeyHex ?? undefined }) ?? [];
    return new Set(rows.map((row) => `${row.txid}:${row.vout}`));
  }

  async function calculateBalanceBreakdown(network: "main" | "test"): Promise<{ breakdown: P2pkhBalanceBreakdown; available: boolean }> {
    const active = getActiveKeyState().activePublicKeyHex;
    if (!active) return { breakdown: { confirmed: 0, unconfirmed: 0, spendable: 0, pendingInputClaims: 0 }, available: false };
    const resourceId = makeResourceId(network);
    let claims: P2pkhLocalInputClaim[] = [];
    try {
      const stateRepository = await ensureRepository();
      claims = await stateRepository.listLocalInputClaimsByResource(resourceId);
    } catch {
      // owner storage 尚未就绪时，余额必须保持未知，不能把缺失的 claims 当作可信 0。
      return { breakdown: { ...EMPTY_BALANCE_BREAKDOWN }, available: false };
    }
    let snapshot: P2pkhUtxoSnapshotResult;
    try {
      snapshot = await requireUtxoSnapshot({ ownerPublicKeyHex: active, network }, "get");
    } catch {
      // 快照不可用（冷启动/刷新失败）：余额未知，绝不当 0。
      snapshot = { available: false, items: [] };
    }
    return { breakdown: calculateP2pkhBalanceBreakdown({ snapshot, claims, protectedOutpoints: protectedOutpointKeys(network) }), available: snapshot.available };
  }

  /**
   * 从 Coordinator 内存 UTXO 快照重算余额广播。
   *
   * 这里只调用 p2pkhUtxosGet（窗口到 Worker 的内存读），不会触发 WoC 请求；
   * 所有 WoC 网络访问仍由 Worker 的单点刷新任务负责。
   */
  async function refreshBalanceSnapshotImpl(): Promise<void> {
    const generation = ++balanceRefreshGeneration;
    const active = getActiveKeyState().activePublicKeyHex?.trim().toLowerCase() ?? "";
    const includeTestnet = getCurrentSettings().includeTestnet;
    if (!active || deps.vault.status() !== "unlocked") {
      clearBalanceSnapshot();
      return;
    }

    const networks = includeTestnet ? (["main", "test"] as const) : (["main"] as const);
    const sameOwner = balanceSnapshot.publicKeyHex === active;
    const sameOwnerAndSettings = sameOwner && balanceSnapshot.includeTestnet === includeTestnet;
    const requiresProjection = !sameOwnerAndSettings
      || networks.some((network) => !Object.prototype.hasOwnProperty.call(balanceSnapshot.balances, BALANCE_NETWORK_KEYS[network]));
    if (requiresProjection) {
      // 首次读取、owner 切换或打开 testnet 时先发布“未知”占位，保证 map
      // 形状立即正确；同 owner 已有的主网值可以保留，避免刷新期间闪成未知。
      const projectedBalances = Object.fromEntries(networks.map((network) => {
        const key = BALANCE_NETWORK_KEYS[network];
        const existing = sameOwner ? balanceSnapshot.balances[key] : undefined;
        return [key, existing ?? unknownP2pkhBalance()];
      })) as GlobalBalanceSnapshot["balances"];
      publishBalanceSnapshot({ publicKeyHex: active, includeTestnet, balances: projectedBalances });
    }
    const values = await Promise.all(networks.map(async (network) => {
      try {
        const result = await calculateBalanceBreakdown(network);
        return [BALANCE_NETWORK_KEYS[network], {
          total: result.breakdown.spendable,
          available: result.available,
          breakdown: result.breakdown,
        } satisfies P2pkhBalance] as const;
      } catch {
        return [BALANCE_NETWORK_KEYS[network], unknownP2pkhBalance()] as const;
      }
    }));

    // 异步读取期间可能发生 owner/settings 切换；旧结果不能覆盖新 owner。
    if (generation !== balanceRefreshGeneration) return;
    const currentOwner = getActiveKeyState().activePublicKeyHex?.trim().toLowerCase() ?? "";
    if (!currentOwner || currentOwner !== active || getCurrentSettings().includeTestnet !== includeTestnet || deps.vault.status() !== "unlocked") {
      return;
    }
    publishBalanceSnapshot({
      publicKeyHex: active,
      includeTestnet,
      balances: Object.fromEntries(values) as GlobalBalanceSnapshot["balances"],
    });
  }

  function refreshBalanceSnapshot(): Promise<void> {
    const promise = refreshBalanceSnapshotImpl();
    balanceRefreshInFlight = promise;
    void promise.then(
      () => {
        if (balanceRefreshInFlight === promise) balanceRefreshInFlight = undefined;
      },
      () => {
        if (balanceRefreshInFlight === promise) balanceRefreshInFlight = undefined;
      }
    );
    return promise;
  }

  async function ensureBalanceSnapshotReady(): Promise<void> {
    const active = getActiveKeyState().activePublicKeyHex?.trim().toLowerCase() ?? "";
    if (!active) return;
    const includeTestnet = getCurrentSettings().includeTestnet;
    const hasMainnet = Object.prototype.hasOwnProperty.call(balanceSnapshot.balances, "mainnet");
    const hasTestnet = Object.prototype.hasOwnProperty.call(balanceSnapshot.balances, "testnet");
    if (balanceSnapshot.publicKeyHex !== active || balanceSnapshot.includeTestnet !== includeTestnet || !hasMainnet || hasTestnet !== includeTestnet) {
      await refreshBalanceSnapshot();
    }
    if (balanceRefreshInFlight) await balanceRefreshInFlight;
  }

  async function rebindActiveKey() {
    const state = getActiveKeyState();
    if (!state.activePublicKeyHex) {
      activeIdentity = undefined;
      return;
    }
    const identity = await deps.keyspace.getKey(state.activePublicKeyHex);
    if (!identity) {
      throw new Error("Active key identity not found");
    }
    activeIdentity = requireReadyKey(identity);
  }

  const keyspaceUnsubs: Array<() => void> = [];
  function trackKeyspaceSubscribe(handler: () => void) {
    const off = deps.keyspace.onActiveKeyChanged(handler);
    keyspaceUnsubs.push(off);
    return off;
  }
  trackKeyspaceSubscribe(() => {
    const nextOwner = getActiveKeyState().activePublicKeyHex?.trim().toLowerCase() ?? "";
    if (balanceSnapshot.publicKeyHex !== nextOwner) {
      activeIdentity = undefined;
      clearBalanceSnapshot();
    }
    void (async () => {
      try {
        const state = getActiveKeyState();
        await rebindActiveKey();
        await rehydrateResources();
        await refreshBalanceSnapshot();
        void state;
      } catch {
        await refreshBalanceSnapshot();
      }
    })();
  });

  trackSubscribe<{ publicKeyHex: string }>("key.deleting", () => {
    clearBalanceSnapshot();
    try {
      disposeP2pkhStateRepository();
    } catch {
      // key.deleted handler below remains an idempotent safety net.
    }
  });
  trackSubscribe<{ publicKeyHex: string }>("key.deleted", async () => {
    clearBalanceSnapshot();
    try {
      disposeP2pkhStateRepository();
    } catch {
      // swallow
    }
  });

  async function getOrCreateAddress(network: "main" | "test"): Promise<P2pkhKeyResource | null> {
    const stateRepository = await ensureRepository();
    const resourceId = makeResourceId(network);
    const existing = await stateRepository.getResource(resourceId);
    if (existing) {
      return existing;
    }
    const key = requireActiveKeyIdentity();
    const crypto = await resolveActiveKeyCrypto(deps.vault, key.publicKeyHex);
    const { address } = await crypto.deriveP2pkhAddress({
      publicKeyHex: key.publicKeyHex,
      network
    });
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
    deps.messageBus.publish(P2PKH_MSG.ADDRESS_DERIVED, {
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
    setStatus("idle");
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
      deps.messageBus.publish(P2PKH_MSG.REHYDRATE_ERROR, {
        error: msg
      });
    }
  }

  async function rehydrateResources(): Promise<void> {
    if (deps.vault.status() !== "unlocked") return;
    const state = getActiveKeyState();
    if (!state.activePublicKeyHex) return;
    if (!activeIdentity) return;
    const includeTestnet = getCurrentSettings().includeTestnet;
    let rehydrateError: unknown;
    try {
      await getOrCreateAddress("main");
      if (includeTestnet) {
        await getOrCreateAddress("test");
      }
    } catch (err) {
      rehydrateError = err;
    }
    if (rehydrateError) {
      const msg = rehydrateError instanceof Error ? rehydrateError.message : String(rehydrateError);
      deps.messageBus.publish(P2PKH_MSG.REHYDRATE_ERROR, {
        error: msg
      });
      return;
    }
    if (deps.assetDataNotifier) {
      deps.assetDataNotifier.emit({
        providerId: "p2pkh",
        publicKeyHex: state.activePublicKeyHex,
        revision: Date.now(),
        kinds: ["resource", "balance"],
      });
    }
    // 冷启动余额可见性：地址资源就绪后主动刷新一次内存 UTXO 快照。
    // 失败只保留“未知/不可用”，不写 0；成功由 Worker 发布 data-changed。
    for (const network of includeTestnet ? ["main", "test"] as const : ["main"] as const) {
      void deps.coordinator?.p2pkhUtxosRefresh({ ownerPublicKeyHex: state.activePublicKeyHex, network }).catch(() => undefined);
    }
    void refreshBalanceSnapshot();
  }

  trackSubscribe(P2PKH_MSG.TRANSFER_BROADCAST, () => undefined);

  const dataChangedListeners = new Set<() => void>();
  const coordinatorUnsubs: Array<() => void> = [];
  function trackCoordinatorSubscribe(topic: "background.snapshot" | "session.state", handler: (event: any) => void): void {
    if (!deps.coordinator || typeof deps.coordinator.subscribeTopic !== "function") return;
    coordinatorUnsubs.push(deps.coordinator.subscribeTopic(topic, handler));
  }

  // Coordinator 的背景快照是跨 tab 设置同步入口；client 已把 p2pkhSettings
  // 合并进 bootstrap cache，这里只读取事件，不发起额外 RPC。
  trackCoordinatorSubscribe("background.snapshot", (event) => {
    if (event?.type !== "background.snapshot.changed" || !event.p2pkhSettings) return;
    const includeTestnet = event.p2pkhSettings.includeTestnet === true;
    setCachedSettingsAndEmit({ ...cachedSettings, includeTestnet });
  });
  // session.state 先于 keyspace 异步回调到达时，也要立即清掉旧 owner 的余额。
  trackCoordinatorSubscribe("session.state", (event) => {
    if (event?.type !== "session.state.changed") return;
    const owner = event.vaultStatus === "unlocked" && typeof event.activePublicKeyHex === "string"
      ? event.activePublicKeyHex.trim().toLowerCase()
      : "";
    if (!owner || owner !== balanceSnapshot.publicKeyHex) {
      activeIdentity = owner ? activeIdentity : undefined;
      clearBalanceSnapshot();
    }
    // 不在这里直接重算：session.state 可能先于 keyspace 的本地 owner 状态到达，
    // 此时读取 keyspace 会拿到旧 owner，反而可能把刚清空的旧余额重新发布。
    // keyspace 变化回调会在 owner 真正切换后负责重算。
  });

  if (deps.assetDataNotifier) {
    messageBusUnsubs.push(
      deps.assetDataNotifier.subscribe((event) => {
        if (event.providerId === "p2pkh") {
          const active = getActiveKeyState().activePublicKeyHex?.trim().toLowerCase() ?? "";
          const eventOwner = event.publicKeyHex?.trim().toLowerCase() ?? "";
          if (event.kinds.includes("balance") && active && eventOwner === active) {
            void refreshBalanceSnapshot();
          }
          for (const l of dataChangedListeners) {
            try { l(); } catch { /* 静默 */ }
          }
        }
      })
    );
  }

  if (deps.protectedOutpoints) {
    messageBusUnsubs.push(deps.protectedOutpoints.onChange(() => {
      void refreshBalanceSnapshot();
      for (const l of dataChangedListeners) {
        try { l(); } catch { /* 静默 */ }
      }
    }));
  }

  // 初次装配也发布一份当前 owner 的只读投影；无 active key 时保持空快照。
  void refreshBalanceSnapshot();

  return {
    balanceBroadcaster,
    syncStatus() {
      return status;
    },
    onSyncStatusChange(handler) {
      statusListeners.add(handler);
      return () => statusListeners.delete(handler);
    },
    onDataChanged(handler) {
      dataChangedListeners.add(handler);
      return () => dataChangedListeners.delete(handler);
    },

    async getAssetBalance(assetId) {
      const network = assetIdToNetwork(assetId);
      await ensureBalanceSnapshotReady();
      const balance = balanceSnapshot.balances[BALANCE_NETWORK_KEYS[network]];
      return balance ? cloneP2pkhBalance(balance) : unknownP2pkhBalance();
    },
    async getResourceBalance(resourceId) {
      const network = /:test$/.test(resourceId) ? "test" : "main";
      await ensureBalanceSnapshotReady();
      const balance = balanceSnapshot.balances[BALANCE_NETWORK_KEYS[network]];
      return balance ? cloneP2pkhBalance(balance) : unknownP2pkhBalance();
    },

    async listResources(assetId) {
      const stateRepository = await ensureRepository();
      const all = await stateRepository.listAddresses();
      const settings = getCurrentSettings();
      const filtered = settings.includeTestnet
        ? all
        : all.filter((r) => r.network === "main");
      if (!assetId) return filtered;
      const network = assetIdToNetwork(assetId);
      if (!settings.includeTestnet && network === "test") return [];
      return filtered.filter((r) => r.network === network);
    },

    async listUtxos(filter) {
      return collectUtxos(filter, true);
    },

    async listUtxosRaw(filter) {
      return collectUtxos(filter, false);
    },

    async getUtxosStatus(filter) {
      const ownerHex = filter?.ownerPublicKeyHex ?? getActiveKeyState().activePublicKeyHex;
      if (!ownerHex) return { available: false, utxos: [] };
      const network = filter?.assetId ? assetIdToNetwork(filter.assetId) : filter?.resourceId ? (/^p2pkh:test$/.test(filter.resourceId) ? "test" : "main") : "main";
      const snapshot = await requireUtxoSnapshot({ ownerPublicKeyHex: ownerHex, network }, "get");
      const resource = await (await ensureRepositoryForOwner(ownerHex)).getResource(makeResourceId(network));
      if (!resource) return { available: snapshot.available, syncedAt: snapshot.syncedAt, utxos: [] };
      const utxos = await listSpendableUtxosFromSnapshot({ resource, snapshot, ownerPublicKeyHex: ownerHex });
      return { available: snapshot.available, syncedAt: snapshot.syncedAt, utxos: filterUtxos(utxos, filter) };
    },

    async refreshUtxos(filter) {
      const ownerHex = filter?.ownerPublicKeyHex ?? getActiveKeyState().activePublicKeyHex;
      if (!ownerHex) throw new Error("Active key is required");
      const network = filter?.assetId ? assetIdToNetwork(filter.assetId) : filter?.resourceId ? (/^p2pkh:test$/.test(filter.resourceId) ? "test" : "main") : "main";
      const snapshot = await requireUtxoSnapshot({ ownerPublicKeyHex: ownerHex, network }, "refresh");
      return { available: snapshot.available, syncedAt: snapshot.syncedAt };
    },

    isAssetEnabled(assetId) {
      if (assetId === "bsv") return true;
      if (assetId === "bsvtest") return getCurrentSettings().includeTestnet;
      return false;
    },

    async listHistory(filter) {
      const ownerHex = filter?.ownerPublicKeyHex;
      const stateRepository = ownerHex ? await ensureRepositoryForOwner(ownerHex) : await ensureRepository();
      const network = filter?.assetId ? assetIdToNetwork(filter.assetId) : filter?.resourceId ? (/^p2pkh:test$/.test(filter.resourceId) ? "test" : "main") : undefined;
      const rows = await stateRepository.listHistory({ network, resourceId: filter?.resourceId, limit: filter?.limit });
      return getCurrentSettings().includeTestnet ? rows : rows.filter((row) => row.network === "main");
    },
    async listHistoryPage(filter) {
      const ownerHex = filter?.ownerPublicKeyHex;
      const stateRepository = ownerHex ? await ensureRepositoryForOwner(ownerHex) : await ensureRepository();
      const network = filter?.assetId ? assetIdToNetwork(filter.assetId) : filter?.resourceId ? (/^p2pkh:test$/.test(filter.resourceId) ? "test" : "main") : undefined;
      const page = await stateRepository.listHistoryPage({ network, resourceId: filter?.resourceId, cursor: filter?.cursor, limit: filter?.limit });
      return { items: getCurrentSettings().includeTestnet ? page.items : page.items.filter((row) => row.network === "main"), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    },
    async listLocalTransactions(filter) {
      const ownerHex = filter?.ownerPublicKeyHex;
      const stateRepository = ownerHex ? await ensureRepositoryForOwner(ownerHex) : await ensureRepository();
      const rows = await stateRepository.listLocalTransactions(filter?.resourceId, filter?.limit);
      const visible = filter?.includeResolvedLocalTransactions ? rows : rows.filter((row) => row.chainResolution !== "chain-confirmed");
      return getCurrentSettings().includeTestnet ? visible.filter((row) => !filter?.assetId || row.network === assetIdToNetwork(filter.assetId)) : visible.filter((row) => row.network === "main");
    },
    async listLocalTransactionsPage(filter) {
      const ownerHex = filter?.ownerPublicKeyHex;
      const stateRepository = ownerHex ? await ensureRepositoryForOwner(ownerHex) : await ensureRepository();
      const page = await stateRepository.listLocalTransactionsPage({ resourceId: filter?.resourceId, cursor: filter?.cursor, limit: filter?.limit });
      const visible = filter?.includeResolvedLocalTransactions ? page.items : page.items.filter((row) => row.chainResolution !== "chain-confirmed");
      const items = getCurrentSettings().includeTestnet ? visible : visible.filter((row) => row.network === "main");
      const network = filter?.assetId ? assetIdToNetwork(filter.assetId) : undefined;
      return { items: network ? items.filter((row) => row.network === network) : items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    },
    async listLocalInputClaimsPage(filter) {
      const ownerHex = filter?.ownerPublicKeyHex;
      const stateRepository = ownerHex ? await ensureRepositoryForOwner(ownerHex) : await ensureRepository();
      const page = await stateRepository.listLocalInputClaimsPage({ resourceId: filter?.resourceId, cursor: filter?.cursor, limit: filter?.limit });
      const items = getCurrentSettings().includeTestnet ? page.items : page.items.filter((row) => row.network === "main");
      const network = filter?.assetId ? assetIdToNetwork(filter.assetId) : undefined;
      return { items: network ? items.filter((row) => row.network === network) : items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    },
    async getBalanceBreakdown(network) {
      const target = network ?? "main";
      await ensureBalanceSnapshotReady();
      return balanceSnapshot.balances[BALANCE_NETWORK_KEYS[target]]?.breakdown
        ? { ...balanceSnapshot.balances[BALANCE_NETWORK_KEYS[target]]!.breakdown! }
        : { ...EMPTY_BALANCE_BREAKDOWN };
    },
    async listLocalInputClaims(resourceId?: string, limit?: number) {
      const stateRepository = await ensureRepository();
      const all = resourceId && typeof stateRepository.listLocalInputClaimsByResource === "function"
        ? await stateRepository.listLocalInputClaimsByResource(resourceId, limit)
        : await stateRepository.listLocalInputClaims(limit);
      const settings = getCurrentSettings();
      return settings.includeTestnet
        ? all.filter((r) => !resourceId || r.resourceId === resourceId)
        : all.filter((r) => r.network === "main" && (!resourceId || r.resourceId === resourceId));
    },

    async allocateUtxos(request) {
      if (!request.assetId || !(request.assetId in P2PKH_ASSETS)) {
        throw new Error("P2PKH provider requires an assetId");
      }
      const settings = getCurrentSettings();
      if (!settings.includeTestnet && request.assetId === "bsvtest") {
        throw new P2pkhAllocationError({
          required: request.amountSatoshis,
          available: 0,
          feeReserve: request.feeReserveSatoshis ?? 0,
          reason: "no-utxos"
        });
      }
      const network = assetIdToNetwork(request.assetId);
      const ownerHex = getActiveKeyState().activePublicKeyHex;
      if (!ownerHex) {
        throw new P2pkhAllocationError({ required: request.amountSatoshis, available: 0, feeReserve: request.feeReserveSatoshis ?? 0, reason: "no-utxos" });
      }
      const stateRepository = await ensureRepository();
      const resource = await stateRepository.getResource(makeResourceId(network));
      if (!resource) {
        throw new P2pkhAllocationError({ required: request.amountSatoshis, available: 0, feeReserve: request.feeReserveSatoshis ?? 0, reason: "no-utxos" });
      }
      const snapshot = await requireUtxoSnapshot({ ownerPublicKeyHex: ownerHex, network }, "refresh");
      const candidates = await listSpendableUtxosFromSnapshot({ resource, snapshot, ownerPublicKeyHex: ownerHex });
      const result = allocateUtxos(candidates, request);
      if (result.ok) return result.allocation;
      throw new P2pkhAllocationError(result.error);
    },

    prepareTransfer: (input) => {
      if (!input.ownerPublicKeyHex) {
        return Promise.reject(
          new Error("P2PKH prepareTransfer requires ownerPublicKeyHex")
        );
      }
      const settings = getCurrentSettings();
      if (!settings.includeTestnet && input.assetId === "bsvtest") {
        return Promise.reject(new Error("Testnet is not enabled in P2PKH settings"));
      }
      return transfer.prepare(input);
    },
    submitTransfer: (preview) => {
      if (!preview.ownerPublicKeyHex) {
        return Promise.reject(
          new Error("P2PKH submitTransfer requires ownerPublicKeyHex")
        );
      }
      const settings = getCurrentSettings();
      if (!settings.includeTestnet && preview.assetId === "bsvtest") {
        return Promise.reject(new Error("Testnet is not enabled in P2PKH settings"));
      }
      return transfer.submit(preview);
    },

    getGlobalSettings() {
      return cachedSettings;
    },
    onGlobalSettingsChange(handler) {
      settingsListeners.add(handler);
      return () => settingsListeners.delete(handler);
    },
    async applyGlobalSettings(settings) {
      const prev = cachedSettings;
      if (deps.coordinator) {
        const result = await deps.coordinator.p2pkhSettingsUpdate({ includeTestnet: settings.includeTestnet });
        if (result.status !== "accepted" && result.status !== "ok") throw new Error("Coordinator rejected P2PKH network settings");
      }
      setCachedSettingsAndEmit(settings);
      if (!prev.includeTestnet && settings.includeTestnet) {
        try {
          await rehydrateResources();
        } catch (err) {
          deps.messageBus.publish(P2PKH_MSG.REHYDRATE_ERROR, {
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    },

    async onKeyImported() {
      try {
        await rehydrateResources();
      } catch {
      }
    },
    async onKeyRemoved() {
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
      for (const off of messageBusUnsubs) {
        try {
          off();
        } catch {
          // swallow
        }
      }
      messageBusUnsubs.length = 0;
      for (const off of keyspaceUnsubs) {
        try {
          off();
        } catch {
          // swallow
        }
      }
      keyspaceUnsubs.length = 0;
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
    }
  };
}

async function resolveActiveKeyCrypto(vault: VaultService, publicKeyHex: string) {
  const anyVault = vault as VaultService & {
    createActiveKeyCrypto?: (hex: string) => Promise<{
      deriveP2pkhAddress: (input: { publicKeyHex: string; network: "main" | "test" }) => Promise<{
        publicKeyHex: string;
        address: string;
      }>;
    }>;
  };
  if (typeof anyVault.createActiveKeyCrypto === "function") {
    return await anyVault.createActiveKeyCrypto(publicKeyHex);
  }
  throw new Error("Vault does not provide createActiveKeyCrypto");
}

function filterUtxos<T extends { network: "main" | "test"; publicKeyHex: string; resourceId: string }>(
  rows: T[],
  filter: P2pkhUtxoFilter | undefined
): T[] {
  if (!filter) return rows;
  return rows.filter((r) => {
    if (filter.assetId) {
      const net = assetIdToNetwork(filter.assetId);
      if (r.network !== net) return false;
    }
    if (filter.ownerPublicKeyHex && r.publicKeyHex !== filter.ownerPublicKeyHex) {
      return false;
    }
    if (filter.resourceId && r.resourceId !== filter.resourceId) return false;
    return true;
  });
}
