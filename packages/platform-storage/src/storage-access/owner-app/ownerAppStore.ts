import type {
  OwnerAppStore,
  KeyValueStore,
  StorageBucketProvider,
  StorageBucketRef,
  StorageNamespaceBinding,
  PluginStorageDeclaration
} from "@keymaster/contracts";
import { buildStorageNamespaceRoot, validateOwnerPublicKeyHex, validatePluginStorageDeclaration } from "@keymaster/contracts";
import { createKeyValueStore } from "../../kv-engine/partitionedKvEngine.js";
import { StorageRuntimeError } from "../../runtime/storageRuntimeError.js";

export interface OwnerAppStoreOptions {
  /** 当前抽象桶 Provider；业务调用方不能自行替换。 */
  provider: StorageBucketProvider;
  /** 当前桶及其运行世代。 */
  bucket: StorageBucketRef;
  /** Host 校验后的 owner/App 存储声明。 */
  declaration: PluginStorageDeclaration;
  /** 当前 owner 的压缩公钥。 */
  ownerPublicKeyHex: string;
  /** 切桶或切 Key 后让旧句柄 fail closed。 */
  isCurrent?: () => boolean;
  /** 跨 Coordinator/设备的持久化 owner 世代栅栏。 */
  assertCurrentAsync?: () => Promise<void>;
  /** 一次完整 K-V 请求持有的持久化 owner lease。 */
  acquireCurrentAsync?: () => Promise<() => Promise<void>>;
}

/**
 * 构造已绑定 owner/App 的 K-V 句柄。
 *
 * 这是唯一的 owner/App 权限入口：bucket、owner、App 声明在此形成不可变
 * binding，K-V 引擎只接收 binding，不接收调用方提供的物理路径。
 */
export function createOwnerAppStore(options: OwnerAppStoreOptions): OwnerAppStore {
  if (options.declaration.scope !== "key") {
    throw new StorageRuntimeError("storage_forbidden", "Owner App storage must use key scope");
  }
  if (options.provider.bucketId !== options.bucket.bucketId) {
    throw new StorageRuntimeError("storage_forbidden", "Storage bucket binding mismatch");
  }
  const ownerPublicKeyHex = validateOwnerPublicKeyHex(options.ownerPublicKeyHex);
  const declaration = validatePluginStorageDeclaration(options.declaration);
  const binding: StorageNamespaceBinding = Object.freeze({
    ...declaration,
    bucketId: options.bucket.bucketId,
    bucketGeneration: options.bucket.bucketGeneration,
    ownerPublicKeyHex
  });
  buildStorageNamespaceRoot(binding);
  return createKeyValueStore({
    provider: options.provider,
    binding,
    isCurrent: options.isCurrent,
    assertCurrentAsync: options.assertCurrentAsync,
    acquireCurrentAsync: options.acquireCurrentAsync
  });
}
