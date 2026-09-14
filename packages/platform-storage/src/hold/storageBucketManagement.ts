// 桶密码与 Hold 配置生命周期服务。
//
// 该服务不缓存 password、CryptoContext 或派生密钥。每个公开操作都在 finally
// 中释放上下文；调用方拿到的私钥字节也必须在自己的操作完成后清零。

import type {
  StorageBucketCatalogEntryV2,
  StorageBucketConnectionConfigV1,
  StorageHoldHeadExpectation,
  StorageKeyDerivationV1,
  StorageRecordV1,
  StorageBucketProvider
} from "@keymaster/contracts";
import type { HoldDocument, KeyRecord } from "keymaster-hold/browser";
import {
  createBucketCryptoContext,
  decryptBucketConfig,
  decryptBucketKey,
  deriveBucketCryptoContext,
  encryptBucketConfig,
  encryptBucketKey,
  parseBucketDocument,
  sealBucketDocument,
  serializeBucketDocument,
  toContractDerivation,
  toContractStorageRecord,
  verifyBucketDocument
} from "./keymasterHoldAdapter.js";
import { createStorageCatalogRepository, removeStorageCatalogEntry, sameStorageCatalogEntry, type CreateStorageBucketInput } from "../bootstrap/storageCatalogRepository.js";
import { createStorageHoldSnapshotRepository } from "./storageHoldSnapshotRepository.js";
import { StorageRuntimeError } from "../runtime/storageError.js";

export interface BucketManagementDependencies {
  catalog?: ReturnType<typeof createStorageCatalogRepository>;
}

export interface PreparedBucketConfig {
  /** 本机目录可以保存的桶条目。 */
  entry: StorageBucketCatalogEntryV2;
  /** 连接配置已在本次密码操作中成功解密验证。 */
  config: StorageBucketConnectionConfigV1;
}

function wipe(bytes: Uint8Array | undefined): void {
  try { bytes?.fill(0); } catch { /* 仅尽力清零可控缓冲区 */ }
}

function sameStorageRecord(left: StorageRecordV1, right: StorageRecordV1): boolean {
  const leftCipher = left.cipher;
  const rightCipher = right.cipher;
  return leftCipher.algorithm === rightCipher.algorithm
    && leftCipher.keyLengthBits === rightCipher.keyLengthBits
    && leftCipher.ivB64Url === rightCipher.ivB64Url
    && leftCipher.tagLengthBits === rightCipher.tagLengthBits
    && leftCipher.ciphertextAndTagB64Url === rightCipher.ciphertextAndTagB64Url;
}

/** 外层桶管理和 Key 生命周期的无状态服务。 */
export function createStorageBucketManagementService(deps: BucketManagementDependencies = {}) {
  // Worker 内没有 Window/localStorage；把目录 Repository 延迟到真正需要
  // 本机目录的操作，允许 Worker 只负责“当前桶快照改密”而不触碰页面目录。
  let catalog = deps.catalog;
  function getCatalog() {
    return catalog ?? (catalog = createStorageCatalogRepository());
  }

  async function prepareBucketConfig(
    config: StorageBucketConnectionConfigV1,
    password: string,
    input: Omit<CreateStorageBucketInput, "keyDerivation" | "encryptedConfig"> & {
      /** 保存目录后立即创建首个完整 Hold 快照；只由外层管理页注入。 */
      createProvider?: (bucketId: string) => StorageBucketProvider;
      /** 新桶快照绑定的桶会话世代。 */
      bucketGeneration?: number;
    }
  ): Promise<StorageBucketCatalogEntryV2> {
    const context = await createBucketCryptoContext(password);
    try {
      const encryptedConfig = await encryptBucketConfig(config, context);
      const keyDerivation = { ...context.keyDerivation } as StorageKeyDerivationV1;
      const { createProvider, bucketGeneration, ...catalogInput } = input;
      // 这里只构造目录条目，不写入 localStorage。新桶必须先完成首个
      // Hold 快照，最后才通过一次目录 CAS 暴露给其他标签页。
      const entry = getCatalog().createBucketEntry({ ...catalogInput, keyDerivation, encryptedConfig });
      if (!createProvider) return getCatalog().commitBucket(entry);
      const provider = createProvider(entry.bucketId);
      try {
        const committed = await initializeBucketSnapshot({ entry, password, provider, bucketGeneration, persistCatalog: false });
        // 这是新桶唯一一次目录写入点：Hold 已经完整提交后，才让
        // bootstrap、切桶和 Header 看到它。
        return getCatalog().commitBucket({ ...entry, snapshotRevision: committed.header.snapshotRevision });
      } finally {
        provider.dispose();
      }
    } finally {
      context.dispose();
    }
  }

  async function unlockBucketConfig(entry: StorageBucketCatalogEntryV2, password: string): Promise<StorageBucketConnectionConfigV1> {
    const context = await deriveBucketCryptoContext(password, entry.keyDerivation);
    try {
      return await decryptBucketConfig(entry.encryptedConfig, context);
    } finally {
      context.dispose();
    }
  }

  async function decryptKeyForOperation(record: KeyRecord, keyDerivation: StorageKeyDerivationV1, password: string): Promise<{ label: string; publicKeyHex: string; privateKey: Uint8Array }> {
    const context = await deriveBucketCryptoContext(password, keyDerivation);
    try {
      const result = await decryptBucketKey(record, context);
      return { label: result.label, publicKeyHex: result.publicKeyHex, privateKey: result.privateKey };
    } catch (error) {
      // SDK 只返回独立明文缓冲区；失败路径也不让未来实现遗留它。
      throw error;
    } finally {
      context.dispose();
    }
  }

  async function sealConfigAndKeys(input: {
    config: StorageBucketConnectionConfigV1;
    keys: Array<{ label: string; privateKey: Uint8Array }>;
    password: string;
  }): Promise<{ document: HoldDocument; keyDerivation: StorageKeyDerivationV1 }> {
    const context = await createBucketCryptoContext(input.password);
    try {
      const storage = await encryptBucketConfig(input.config, context);
      const keys: KeyRecord[] = [];
      try {
        for (const key of input.keys) keys.push(await encryptBucketKey({ label: key.label, privateKey: key.privateKey }, context));
        const document = await sealBucketDocument(storage, keys, context);
        return { document, keyDerivation: { ...context.keyDerivation } };
      } finally {
        for (const key of input.keys) wipe(key.privateKey);
      }
    } finally {
      context.dispose();
    }
  }

  async function publishSealedSnapshot(input: { provider: StorageBucketProvider; document: HoldDocument; configRevision: number; bucketGeneration: number; snapshotId?: string; expectedHead: StorageHoldHeadExpectation }) {
    return createStorageHoldSnapshotRepository(input.provider).publish(input);
  }

  function expectedHead(head: { etag?: string }): StorageHoldHeadExpectation {
    return head.etag === undefined ? { kind: "absent" } : { kind: "etag", etag: head.etag };
  }

  /**
   * 为刚保存的桶建立第一个完整 Hold 快照。
   *
   * `entry.encryptedConfig` 与目录中的 KDF 参数来自同一个上下文；这里只
   * 用输入密码临时派生上下文来生成空 Key 集合的认证文档，之后立即释放。
   * 若“远端发布成功、目录修订写入失败”，再次点击保存时会识别同一配置
   * 修订并收敛目录，不重复生成一组无法引用的快照。
   */
  async function initializeBucketSnapshot(input: {
    entry: StorageBucketCatalogEntryV2;
    password: string;
    provider: StorageBucketProvider;
    bucketGeneration?: number;
    /** 新桶暂存时跳过目录更新，由调用方最后 commitBucket。 */
    persistCatalog?: boolean;
  }) {
    const repository = createStorageHoldSnapshotRepository(input.provider);
    const existingHead = await repository.readHead();
    if (existingHead.value?.configRevision === input.entry.configRevision) {
      const committed = await repository.readCommitted();
      if (input.persistCatalog !== false && input.entry.snapshotRevision !== committed.header.snapshotRevision) {
        await getCatalog().updateBucket(input.entry.bucketId, { snapshotRevision: committed.header.snapshotRevision }, input.entry);
      }
      return committed;
    }

    const context = await deriveBucketCryptoContext(input.password, input.entry.keyDerivation);
    try {
      // sealDocument 会在生成 integrity 前解密校验 storage 记录；错误密码
      // 或目录密文篡改都不会发布新的提交头。
      const document = await sealBucketDocument(input.entry.encryptedConfig, [], context);
      const committed = await repository.publish({
        document,
        configRevision: input.entry.configRevision,
        bucketGeneration: input.bucketGeneration ?? 1,
        expectedHead: expectedHead(existingHead)
      });
      if (input.persistCatalog !== false) {
        await getCatalog().updateBucket(input.entry.bucketId, { snapshotRevision: committed.header.snapshotRevision }, input.entry);
      }
      return committed;
    } finally {
      context.dispose();
    }
  }

  /**
   * 修改桶连接配置并重建完整 Hold 认证快照。
   *
   * 配置变更不允许只替换本机目录里的 encryptedConfig：Hold integrity
   * 同时覆盖 storage 与 keys，所以必须在桶密码上下文中重新 seal。旧、
   * 新 Provider 可以不同，用于迁移 Endpoint/Bucket/Prefix；本机目录
   * 更新失败时通过新 Provider 的提交头 CAS 回滚，旧 Provider 不会被覆盖。
   */
  async function changeBucketConnectionConfig(input: {
    entry: StorageBucketCatalogEntryV2;
    provider: StorageBucketProvider;
    nextProvider: StorageBucketProvider;
    config: StorageBucketConnectionConfigV1;
    password: string;
    /** 可选的显示名称变更；与连接密文在同一目录更新中提交。 */
    label?: string;
    bucketGeneration?: number;
    /** Worker 仅负责当前桶跨存储提交时使用。 */
    persistCatalog?: boolean;
  }): Promise<StorageBucketCatalogEntryV2> {
    if ((input.config.kind === "local" ? "local" : "s3") !== input.entry.backend) {
      throw new Error("Storage bucket backend cannot be changed in-place");
    }
    const previousRepository = createStorageHoldSnapshotRepository(input.provider);
    const nextRepository = createStorageHoldSnapshotRepository(input.nextProvider);
    const previous = await previousRepository.readCommitted();
    if (previous.header.configRevision !== input.entry.configRevision) {
      throw new Error("Storage bucket configuration changed; reload and retry");
    }
    if (!sameStorageRecord(previous.storage, input.entry.encryptedConfig)) {
      throw new Error("Storage bucket configuration snapshot does not match the local catalog");
    }

    let password = input.password;
    const context = await deriveBucketCryptoContext(password, input.entry.keyDerivation);
    let encryptedConfig: StorageRecordV1;
    let document: HoldDocument;
    try {
      await verifyBucketDocument(previous.document, context);
      // 显式解密旧配置，确认输入是桶密码，而不是仅凭完整文档 HMAC
      // 认为它可以用于新的 storage 记录。
      await decryptBucketConfig(input.entry.encryptedConfig, context);
      encryptedConfig = await encryptBucketConfig(input.config, context);
      document = await sealBucketDocument(encryptedConfig, previous.document.keys, context);
    } finally {
      context.dispose();
      password = "";
    }

    const nextConfigRevision = input.entry.configRevision + 1;
    const nextHead = await nextRepository.readHead();
    const published = await nextRepository.publish({
      document,
      configRevision: nextConfigRevision,
      bucketGeneration: input.bucketGeneration ?? 1,
      // 同一逻辑桶的连接配置可能指向已有物理根。即使新 Provider
      // 是另一个对象，也必须以目标根当前提交头做 CAS，不能覆盖并发
      // 标签页刚发布的版本。
      expectedHead: expectedHead(nextHead)
    });
    try {
      const nextEntry: StorageBucketCatalogEntryV2 = {
        ...input.entry,
        ...(input.label?.trim() ? { label: input.label.trim() } : {}),
        configRevision: nextConfigRevision,
        encryptedConfig,
        snapshotRevision: published.header.snapshotRevision
      };
      if (input.persistCatalog === false) return nextEntry;
      return await getCatalog().updateBucket(input.entry.bucketId, {
        ...(input.label?.trim() ? { label: input.label.trim() } : {}),
        configRevision: nextConfigRevision,
        encryptedConfig,
        snapshotRevision: published.header.snapshotRevision
      }, input.entry);
    } catch (error) {
      if (published.headEtag) {
        try {
          await nextRepository.publish({
            document: previous.document,
            configRevision: previous.header.configRevision,
            bucketGeneration: input.bucketGeneration ?? 1,
            expectedHead: { kind: "etag", etag: published.headEtag }
          });
        } catch (rollbackError) {
          throw new Error(`Storage bucket configuration update could not update the local catalog and rollback was not confirmed: ${rollbackError instanceof Error ? rollbackError.message : "unknown rollback error"}`);
        }
      }
      throw error;
    }
  }

  /**
   * 导入一个完整 Hold 文件到新桶。
   *
   * 先在临时上下文中验证整文档 HMAC，再解密 storage 得到连接配置；Key
   * 密文原样交给快照仓库，不把私钥解密到本函数，也不把导入文件写入本机
   * 目录。远端发布成功后才把带 snapshotRevision 的条目一次性写入目录；
   * 失败时目录中从未出现半成品条目。
   */
  async function importBucketDocument(input: {
    document: string | Uint8Array;
    password: string;
    label: string;
    createProvider: (config: StorageBucketConnectionConfigV1, bucketId: string) => StorageBucketProvider;
    bucketGeneration?: number;
  }): Promise<StorageBucketCatalogEntryV2> {
    let password = input.password;
    let entry: StorageBucketCatalogEntryV2 | undefined;
    let provider: StorageBucketProvider | undefined;
    try {
      const document = parseBucketDocument(input.document);
      const keyDerivation = toContractDerivation(document.keyDerivation);
      const context = await deriveBucketCryptoContext(password, keyDerivation);
      let config: StorageBucketConnectionConfigV1;
      try {
        await verifyBucketDocument(document, context);
        config = await decryptBucketConfig(toContractStorageRecord(document.storage), context);
      } finally {
        context.dispose();
      }

      // 导入和新建遵循同一事务边界：先在本地内存构造条目并用它的
      // bucketId 创建 Provider，Hold 发布成功后才写入目录。
      entry = getCatalog().createBucketEntry({
        label: input.label.trim(),
        backend: config.kind === "local" ? "local" : "s3",
        keyDerivation,
        encryptedConfig: toContractStorageRecord(document.storage),
        configRevision: 1
      });
      provider = input.createProvider(config, entry.bucketId);
      const committed = await createStorageHoldSnapshotRepository(provider).publish({
        document,
        configRevision: entry.configRevision,
        bucketGeneration: input.bucketGeneration ?? 1,
        expectedHead: { kind: "absent" }
      });
      return await getCatalog().commitBucket({ ...entry, snapshotRevision: committed.header.snapshotRevision });
    } catch (error) {
      // 失败时目录中从未出现 entry，因此不能调用“按目录状态推断未绑定”
      // 的补偿删除；其他标签页的 Coordinator 绑定不会被误删。
      throw error;
    } finally {
      provider?.dispose();
      password = "";
    }
  }

  /**
   * 桶级改密：同时重加密连接配置、全部 Key 记录并重算整文档 HMAC。
   *
   * 远端先发布新快照，目录再 CAS 更新；目录更新失败时仅在提交头仍是
   * 本次发布结果的情况下发布旧文档回滚。回滚本身也通过提交头 CAS，不能
   * 无条件覆盖别的标签页已经发布的新版本。
   */
  async function changeBucketPassword(input: {
    entry: StorageBucketCatalogEntryV2;
    provider: StorageBucketProvider;
    oldPassword: string;
    newPassword: string;
    bucketGeneration?: number;
    /** Worker 改密时由调用方负责把目录更新提交回页面。 */
    persistCatalog?: boolean;
  }): Promise<StorageBucketCatalogEntryV2> {
    let oldPassword = input.oldPassword;
    let newPassword = input.newPassword;
    const repository = createStorageHoldSnapshotRepository(input.provider);
    const plainKeys: Array<{ label: string; privateKey: Uint8Array }> = [];
    try {
      const committed = await repository.readCommitted();
      if (committed.header.configRevision !== input.entry.configRevision) {
        throw new Error("Storage bucket configuration changed; reload and retry");
      }
      // `publish` 会先用 SDK 的 canonical JSON 规范化文档；因此记录字段
      // 的对象顺序可能变化，但其密文语义必须逐字段完全一致。
      if (!sameStorageRecord(committed.storage, input.entry.encryptedConfig)) {
        throw new Error("Storage bucket configuration snapshot does not match the local catalog");
      }
      const oldContext = await deriveBucketCryptoContext(oldPassword, input.entry.keyDerivation);
      let config: StorageBucketConnectionConfigV1;
      try {
        await verifyBucketDocument(committed.document, oldContext);
        config = await decryptBucketConfig(input.entry.encryptedConfig, oldContext);
        for (const key of committed.document.keys) {
          const plain = await decryptBucketKey(key, oldContext);
          plainKeys.push({ label: plain.label, privateKey: plain.privateKey });
        }
      } finally {
        oldContext.dispose();
      }

      const newContext = await createBucketCryptoContext(newPassword);
      let encryptedConfig: StorageRecordV1;
      let document: HoldDocument;
      try {
        encryptedConfig = await encryptBucketConfig(config, newContext);
        const keys: KeyRecord[] = [];
        for (const key of plainKeys) keys.push(await encryptBucketKey(key, newContext));
        document = await sealBucketDocument(encryptedConfig, keys, newContext);
      } finally {
        newContext.dispose();
      }

      const nextConfigRevision = input.entry.configRevision + 1;
      const published = await repository.publish({
        document,
        configRevision: nextConfigRevision,
        bucketGeneration: input.bucketGeneration ?? 1,
        expectedHead: expectedHead({ etag: committed.headEtag })
      });
      try {
        const nextEntry: StorageBucketCatalogEntryV2 = {
          ...input.entry,
          configRevision: nextConfigRevision,
          keyDerivation: { ...document.keyDerivation },
          encryptedConfig,
          snapshotRevision: published.header.snapshotRevision
        };
        if (input.persistCatalog === false) return nextEntry;
        return await getCatalog().updateBucket(input.entry.bucketId, {
          configRevision: nextConfigRevision,
          keyDerivation: { ...document.keyDerivation },
          encryptedConfig,
          snapshotRevision: published.header.snapshotRevision
        }, input.entry);
      } catch (error) {
        if (published.headEtag) {
          try {
            await repository.publish({
              document: committed.document,
              configRevision: committed.header.configRevision,
              bucketGeneration: input.bucketGeneration ?? 1,
              expectedHead: { kind: "etag", etag: published.headEtag }
            });
          } catch (rollbackError) {
            throw new Error(`Bucket password rotation could not update the local catalog and rollback was not confirmed: ${rollbackError instanceof Error ? rollbackError.message : "unknown rollback error"}`);
          }
        }
        throw error;
      }
    } finally {
      oldPassword = "";
      newPassword = "";
      for (const key of plainKeys) wipe(key.privateKey);
      plainKeys.length = 0;
    }
  }

  /** 冷导出：固定读取已提交快照，只做结构序列化，不使用密码。 */
  async function coldExport(provider: StorageBucketProvider): Promise<Uint8Array> {
    const committed = await createStorageHoldSnapshotRepository(provider).readCommitted();
    return new TextEncoder().encode(serializeBucketDocument(committed.document));
  }

  /** 冷导入只解析结构；返回的文档仍标记为未通过密码认证。 */
  function coldImport(input: string | Uint8Array): { document: HoldDocument; passwordAuthenticated: false } {
    return { document: parseBucketDocument(input), passwordAuthenticated: false };
  }

  /** 实际启用前的密码认证；成功后才允许解密配置和 Keys。 */
  async function authenticateDocument(document: HoldDocument, password: string): Promise<StorageBucketConnectionConfigV1> {
    const context = await deriveBucketCryptoContext(password, document.keyDerivation);
    try {
      await verifyBucketDocument(document, context);
      return await decryptBucketConfig({ cipher: { ...document.storage.cipher } }, context);
    } finally {
      context.dispose();
    }
  }

  /**
   * 销毁一个非当前桶的全部 Provider 数据，并随后移除本机连接项。
   *
   * 连接移除是另一条普通管理操作：它只删目录条目、保留远端/Local
   * 数据。这里的删除则明确执行物理对象清理；当前桶在整个过程中都拒绝
   * 操作，避免把正在使用的 Root/Key 会话变成半空状态。按第一页反复列举
   * 是为了兼容 Local Provider 的索引游标——删除当前页后不能继续使用旧
   * 数字游标，否则会跳过对象。
   */
  async function destroyBucketData(input: {
    entry: StorageBucketCatalogEntryV2;
    provider: StorageBucketProvider;
    signal?: AbortSignal;
  }): Promise<{ deletedObjects: number; scope: "all-local-objects" | "current-s3-objects" }> {
    if (input.provider.bucketId !== input.entry.bucketId || input.provider.provider !== input.entry.backend) {
      throw new StorageRuntimeError("storage_provider_error", "The storage provider does not match the bucket catalog entry");
    }

    // 目录锁覆盖整个销毁事务，阻止另一个标签页在“检查非当前桶”和
    // “逐对象删除”之间把目标桶切成当前桶。Provider 数据锁仍由各 Provider
    // 自己管理；两把锁不同名，不会形成嵌套同名等待。
    return getCatalog().withCatalogLock(async () => {
      const catalog = getCatalog().read();
      const latestEntry = catalog.buckets.find((bucket) => bucket.bucketId === input.entry.bucketId);
      if (!latestEntry) {
        throw new StorageRuntimeError("storage_not_found", "Storage bucket was not found");
      }
      // 任何 Provider 删除前都必须确认调用方看到的完整目录版本仍然
      // 有效。尤其是 S3 Endpoint/Bucket/Prefix 并发修改时，不能用旧连接
      // 配置先删除物理数据，再在最后一步才发现 CAS 冲突。
      if (!sameStorageCatalogEntry(latestEntry, input.entry)) {
        throw new StorageRuntimeError("storage_conflict", "Storage bucket changed concurrently; reload and retry");
      }
      const current = catalog.selectedBucketId;
      if (current === input.entry.bucketId) {
        throw new StorageRuntimeError("storage_forbidden", "The bucket became current during destruction; no more data was removed");
      }
      let deletedObjects = 0;
      while (true) {
        if (input.signal?.aborted) throw new StorageRuntimeError("storage_unavailable", "Storage bucket destruction was cancelled");
        if (getCatalog().read().selectedBucketId === input.entry.bucketId) {
          throw new StorageRuntimeError("storage_forbidden", "The bucket became current during destruction; no more data was removed");
        }
        const page = await input.provider.list({ limit: 100, signal: input.signal });
        if (page.objects.length === 0) break;
        for (const object of page.objects) {
          if (input.signal?.aborted) throw new StorageRuntimeError("storage_unavailable", "Storage bucket destruction was cancelled");
          if (getCatalog().read().selectedBucketId === input.entry.bucketId) {
            throw new StorageRuntimeError("storage_forbidden", "The bucket became current during destruction; no more data was removed");
          }
          await input.provider.delete(object.path, {
            ...(object.etag ? { ifMatch: object.etag } : {}),
            ...(input.signal ? { signal: input.signal } : {})
          });
          deletedObjects += 1;
        }
      }

      try {
        const catalog = getCatalog().read();
        getCatalog().write(removeStorageCatalogEntry(catalog, input.entry.bucketId, input.entry));
      } catch (error) {
        throw new Error(`Bucket data was destroyed, but its local connection could not be removed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
      return {
        deletedObjects,
        scope: input.entry.backend === "s3" ? "current-s3-objects" : "all-local-objects"
      };
    });
  }

  return {
    get catalog() { return getCatalog(); },
    prepareBucketConfig,
    unlockBucketConfig,
    decryptKeyForOperation,
    sealConfigAndKeys,
    publishSealedSnapshot,
    initializeBucketSnapshot,
    importBucketDocument,
    changeBucketConnectionConfig,
    changeBucketPassword,
    coldExport,
    coldImport,
    authenticateDocument,
    destroyBucketData
  };
}
