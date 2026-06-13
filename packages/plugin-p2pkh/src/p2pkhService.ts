// packages/plugin-p2pkh/src/p2pkhService.ts
// P2PKH 服务实现（硬切换 007）。
// 关键设计：
//   - 默认方法只读当前 active key namespace；all 模式聚合多 key 读，写抛错。
//   - 切换 active key 时由本服务重建 p2pkh db handle 并通知同步协调器。
//   - 同步入口：依赖 WocService + BackgroundService；不直接 fetch WOC。
//   - 单一 SyncCoordinator 协调 recent-sync 与 history-backfill 写库。
//   - recent-sync 由 BackgroundService 调度；history-backfill 单独注册。
//   - key 导入后创建资源并触发 recent + backfill。
//   - key.deleting 时取消资源通道；删除由 keyspace.deleteKey 统一调度。

import type {
  BackgroundRegistry,
  BackgroundService,
  KeyIdentity,
  KeyspaceService,
  MessageBus,
  VaultService,
  WocService
} from "@keymaster/contracts";
import { BACKGROUND_REGISTRY_CAPABILITY, BACKGROUND_SERVICE_CAPABILITY } from "@keymaster/contracts";
import type {
  P2pkhAssetId,
  P2pkhBackfillState,
  P2pkhBalance,
  P2pkhHistoryItem,
  P2pkhKeyResource,
  P2pkhPendingTransfer,
  P2pkhService as IP2pkhService,
  P2pkhSyncStatus,
  P2pkhTransferInput,
  P2pkhTransferPreview,
  P2pkhTransferResult,
  P2pkhUtxo,
  P2pkhUtxoReservation,
  UtxoAllocation,
  UtxoAllocationRequest,
  P2pkhUtxoFilter
} from "./p2pkhContracts.js";
import {
  assetIdToNetwork,
  makeResourceId,
  P2PKH_ASSETS,
  requireReadyKey,
  type ReadyKeyIdentity
} from "./p2pkhContracts.js";
import { createP2pkhDb, disposeP2pkhDb, openP2pkhDb, type P2pkhDbBundle, type P2pkhDbHandle } from "./p2pkhDb.js";
import { deriveP2pkhAddress } from "./p2pkhSigner.js";
import { createP2pkhSyncCoordinator } from "./p2pkhSyncCoordinator.js";
import { createP2pkhRecentSync } from "./p2pkhRecentSync.js";
import { createP2pkhHistoryBackfill } from "./p2pkhHistoryBackfill.js";
import { createP2pkhTransferService, type P2pkhTransferService } from "./p2pkhTransferService.js";
import { allocateUtxos, P2pkhAllocationError } from "./utxoAllocator.js";
import { P2PKH_MSG } from "./p2pkhMessages.js";

export const P2PKH_TASK_RECENT = "p2pkh.recent-sync";
export const P2PKH_TASK_BACKFILL = "p2pkh.history-backfill";

export interface P2pkhServiceDeps {
  vault: VaultService;
  woc: WocService;
  messageBus: MessageBus;
  backgroundRegistry: BackgroundRegistry;
  backgroundService: BackgroundService;
  keyspace: KeyspaceService;
}

export function createP2pkhService(deps: P2pkhServiceDeps): IP2pkhService {
  const coordinator = createP2pkhSyncCoordinator({ getDb: () => ensureDb() });
  let p2pkhDbHandle: P2pkhDbHandle | null = null;
  let currentPublicKeyHash: string | undefined;
  let activeKeyId: string | undefined;
  // 硬切换 008 收尾 + 硬切换 003 收尾：activeIdentity 是 ReadyKeyIdentity，
  // publicKeyHash / publicKeyHex 必填。rebind 时通过 requireReadyKey 断言；
  // 写入 P2pkhKeyResource 时不需要再 `!`。短公钥不再作为字段持有，UI
  // 需要展示时由 `formatShortPublicKey(publicKeyHex)` 现算。
  let activeIdentity: ReadyKeyIdentity | undefined;

  const recent = createP2pkhRecentSync({
    woc: deps.woc,
    messageBus: deps.messageBus,
    coordinator,
    getResources: () => listAllResources(),
    getDb: () => ensureDb()
  });
  const backfill = createP2pkhHistoryBackfill({
    woc: deps.woc,
    messageBus: deps.messageBus,
    coordinator,
    getResources: () => listAllResources(),
    getDb: () => ensureDb()
  });
  const transfer = createP2pkhTransferService({
    vault: deps.vault,
    woc: deps.woc,
    messageBus: deps.messageBus,
    getDb: () => ensureDb(),
    getActiveKey: () => {
      const state = getActiveKeyState();
      if (state.mode !== "single" || !state.activePublicKeyHash) {
        throw new Error("Active key is required");
      }
      if (!activeIdentity) {
        throw new Error("Active key is not ready");
      }
      if (activeIdentity.publicKeyHash !== state.activePublicKeyHash) {
        throw new Error("Active key is not ready");
      }
      return activeIdentity;
    }
  });

  const statusListeners = new Set<(s: P2pkhSyncStatus) => void>();
  let status: P2pkhSyncStatus = "idle";
  let backfillPaused = false;

  function setStatus(next: P2pkhSyncStatus) {
    status = next;
    for (const l of statusListeners) l(next);
    deps.messageBus.publish(P2PKH_MSG.SYNC, { status: next });
  }

  async function listAllResources(): Promise<P2pkhKeyResource[]> {
    const db = await ensureDb();
    return db.listAddresses();
  }

  function getActiveKeyState() {
    return deps.keyspace.active();
  }

  function requireActiveKeyIdentity(): ReadyKeyIdentity {
    const state = getActiveKeyState();
    if (state.mode !== "single" || !state.activePublicKeyHash) {
      throw new Error("Active key is required");
    }
    if (!activeIdentity || activeIdentity.publicKeyHash !== state.activePublicKeyHash) {
      // 占位 identity：转账流程会在 vault.withPrivateKey 时拿到真实 keyId。
      // 这里不抛错；调用方在签名时必须通过 vault 拿到真实 key。
      throw new Error("Active key is not ready");
    }
    return activeIdentity;
  }

  /**
   * 重新打开当前 active key 的 namespace db。
   * 设计缘由：active key 切换 / Vault 锁定后必须重建 handle；缓存的旧 handle
   * 可能已关闭或属于上一个 key 的 namespace。
   */
  async function ensureDb(): Promise<P2pkhDbHandle> {
    const state = getActiveKeyState();
    if (state.mode !== "single" || !state.activePublicKeyHash) {
      throw new Error("Key storage is not ready");
    }
    if (p2pkhDbHandle && currentPublicKeyHash === state.activePublicKeyHash) {
      return p2pkhDbHandle;
    }
    if (p2pkhDbHandle) {
      disposeP2pkhDb();
      p2pkhDbHandle = null;
    }
    const bundle: P2pkhDbBundle = await openP2pkhDb({
      keyspace: deps.keyspace,
      publicKeyHash: state.activePublicKeyHash
    });
    p2pkhDbHandle = createP2pkhDb(bundle);
    currentPublicKeyHash = state.activePublicKeyHash;
    return p2pkhDbHandle;
  }

  /** 切换 active key 后的 hook：重建 identity 缓存与 db handle。
   * 设计缘由：硬切换 008 收尾 + 硬切换 003 收尾——通过 requireReadyKey
   * 把 KeyIdentity 收窄成 ReadyKeyIdentity，publicKeyHash / publicKeyHex
   * 必填；写入 P2pkhKeyResource 等位置时不再需要 `!`。短公钥不再是
   * contract 字段，UI 需要时由 `formatShortPublicKey(publicKeyHex)` 现算。
   */
  async function rebindActiveKey() {
    const state = getActiveKeyState();
    if (state.mode !== "single" || !state.activePublicKeyHash) {
      activeKeyId = undefined;
      activeIdentity = undefined;
      p2pkhDbHandle = null;
      currentPublicKeyHash = undefined;
      return;
    }
    const identity = await deps.keyspace.getKey(state.activePublicKeyHash);
    if (!identity) {
      throw new Error("Active key identity not found");
    }
    // requireReadyKey 会断言 ready 状态 + 必填字段；failed / uninitialized
    // key 抛 "Active key is not ready"。调用方（keyspace.listActiveCandidates
    // 选出来的就是 ready）一般不会触发，但保留断言作为 fail-closed 保险。
    activeIdentity = requireReadyKey(identity);
    activeKeyId = activeIdentity.keyId;
    // 重建 db handle。
    await ensureDb();
  }

  // 监听 keyspace 变化。
  // 硬切换 008 收尾：切 active key 走与 onVaultUnlocked 同构的完整序列——
  // rebind + rehydrate + trigger recent/backfill——确保任何路径切到新 active
  // 都不会漏建 P2PKH 资源。
  deps.keyspace.onActiveChange(() => {
    void (async () => {
      try {
        await rebindActiveKey();
        await rehydrateResources();
        deps.backgroundService.trigger(P2PKH_TASK_RECENT, "active-key.changed");
        deps.backgroundService.trigger(P2PKH_TASK_BACKFILL, "active-key.changed");
      } catch (err) {
        console.error("P2PKH onActiveChange handler failed", err);
      }
    })();
  });

  // 硬切换 008：实际取消由 keyspace.deleteKey -> background.cancelByKey
  // 统一驱动；本 handler 只做日志/保险，不再调用 cancel。
  deps.messageBus.subscribe<{ publicKeyHash: string }>("key.deleting", (payload) => {
    // 设计缘由：active key 切换不影响本 key 任务的收尾；只有当被删的 key
    // 是 active 时我们才需要清理本地的协调器 lane 与 db handle 缓存。
    // background 已经收到 cancelByKey 并在 await 旧实例退出；本服务接下来
    // 收到的 key.deleted 事件再彻底清掉本地资源。
    void payload;
  });
  deps.messageBus.subscribe<{ publicKeyHash: string }>("key.deleted", async (payload) => {
    try {
      const resources = await listAllResources().catch(() => []);
      for (const r of resources) coordinator.removeResource(r.resourceId);
    } catch (err) {
      console.error("P2PKH key.deleted handler failed", err);
    }
    if (currentPublicKeyHash === payload.publicKeyHash) {
      disposeP2pkhDb();
      p2pkhDbHandle = null;
      currentPublicKeyHash = undefined;
    }
  });

  async function getOrCreateAddress(network: "main" | "test"): Promise<P2pkhKeyResource | null> {
    const db = await ensureDb();
    const resourceId = makeResourceId("", network);
    const existing = await db.getResource(resourceId);
    if (existing) return existing;
    const key = requireActiveKeyIdentity();
    return await deps.vault.withPrivateKey(key.keyId, async (material) => {
      const { address, publicKeyHex } = deriveP2pkhAddress(material.hex, network);
      const resource: P2pkhKeyResource = {
        resourceId,
        keyId: key.keyId,
        publicKeyHash: key.publicKeyHash,
        label: key.label,
        address,
        network,
        createdAt: key.createdAt,
        lastSyncedAt: undefined,
        generation: 0
      };
      await db.putAddress(resource);
      deps.messageBus.publish(P2PKH_MSG.ADDRESS_DERIVED, {
        keyId: key.keyId,
        publicKeyHash: key.publicKeyHash,
        network,
        address,
        publicKeyHex,
        generation: 0
      });
      return resource;
    });
  }

  // ---- 注册 background tasks ----
  /**
   * 任务归属的 key namespace（硬切换 007 / 008）。
   * 设计缘由：008 把 keyScope 改为函数形式以支持延迟求值——注册时只存函数
   * 引用，backgroundService.snapshot() / cancelByKey() 在调用时通过
   * resolveKeyScope 求值。这样 active key 切换不会让 task 仍指向旧 key hash。
   *
   * 硬切换 003 收尾：scope 不再携带 `fingerprint`；若有展示需要，按
   * `BackgroundTaskKeyScope.publicKeyHex` 透传完整公钥，UI 侧再调
   * `formatShortPublicKey()` 现算短公钥。
   */
  function p2pkhTaskKeyScope() {
    const state = getActiveKeyState();
    if (state.mode !== "single" || !state.activePublicKeyHash) {
      return undefined;
    }
    const id = activeIdentity;
    if (!id || id.publicKeyHash !== state.activePublicKeyHash) {
      return { publicKeyHash: state.activePublicKeyHash };
    }
    return {
      publicKeyHash: state.activePublicKeyHash,
      label: id.label,
      publicKeyHex: id.publicKeyHex
    };
  }

  deps.backgroundRegistry.register({
    id: P2PKH_TASK_RECENT,
    pluginId: "p2pkh",
    label: { key: "p2pkh.task.recent.label", fallback: "P2PKH 近期同步" },
    description: { key: "p2pkh.task.recent.description", fallback: "检查余额、UTXO、近期 history 与 reservation 对账（按 active key namespace）。" },
    intervalMs: 60_000,
    defaultEnabled: true,
    // 硬切换 008：传函数本身，由 backgroundService 延迟求值。
    keyScope: p2pkhTaskKeyScope,
    // 硬切换 008 收尾：canRun 必须包含 !keyspace.isInitializing()。
    // 设计缘由：identity backfill 阶段 active key 还没有完全收敛，
    // 让 recent-sync 抢跑会触发 "Key storage is not ready"。ready 边界
    // 由 vault.unlock() 收紧后，这里只需作为保险（防止 background 调度
    // 早于 vault.unlocked 事件订阅者注册）。
    canRun: () =>
      deps.vault.status() === "unlocked" &&
      !deps.keyspace.isInitializing() &&
      getActiveKeyState().mode === "single",
    async run(ctx) {
      setStatus("syncing");
      try {
        await recent.runOnce(ctx.signal);
        setStatus("ok");
      } catch (err) {
        setStatus("failed");
        throw err;
      }
    }
  });

  deps.backgroundRegistry.register({
    id: P2PKH_TASK_BACKFILL,
    pluginId: "p2pkh",
    label: { key: "p2pkh.task.backfill.label", fallback: "P2PKH 历史回填" },
    description: { key: "p2pkh.task.backfill.description", fallback: "分页同步完整确认历史（按 active key namespace）。" },
    defaultEnabled: true,
    // 硬切换 008：传函数本身。
    keyScope: p2pkhTaskKeyScope,
    // 硬切换 008 收尾：canRun 也必须包含 !keyspace.isInitializing()。
    canRun: () =>
      deps.vault.status() === "unlocked" &&
      !backfillPaused &&
      !deps.keyspace.isInitializing() &&
      getActiveKeyState().mode === "single",
    async run(ctx) {
      setStatus("syncing");
      try {
        await backfill.runOnce(ctx.signal, { paused: backfillPaused });
        setStatus("ok");
      } catch (err) {
        setStatus("failed");
        throw err;
      }
    }
  });

  // 监听 vault 锁定/解锁。
  deps.messageBus.subscribe("vault.locked", () => {
    onVaultLocked();
  });
  deps.messageBus.subscribe("vault.unlocked", () => {
    void onVaultUnlocked();
  });

  function onVaultLocked() {
    deps.backgroundService.cancel(P2PKH_TASK_RECENT);
    deps.backgroundService.cancel(P2PKH_TASK_BACKFILL);
    setStatus("idle");
    disposeP2pkhDb();
    p2pkhDbHandle = null;
    currentPublicKeyHash = undefined;
    activeIdentity = undefined;
    activeKeyId = undefined;
  }

  async function onVaultUnlocked() {
    try {
      await rebindActiveKey();
      await rehydrateResources();
      deps.backgroundService.trigger(P2PKH_TASK_RECENT, "vault.unlocked");
      deps.backgroundService.trigger(P2PKH_TASK_BACKFILL, "vault.unlocked");
    } catch (err) {
      deps.messageBus.publish(P2PKH_MSG.REHYDRATE_ERROR, {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  /**
   * 为当前 active key 补齐 main/test 资源。
   * 设计缘由：硬切换后 active key 由平台管理；本服务只需关心当前 namespace。
   */
  async function rehydrateResources(): Promise<void> {
    if (deps.vault.status() !== "unlocked") return;
    const state = getActiveKeyState();
    if (state.mode !== "single" || !state.activePublicKeyHash) return;
    if (!activeIdentity) return;
    try {
      await getOrCreateAddress("main");
      await getOrCreateAddress("test");
    } catch (err) {
      deps.messageBus.publish(P2PKH_MSG.REHYDRATE_ERROR, {
        keyId: activeIdentity.keyId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  deps.messageBus.subscribe(P2PKH_MSG.TRANSFER_BROADCAST, () => {
    deps.backgroundService.trigger(P2PKH_TASK_RECENT, "transfer.broadcast");
  });

  return {
    syncStatus() {
      return status;
    },
    onSyncStatusChange(handler) {
      statusListeners.add(handler);
      return () => statusListeners.delete(handler);
    },

    async triggerRecentSync() {
      deps.backgroundService.trigger(P2PKH_TASK_RECENT, "manual");
    },
    async triggerHistoryBackfill(resourceId) {
      deps.messageBus.publish(P2PKH_MSG.BACKFILL_REQUESTED, { resourceId });
      deps.backgroundService.trigger(P2PKH_TASK_BACKFILL, resourceId ? "manual:resource" : "manual");
    },
    async pauseHistoryBackfill() {
      backfillPaused = true;
      await deps.backgroundService.cancel(P2PKH_TASK_BACKFILL);
    },
    resumeHistoryBackfill: () => {
      backfillPaused = false;
      deps.backgroundService.trigger(P2PKH_TASK_BACKFILL, "resume");
    },

    async getAssetBalance(assetId) {
      const network = assetIdToNetwork(assetId);
      const state = getActiveKeyState();
      const db = await ensureDb();
      const all = await db.listBalances();
      let confirmed = 0, unconfirmed = 0, spendable = 0;
      for (const r of all) {
        if (r.network !== network) continue;
        if (state.mode === "single" && r.publicKeyHash !== state.activePublicKeyHash) continue;
        confirmed += r.confirmed;
        unconfirmed += r.unconfirmed;
        spendable += r.spendable;
      }
      return { confirmed, unconfirmed, spendable, updatedAt: new Date().toISOString() };
    },
    async getResourceBalance(resourceId) {
      const db = await ensureDb();
      const row = await db.getBalanceRow(resourceId);
      return row
        ? { confirmed: row.confirmed, unconfirmed: row.unconfirmed, spendable: row.spendable, updatedAt: row.updatedAt }
        : { confirmed: 0, unconfirmed: 0, spendable: 0, updatedAt: new Date().toISOString() };
    },

    async listResources(assetId) {
      const db = await ensureDb();
      const all = await db.listAddresses();
      if (!assetId) return all;
      const network = assetIdToNetwork(assetId);
      return all.filter((r) => r.network === network);
    },
    async listUtxos(filter) {
      const db = await ensureDb();
      const all = await db.listUtxos();
      return filterUtxos(all, filter);
    },
    async listHistory(filter) {
      const db = await ensureDb();
      const all = await db.listHistory();
      return filterUtxos(all, filter);
    },
    async listBackfillStates() {
      const db = await ensureDb();
      return db.listBackfillStates();
    },
    async listRecentSyncStates() {
      const db = await ensureDb();
      return db.listRecentSyncStates();
    },
    async listPendingTransfers() {
      const db = await ensureDb();
      return db.listPendingTransfers();
    },
    async listReservations() {
      const db = await ensureDb();
      return db.listReservations();
    },

    async allocateUtxos(request) {
      if (!request.assetId || !(request.assetId in P2PKH_ASSETS)) {
        throw new Error("P2PKH provider requires an assetId");
      }
      const db = await ensureDb();
      const all = await db.listUtxos();
      const filtered = filterUtxos(all, {
        assetId: request.assetId,
        keyId: request.keyId
      });
      const reservations = await db.listReservations();
      const reserved = new Set(
        reservations.filter((r) => r.state === "reserved").map((r) => `${r.txid}:${r.vout}`)
      );
      const candidates = filtered.filter((u) => !reserved.has(`${u.txid}:${u.vout}`));
      const result = allocateUtxos(candidates, request);
      if (result.ok) return result.allocation;
      throw new P2pkhAllocationError(result.error);
    },

    prepareTransfer: (input) => {
      // 强制 single active key；输入不再要求 keyId。
      const state = getActiveKeyState();
      if (state.mode !== "single") {
        return Promise.reject(new Error("Cannot sign in all-keys mode"));
      }
      return transfer.prepare({ ...input, keyId: requireActiveKeyIdentity().keyId });
    },
    submitTransfer: (preview, input) => {
      const state = getActiveKeyState();
      if (state.mode !== "single") {
        return Promise.reject(new Error("Cannot sign in all-keys mode"));
      }
      return transfer.submit(preview, { ...input, keyId: requireActiveKeyIdentity().keyId });
    },

    async onKeyImported(_keyId) {
      // 当前 namespace 是 active key；rehydrate 会为 active key 补齐资源。
      // 旧 keyId 参数保留以兼容旧接口，逻辑走 active key。
      try {
        await rehydrateResources();
        deps.backgroundService.trigger(P2PKH_TASK_RECENT, "key.imported");
        deps.backgroundService.trigger(P2PKH_TASK_BACKFILL, "key.imported");
      } catch (err) {
        console.error("P2PKH onKeyImported failed", err);
      }
    },
    async onKeyRemoved(_keyId) {
      // 实际删除由 keyspace.deleteKey 统一调度；这里只清理协调器 lane。
      try {
        const resources = await listAllResources().catch(() => []);
        for (const r of resources) coordinator.removeResource(r.resourceId);
      } catch (err) {
        console.error("P2PKH onKeyRemoved failed", err);
      }
    },
    onVaultLocked,
    onVaultUnlocked,
    async rehydrate() {
      await rebindActiveKey();
      await rehydrateResources();
    }
  };
}

function filterUtxos<T extends { network: "main" | "test"; keyId: string; publicKeyHash: string; resourceId: string }>(
  rows: T[],
  filter: P2pkhUtxoFilter | undefined
): T[] {
  if (!filter) return rows;
  return rows.filter((r) => {
    if (filter.assetId) {
      const net = assetIdToNetwork(filter.assetId);
      if (r.network !== net) return false;
    }
    if (filter.keyId && r.keyId !== filter.keyId) return false;
    if (filter.resourceId && r.resourceId !== filter.resourceId) return false;
    return true;
  });
}

void (null as unknown as P2pkhTransferService);
void (null as unknown as P2pkhBalance);
void (null as unknown as P2pkhHistoryItem);
void (null as unknown as P2pkhUtxo);
void (null as unknown as UtxoAllocation);
void (null as unknown as UtxoAllocationRequest);
void (null as unknown as P2pkhBackfillState);
void (null as unknown as P2pkhPendingTransfer);
void (null as unknown as P2pkhUtxoReservation);
void (null as unknown as P2pkhTransferInput);
void (null as unknown as P2pkhTransferPreview);
void (null as unknown as P2pkhTransferResult);
void (null as unknown as P2pkhAssetId);
void BACKGROUND_REGISTRY_CAPABILITY;
void BACKGROUND_SERVICE_CAPABILITY;
