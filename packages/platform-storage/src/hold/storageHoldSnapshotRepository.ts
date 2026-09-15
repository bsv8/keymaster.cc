// 桶内版本化 Hold 快照。
//
// 写入顺序是“不可变对象 → 提交头 CAS”：任何中途失败都不会改变旧提交头；
// 导出固定读取一个已经发布的快照，不会把并发更新中的 storage 与 keys 拼接。

import type {
  StorageHoldHeadExpectation,
  StorageBucketReadOnlyProvider,
  StorageBucketProvider,
  StorageHoldCommitHeadV1,
  StorageHoldSnapshotHeaderV1,
  StorageRecordV1
} from "@keymaster/contracts";
import type { HoldDocument } from "keymaster-hold/browser";
import { StorageRuntimeError } from "../runtime/storageError.js";
import {
  integrityFromDocument,
  parseBucketDocument,
  serializeBucketDocument,
  toContractDerivation,
  toContractStorageRecord
} from "./keymasterHoldAdapter.js";
import type { KeyRecord as HoldKeyRecord, StorageRecord as HoldStorageRecord } from "keymaster-hold/browser";

const HOLD_ROOT = ".keymaster/hold/v1";
export const STORAGE_HOLD_HEAD_PATH = `${HOLD_ROOT}/head.json`;

export interface StorageHoldSnapshotWriteInput {
  /** 已由 SDK sealDocument 生成的完整认证文档。 */
  document: HoldDocument;
  /** 桶配置版本。 */
  configRevision: number;
  /** 当前桶世代。 */
  bucketGeneration: number;
  /** 可注入时间。 */
  now?: number;
  /** 可注入快照 ID。 */
  snapshotId?: string;
  /** 提交头 CAS；首次发布必须明确要求 Head 不存在。 */
  expectedHead: StorageHoldHeadExpectation;
}

export interface StorageHoldCommittedSnapshot {
  /** 已发布的快照头。 */
  header: StorageHoldSnapshotHeaderV1;
  /** 提交头绑定的桶会话世代；防止旧桶数据被当前根误读。 */
  bucketGeneration: number;
  /** 原始 SDK storage 记录。 */
  storage: StorageRecordV1;
  /** 原始 SDK KeyRecord，保持顺序。 */
  keys: HoldKeyRecord[];
  /** 可直接交给 SDK serializeDocument 的文档。 */
  document: HoldDocument;
  /** 提交头 ETag；下一次发布可用来 CAS。 */
  headEtag?: string;
}

function snapshotError(message: string, code: "storage_provider_error" | "storage_not_found" | "storage_conflict" = "storage_provider_error"): StorageRuntimeError {
  return new StorageRuntimeError(code, message);
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function parseJson<T>(bytes: Uint8Array, message: string): T {
  try { return JSON.parse(new TextDecoder().decode(bytes)) as T; }
  catch { throw snapshotError(message); }
}

function snapshotPath(snapshotId: string, leaf: "header.json" | "storage.json" | "keys.json"): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(snapshotId)) throw snapshotError("Storage snapshot ID is invalid");
  return `${HOLD_ROOT}/snapshots/${snapshotId}/${leaf}`;
}

function validateHead(value: unknown): StorageHoldCommitHeadV1 {
  if (!value || typeof value !== "object") throw snapshotError("Storage Hold commit head is invalid");
  const head = value as Partial<StorageHoldCommitHeadV1>;
  if (head.format !== "keymaster.storage-hold-commit" || head.version !== 1 || typeof head.snapshotId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(head.snapshotId) || typeof head.snapshotRevision !== "number" || !Number.isSafeInteger(head.snapshotRevision) || head.snapshotRevision < 1 || typeof head.configRevision !== "number" || !Number.isSafeInteger(head.configRevision) || head.configRevision < 0 || typeof head.bucketGeneration !== "number" || !Number.isSafeInteger(head.bucketGeneration) || head.bucketGeneration < 1 || typeof head.committedAt !== "number" || !Number.isSafeInteger(head.committedAt)) throw snapshotError("Storage Hold commit head is invalid");
  return { ...head } as StorageHoldCommitHeadV1;
}

function validateHeader(value: unknown): StorageHoldSnapshotHeaderV1 {
  if (!value || typeof value !== "object") throw snapshotError("Storage Hold snapshot header is invalid");
  const header = value as Partial<StorageHoldSnapshotHeaderV1>;
  if (header.format !== "keymaster.storage-hold-snapshot" || header.version !== 1 || typeof header.snapshotId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(header.snapshotId) || typeof header.snapshotRevision !== "number" || !Number.isSafeInteger(header.snapshotRevision) || header.snapshotRevision < 1 || typeof header.configRevision !== "number" || !Number.isSafeInteger(header.configRevision) || header.configRevision < 0 || typeof header.storagePath !== "string" || typeof header.keysPath !== "string" || typeof header.keyCount !== "number" || !Number.isSafeInteger(header.keyCount) || header.keyCount < 0 || !Array.isArray(header.keyPublicKeys) || !header.keyPublicKeys.every((key) => typeof key === "string") || new Set(header.keyPublicKeys).size !== header.keyPublicKeys.length || typeof header.createdAt !== "number" || !Number.isSafeInteger(header.createdAt) || !header.keyDerivation || !header.integrity) throw snapshotError("Storage Hold snapshot header is invalid");
  return {
    ...header,
    keyDerivation: { ...header.keyDerivation },
    integrity: { ...header.integrity },
    keyPublicKeys: [...header.keyPublicKeys]
  } as StorageHoldSnapshotHeaderV1;
}

async function readJson<T>(provider: Pick<StorageBucketProvider, "get">, path: string, missingMessage: string): Promise<{ value: T; etag?: string }> {
  const object = await provider.get(path);
  if (!object) throw snapshotError(missingMessage, "storage_not_found");
  return { value: parseJson<T>(object.bytes, missingMessage), etag: object.etag };
}

/**
 * 只读 Hold 读取器。连接已有远端时，生命周期必须在类型和运行时上都
 * 无法取得 put/delete；写入型快照 Repository 不能作为该阶段的依赖。
 */
export function createStorageHoldSnapshotReadOnlyRepository(provider: StorageBucketReadOnlyProvider) {
  async function readHead(): Promise<{ value?: StorageHoldCommitHeadV1; etag?: string }> {
    const object = await provider.get(STORAGE_HOLD_HEAD_PATH);
    if (!object) return {};
    return { value: validateHead(parseJson(object.bytes, "Storage Hold commit head is invalid")), etag: object.etag };
  }

  async function readSnapshot(head: StorageHoldCommitHeadV1, headEtag?: string): Promise<StorageHoldCommittedSnapshot> {
    const headerResult = await readJson(provider, snapshotPath(head.snapshotId, "header.json"), "Storage Hold snapshot header is missing");
    const header = validateHeader(headerResult.value);
    if (header.snapshotId !== head.snapshotId || header.snapshotRevision !== head.snapshotRevision || header.configRevision !== head.configRevision || header.storagePath !== snapshotPath(head.snapshotId, "storage.json") || header.keysPath !== snapshotPath(head.snapshotId, "keys.json")) throw snapshotError("Storage Hold snapshot head does not match its records");
    const storageResult = await readJson<HoldStorageRecord>(provider, header.storagePath, "Storage Hold storage record is missing");
    const keysResult = await readJson<HoldKeyRecord[]>(provider, header.keysPath, "Storage Hold key records are missing");
    if (!Array.isArray(keysResult.value) || keysResult.value.length !== header.keyCount) throw snapshotError("Storage Hold key records are incomplete");
    const document = parseBucketDocument(JSON.stringify({ format: "keymaster-hold", version: 1, keyDerivation: header.keyDerivation, storage: storageResult.value, keys: keysResult.value, integrity: header.integrity }));
    const publicKeys = document.keys.map((key) => key.publicKeyHex);
    if (JSON.stringify(publicKeys) !== JSON.stringify(header.keyPublicKeys)) throw snapshotError("Storage Hold key order does not match the snapshot header");
    return {
      header,
      bucketGeneration: head.bucketGeneration,
      storage: toContractStorageRecord(document.storage),
      keys: document.keys,
      document,
      ...(headEtag ? { headEtag } : {})
    };
  }

  return {
    readHead,
    async readCommitted(): Promise<StorageHoldCommittedSnapshot> {
      const head = await readHead();
      if (!head.value) throw snapshotError("Storage Hold committed snapshot is missing", "storage_not_found");
      return readSnapshot(head.value, head.etag);
    },
  };
}

/** 在一个已经绑定的桶 Provider 上维护 Hold 配置快照。 */
export function createStorageHoldSnapshotRepository(provider: StorageBucketProvider, options: { now?: () => number; generateId?: () => string } = {}) {
  const now = options.now ?? (() => Date.now());
  const generateId = options.generateId ?? (() => crypto.randomUUID());

  async function readHead(): Promise<{ value?: StorageHoldCommitHeadV1; etag?: string }> {
    const object = await provider.get(STORAGE_HOLD_HEAD_PATH);
    if (!object) return {};
    return { value: validateHead(parseJson(object.bytes, "Storage Hold commit head is invalid")), etag: object.etag };
  }

  async function readSnapshot(head: StorageHoldCommitHeadV1, headEtag?: string): Promise<StorageHoldCommittedSnapshot> {
    const headerResult = await readJson<StorageHoldSnapshotHeaderV1>(provider, snapshotPath(head.snapshotId, "header.json"), "Storage Hold snapshot header is missing");
    const header = validateHeader(headerResult.value);
    if (header.snapshotId !== head.snapshotId || header.snapshotRevision !== head.snapshotRevision || header.configRevision !== head.configRevision || header.storagePath !== snapshotPath(head.snapshotId, "storage.json") || header.keysPath !== snapshotPath(head.snapshotId, "keys.json")) throw snapshotError("Storage Hold snapshot head does not match its records");
    const storageResult = await readJson<HoldStorageRecord>(provider, header.storagePath, "Storage Hold storage record is missing");
    const keysResult = await readJson<HoldKeyRecord[]>(provider, header.keysPath, "Storage Hold key records are missing");
    if (!Array.isArray(keysResult.value) || keysResult.value.length !== header.keyCount) throw snapshotError("Storage Hold key records are incomplete");
    const document = parseBucketDocument(JSON.stringify({ format: "keymaster-hold", version: 1, keyDerivation: header.keyDerivation, storage: storageResult.value, keys: keysResult.value, integrity: header.integrity }));
    const publicKeys = document.keys.map((key) => key.publicKeyHex);
    if (JSON.stringify(publicKeys) !== JSON.stringify(header.keyPublicKeys)) throw snapshotError("Storage Hold key order does not match the snapshot header");
    return {
      header,
      bucketGeneration: head.bucketGeneration,
      storage: toContractStorageRecord(document.storage),
      keys: document.keys,
      document,
      ...(headEtag ? { headEtag } : {})
    };
  }

  async function readCommitted(): Promise<StorageHoldCommittedSnapshot> {
    const head = await readHead();
    if (!head.value) throw snapshotError("Storage Hold committed snapshot is missing", "storage_not_found");
    return readSnapshot(head.value, head.etag);
  }

  async function publish(input: StorageHoldSnapshotWriteInput): Promise<StorageHoldCommittedSnapshot> {
    const document = parseBucketDocument(serializeBucketDocument(input.document));
    const previous = await readHead();
    if (input.expectedHead.kind === "etag" && previous.etag !== input.expectedHead.etag) {
      throw snapshotError("Storage Hold commit head changed; retry from the latest snapshot", "storage_conflict");
    }
    if (input.expectedHead.kind === "absent" && previous.value !== undefined) {
      throw snapshotError("Storage Hold commit head changed; retry from the latest snapshot", "storage_conflict");
    }
    const snapshotId = input.snapshotId ?? generateId();
    const storagePath = snapshotPath(snapshotId, "storage.json");
    const keysPath = snapshotPath(snapshotId, "keys.json");
    const snapshotRevision = (previous.value?.snapshotRevision ?? 0) + 1;
    const header: StorageHoldSnapshotHeaderV1 = {
      format: "keymaster.storage-hold-snapshot",
      version: 1,
      snapshotId,
      snapshotRevision,
      configRevision: input.configRevision,
      keyDerivation: toContractDerivation(document.keyDerivation),
      integrity: integrityFromDocument(document),
      storagePath,
      keysPath,
      keyCount: document.keys.length,
      keyPublicKeys: document.keys.map((key) => key.publicKeyHex),
      createdAt: input.now ?? now()
    };
    // 先写 immutable records；它们的路径含随机 snapshotId，不会覆盖旧版本。
    await provider.put(storagePath, jsonBytes(document.storage), { ifNoneMatch: "*" });
    await provider.put(keysPath, jsonBytes(document.keys), { ifNoneMatch: "*" });
    await provider.put(snapshotPath(snapshotId, "header.json"), jsonBytes(header), { ifNoneMatch: "*" });
    const head: StorageHoldCommitHeadV1 = {
      format: "keymaster.storage-hold-commit",
      version: 1,
      snapshotId,
      snapshotRevision,
      configRevision: input.configRevision,
      bucketGeneration: input.bucketGeneration,
      committedAt: input.now ?? now()
    };
    try {
      const condition = input.expectedHead.kind === "etag"
        ? { ifMatch: input.expectedHead.etag }
        : { ifNoneMatch: "*" as const };
      const written = await provider.put(STORAGE_HOLD_HEAD_PATH, jsonBytes(head), condition);
      // 提交头写入已经返回了本次发布的 ETag；这里直接用内存中的已规范化
      // 文档组装结果，不能再通过 readHead/readSnapshot 追加一次网络读取。
      // 这样“发布成功但紧接着读取 ETag 失败”不会把已发布结果误判为未发布。
      return {
        header,
        bucketGeneration: head.bucketGeneration,
        storage: toContractStorageRecord(document.storage),
        keys: document.keys,
        document,
        ...(written.etag === undefined ? {} : { headEtag: written.etag }),
      };
    } catch (caught) {
      if (caught instanceof StorageRuntimeError && caught.code === "storage_conflict") throw snapshotError("Storage Hold snapshot publish conflicted; retry from the latest snapshot", "storage_conflict");
      throw caught;
    }
  }

  return { readHead, readCommitted, publish, serialize: (snapshot: StorageHoldCommittedSnapshot) => serializeBucketDocument(snapshot.document) };
}
