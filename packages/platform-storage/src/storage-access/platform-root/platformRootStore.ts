import { sameNetworkIdentity, networkIdentityStorageRoot, type NetworkIdentity } from "@keymaster/contracts";
import type { StorageBrowseWallet } from "../../runtime/storageBrowsePrivate.js";
// 平台存储根：所有受限句柄的唯一装配点。
//
// 这里是唯一能把「中央声明 + 当前世代」组合成打开句柄的入口。业务插件和第三方
// App 只能通过它拿到已绑定句柄，不能自报物理路径、module 或 purpose。
//
// 变更要点：
//   - 不再有 Provider、bucket 与 bucketGeneration；物理数据按逻辑根隔离，权限
//     由绑定里的四件事（钱包世代、会话 epoch、运行世代、App 身份）保证；
//   - 清空一个根按前缀分页删除，不全量读取对象字节；
//   - platform-only 与 built-in-module 直接使用可信装配提供的声明。

import type {
  KeyValueStore,
  ModuleFileStore,
  OwnerAppStore,
  PlatformRootStore,
  PluginStorageDeclaration,
  SnapshotStore,
  StorageNamespaceBinding,
  StorageSnapshotJsonCompatible,
} from "@keymaster/contracts";
import {
  buildStorageNamespaceRoot,
  buildWalletStorageRoot,
  normalizeAppStorageName,
} from "@keymaster/contracts";
import { createKeyValueStore } from "../../kv-engine/walletKvEngine.js";
import type { WalletStore } from "../../local/indexedDbWalletStore.js";
import { StorageRuntimeError } from "../../runtime/storageError.js";
import { createFixedCasSnapshotStore } from "../../snapshot/fixedCasSnapshotStore.js";
import { createModuleFileStore } from "../wallet/moduleFileStore.js";

/** 只供 Storage Worker 实现与可信装配使用，不发布给其他插件。 */
export interface StoragePrivateRootStore extends PlatformRootStore {
  openBrowseStore(): Promise<StorageBrowseWallet>;
  /** 只交给可信 Worker 装配；普通模块入口不能打开核心额度账本。 */
  openPlatformFileStore(input: { declaration: PluginStorageDeclaration }): Promise<ModuleFileStore>;
}

export interface PlatformRootStoreOptions {
  identity: NetworkIdentity;
  /** 正式本地介质；只由 Coordinator 注入。 */
  store: WalletStore;
  /** 每次装配时由 Coordinator 提供的当前世代快照。 */
  generations: () => {
    walletGeneration: string;
    sessionEpoch: string;
    runGeneration: string;
  };
  /**
   * 逐 grant 的撤销栅栏。默认只比较世代；Coordinator 额外用它在 App 撤权时让
   * 已发放的句柄立即 fail closed。
   */
  isCurrent?: (binding: StorageNamespaceBinding) => boolean;
}

const CLEAR_LIST_LIMIT = 256;
const CLEAR_MAX_PASSES = 64;
const CLEAR_REQUIRED_EMPTY_PASSES = 2;

function isStorageConflict(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "storage_conflict");
}

/** 构造平台存储根。 */
export function createPlatformRootStore(options: PlatformRootStoreOptions): StoragePrivateRootStore {
  const identity = Object.freeze({ ...options.identity });
  /**
   * 世代栅栏：句柄绑定时的世代必须仍然是当前世代。
   *
   * 锁定、改密、重置、App 撤权和 Worker 重启都会改变其中一项，因此旧句柄和
   * 迟到的异步结果在这里被拒绝，而不是依赖页面先关掉按钮。
   */
  function gateFor(binding: StorageNamespaceBinding): () => boolean {
    return () => {
      const live = options.generations();
      if (!sameNetworkIdentity(binding, identity)) return false;
      if (binding.walletGeneration !== live.walletGeneration) return false;
      if (binding.sessionEpoch !== live.sessionEpoch) return false;
      if (binding.runGeneration !== live.runGeneration) return false;
      return options.isCurrent?.(binding) ?? true;
    };
  }

  /** 浏览视图是否仍对应当前这一代 Root 装配。 */
function platformRootMatchesGeneration(live: { walletGeneration: string; sessionEpoch: string; runGeneration: string }): boolean {
  const bound = options.generations();
  return bound.walletGeneration === live.walletGeneration
    && bound.sessionEpoch === live.sessionEpoch
    && bound.runGeneration === live.runGeneration;
}

  function currentBinding(): StorageNamespaceBinding {
    const live = options.generations();
    return Object.freeze({
      ...identity,
      moduleId: "coordinator",
      purposeId: "settings",
      authority: "platform-only",
      model: "kv",
      schemaVersion: 1,
      walletGeneration: live.walletGeneration,
      sessionEpoch: live.sessionEpoch,
      runGeneration: live.runGeneration,
    });
  }

  function bind(declaration: PluginStorageDeclaration): StorageNamespaceBinding {
    const live = options.generations();
    const binding: StorageNamespaceBinding = Object.freeze({
      ...declaration,
      ...identity,
      walletGeneration: live.walletGeneration,
      sessionEpoch: live.sessionEpoch,
      runGeneration: live.runGeneration,
    });
    return binding;
  }

  /**
   * 第三方 App 绑定：目录由平台登记 name 决定，访问权由验证身份决定。
   *
   * 两者缺一不可：只有相同显示名称、或只有 name 相同而身份不同，都不能获得
   * 同一个目录的读写。
   */
  function bindApp(
    declaration: PluginStorageDeclaration,
    appStorageName: string | undefined,
    verifiedAppIdentity: { publisherPublicKeyHex: string; appId: string } | undefined,
  ): StorageNamespaceBinding {
    if (declaration.authority !== "third-party-app") {
      throw new StorageRuntimeError("storage_forbidden", "App identity is only valid for third-party-app authority");
    }
    if (appStorageName === undefined) {
      throw new StorageRuntimeError("storage_forbidden", "Third-party app storage requires a registered appStorageName");
    }
    if (!verifiedAppIdentity) {
      throw new StorageRuntimeError("storage_forbidden", "Third-party app storage requires a verified app identity");
    }
    const live = options.generations();
    const binding: StorageNamespaceBinding = Object.freeze({
      ...declaration,
      ...identity,
      walletGeneration: live.walletGeneration,
      sessionEpoch: live.sessionEpoch,
      runGeneration: live.runGeneration,
      appStorageName: normalizeAppStorageName(appStorageName),
      verifiedAppIdentity: {
        publisherPublicKeyHex: verifiedAppIdentity.publisherPublicKeyHex.toLowerCase(),
        appId: verifiedAppIdentity.appId,
      },
    });
    return binding;
  }

  /** 清空一个已绑定根下的全部对象；按前缀分页，不全量读字节。 */
  async function clearRoot(root: string): Promise<void> {
    let emptyPasses = 0;
    for (let pass = 0; pass < CLEAR_MAX_PASSES; pass += 1) {
      const page = await options.store.list({ prefix: root, limit: CLEAR_LIST_LIMIT });
      if (page.objects.length === 0) {
        emptyPasses += 1;
        if (emptyPasses >= CLEAR_REQUIRED_EMPTY_PASSES) return;
        continue;
      }
      emptyPasses = 0;
      for (const object of page.objects) {
        try {
          await options.store.delete(object.path, { ifRevision: object.revision });
        } catch (error) {
          // 并发写入或另一个清理者替换了对象：下一轮重新列出并使用最新
          // revision，不因一次 CAS 冲突把整次清理判为失败。
          if (!isStorageConflict(error)) throw error;
        }
      }
    }
    throw new StorageRuntimeError("storage_unavailable", "Storage root did not become empty before the deletion deadline");
  }

  return {
    identity,
    get walletGeneration(): string {
      return options.generations().walletGeneration;
    },
    async openBrowseStore(): Promise<StorageBrowseWallet> {
      // 每次打开都重新绑定当前世代：上一代 Root 拆掉的句柄不能继续读新钱包。
      const isCurrent = (): boolean => {
        const live = options.generations();
        if (options.isCurrent?.({ ...currentBinding() } as StorageNamespaceBinding) === false) return false;
        return platformRootMatchesGeneration(live);
      };
      const assertCurrent = (): void => {
        if (!isCurrent()) throw new StorageRuntimeError("storage_unavailable", "Storage browse root is stale");
      };
      return {
        async list(input) {
          assertCurrent();
          return options.store.list({
            ...(input?.prefix === undefined ? {} : { prefix: input.prefix }),
            ...(input?.cursor === undefined ? {} : { cursor: input.cursor }),
            ...(input?.limit === undefined ? {} : { limit: input.limit }),
            ...(input?.signal === undefined ? {} : { signal: input.signal }),
          });
        },
        async get(path, getOptions) {
          assertCurrent();
          return options.store.get(path, getOptions?.signal === undefined ? undefined : { signal: getOptions.signal });
        },
      };
    },
    async openKeyValueStore(input): Promise<OwnerAppStore> {
      const binding = bind(input.declaration);
      return createKeyValueStore({ store: options.store, binding, isCurrent: gateFor(binding) });
    },
    async openModuleFileStore(input): Promise<ModuleFileStore> {
      const declaration = input.declaration;
      if (declaration.authority === "third-party-app") {
        const binding = bindApp(declaration, input.appStorageName, input.verifiedAppIdentity);
        return createModuleFileStore({ store: options.store, binding, isCurrent: gateFor(binding) });
      }
      const binding = bind(declaration);
      return createModuleFileStore({ store: options.store, binding, isCurrent: gateFor(binding) });
    },
    openPlatformFileStore: async (input: { declaration: PluginStorageDeclaration }): Promise<ModuleFileStore> => {
      const binding = bind(input.declaration);
      return createModuleFileStore({ store: options.store, binding, isCurrent: gateFor(binding) });
    },
    openPlatformSnapshot: async <T>(input: {
      declaration: PluginStorageDeclaration;
      validate: (value: unknown) => StorageSnapshotJsonCompatible<T>;
    }): Promise<SnapshotStore<T>> => {
      const binding = bind(input.declaration);
      return createFixedCasSnapshotStore({ store: options.store, binding, isCurrent: gateFor(binding), validate: input.validate });
    },
    openPlatformStore: async (input: { declaration: PluginStorageDeclaration }): Promise<KeyValueStore> => {
      const binding = bind(input.declaration);
      return createKeyValueStore({ store: options.store, binding, isCurrent: gateFor(binding) });
    },
    async clearStorageRoot(input): Promise<void> {
      const declaration = input.declaration;
      if (declaration.authority === "third-party-app") {
        // 单 App 清理只作用于它自己的目录，不影响其它 App 或平台记录。
        if (input.appStorageName === undefined) {
          throw new StorageRuntimeError("storage_forbidden", "Clearing an app root requires its registered appStorageName");
        }
        const root = networkIdentityStorageRoot(identity) + buildWalletStorageRoot({
          authority: "third-party-app",
          moduleId: declaration.moduleId,
          purposeId: declaration.purposeId,
          appStorageName: normalizeAppStorageName(input.appStorageName),
        });
        await clearRoot(root);
        return;
      }
      await clearRoot(buildStorageNamespaceRoot(bind(declaration)));
    },
  };
}
