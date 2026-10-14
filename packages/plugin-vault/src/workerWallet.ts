import type { WalletColdStartSnapshot, WalletInitializePlan, WalletInitializeResult, WalletLifecycleEvent, WalletLifecycleService, BsvNetwork } from "@keymaster/contracts";
import { WALLET_MIGRATION_PATH, StorageRuntimeError, type WalletStore } from "@keymaster/contracts/storage-internal";
import {
  createWalletKeyRepository, type WalletKeyRepository, createWalletLifecycleService,
  createMigrationJournalService, inspectWalletKeyBytes,
} from "./coordinator.js";
export interface VaultWalletWorkerPorts {
  session(): { walletGeneration: string; sessionEpoch: string; runGeneration: string };
  commit(patch: { walletGeneration?: string }): void;
  createStore(): WalletStore;
  bootstrapStorage(store: WalletStore): {
    keys: Parameters<typeof createWalletKeyRepository>[0]; lifecycle: Parameters<typeof createWalletLifecycleService>[0]["store"];
    migration: Parameters<typeof createMigrationJournalService>[0]["store"];
  };
  unavailable(message: string): Error;
  network(network: BsvNetwork): void;
  transitions: Pick<Parameters<typeof createWalletLifecycleService>[0], "revokeGrants" | "establishSession" | "adoptUnlockedKey">;
  clearAppRoot(name: string): Promise<void>;
  binding: { installRoot(): Promise<void>; loadSettings(): Promise<void>; ensureStorage(): Promise<unknown>; ensureTasks(): Promise<void>; complete(cause: "initialize"): Promise<void>; lock(reason: string): Promise<void> };
}
/** 唯一 Key 仓储、钱包生命周期与冷启动事实归 Vault；公共层只编排会话提交。 */
export function createVaultWalletWorker(ports: VaultWalletWorkerPorts) {
  let walletStore: WalletStore | undefined;

  let walletKeys: WalletKeyRepository | undefined;

  let walletLifecycle: ReturnType<typeof createWalletLifecycleService> | undefined;

  let storageColdStartState: WalletColdStartSnapshot | undefined;

  function requireWalletLifecycle(): WalletLifecycleService {
    if (!walletLifecycle) throw ports.unavailable("Wallet lifecycle is unavailable");
    return walletLifecycle;
  }

  function publishWalletLifecycleEvent(event: WalletLifecycleEvent): void {
    switch (event.type) {
      case "initialized":
        ports.commit({ walletGeneration: event.walletGeneration });
        storageColdStartState = undefined;
        break;
      case "unlocked":
        // adoptUnlockedKey 已经写好会话状态；这里只补广播所需的冷启动结论。
        storageColdStartState = undefined;
        break;
      case "locked":
        storageColdStartState = storageColdStartState?.state === "ready"
          ? { ...storageColdStartState }
          : storageColdStartState;
        break;
      case "reset":
        // 重置后回到未初始化：清掉冷启动结论，下一次判断重新读本地真值。
        ports.commit({ walletGeneration: "" });
        storageColdStartState = undefined;
        break;
      case "renamed":
        break;
      case "password-changed":
      case "app-revoked":
        break;
      default:
        break;
    }
  }

  async function bootstrapWalletStorage(): Promise<void> {
    if (!walletStore) {
      walletStore = ports.createStore();
    }
    const vaultStorage = ports.bootstrapStorage(walletStore);
    if (!walletKeys) {
      walletKeys = createWalletKeyRepository(vaultStorage.keys);
    }
    walletLifecycle = createWalletLifecycleService({
      store: vaultStorage.lifecycle,
      keys: walletKeys,
      generateSessionEpoch: () => crypto.randomUUID(),
      // `address` 只是兼容展示字段，不是身份真值；本 Worker 不在存储层派生
      // 地址，摘要会退回公钥 hex，业务插件需要时从 P2PKH resource 自行派生。
      deriveAddress: () => undefined,
      revokeGrants: ports.transitions.revokeGrants,
      establishSession: ports.transitions.establishSession,
      adoptUnlockedKey: ports.transitions.adoptUnlockedKey,
      publish: publishWalletLifecycleEvent,
      runGeneration: () => ports.session().runGeneration,
      currentSessionEpoch: () => ports.session().sessionEpoch,
      clearAppRoot: ports.clearAppRoot,
    });
    // 冷启动只读 meta 与固定 KeyHold；这里不恢复任何运行态授权。
    storageColdStartState = await walletLifecycle.coldStart();
    if (storageColdStartState.state === "ready") {
      ports.network(storageColdStartState.key!.bsvNetwork);
      ports.commit({ walletGeneration: storageColdStartState.walletGeneration ?? ports.session().walletGeneration });
      await ports.binding.installRoot();
      return;
    }
    if (storageColdStartState.state === "corrupt" || storageColdStartState.state === "unsupported") {
      // 数据不可用时不装配可写 Root，避免任何路径覆盖仍可能可恢复的数据。
      throw new StorageRuntimeError(
        storageColdStartState.state === "corrupt" ? "storage_wallet_corrupt" : "storage_wallet_unsupported",
        storageColdStartState.reason ?? "Local wallet data is unusable",
      );
    }
    // uninitialized：没有 Root，也没有任何本地业务数据；等待创建或导入。
  }

  async function initializeWallet(plan: WalletInitializePlan): Promise<WalletInitializeResult> {
    const lifecycle = requireWalletLifecycle();
    // 提交前必须确认本地确实还没有钱包；并发初始化由 lifecycle 的条件创建
    // 拒绝，这里只提前给出可行动的失败。
    const before = await lifecycle.coldStart();
    if (before.state !== "uninitialized") {
      if (before.state === "unsupported") {
        throw new StorageRuntimeError("storage_wallet_unsupported", "Local wallet schema is newer than this build");
      }
      if (before.state === "corrupt") {
        throw new StorageRuntimeError("storage_wallet_corrupt", "Wallet data is incomplete or damaged");
      }
      throw new StorageRuntimeError("storage_conflict", "This wallet already has a key");
    }

    const result = await lifecycle.initialize(plan);
    if (!result.ok) return result;

    // adoptUnlockedKey 已经写入 sessionEpoch、钱包世代与私钥副本。
    try {
      ports.commit({ walletGeneration: result.walletGeneration });
      storageColdStartState = undefined;
      await ports.binding.installRoot();
      await ports.binding.loadSettings();
      await ports.binding.ensureStorage();
      await ports.binding.ensureTasks();
      await ports.binding.complete("initialize");
    } catch (error) {
      // 装配失败不回滚已提交的 Key（那是事务真相），但会话必须 fail closed
      // 回 locked：页面看到的是「需要重新解锁」，而不是半装配的可用状态。
      await ports.binding.lock("initialize-binding-failed").catch(() => undefined);
      throw error;
    }
    return result;
  }
  return {
    get walletStore() { return walletStore; }, set walletStore(value: typeof walletStore) { walletStore = value; },
    get walletKeys() { return walletKeys; }, set walletKeys(value: typeof walletKeys) { walletKeys = value; },
    get walletLifecycle() { return walletLifecycle; }, set walletLifecycle(value: typeof walletLifecycle) { walletLifecycle = value; },
    get storageColdStartState() { return storageColdStartState; }, set storageColdStartState(value: typeof storageColdStartState) { storageColdStartState = value; },
    bootstrapStorage: ports.bootstrapStorage,
    requireWalletLifecycle,
    publishWalletLifecycleEvent,
    bootstrapWalletStorage,
    initializeWallet,
  };
}
