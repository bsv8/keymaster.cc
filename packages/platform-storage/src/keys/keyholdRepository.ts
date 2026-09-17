// 桶内 `keys/<公钥>.keyhold` 的仓储。
//
// 这里严格采用“一把 Key 一个文件”：目录列表是 Key 列表，文件内容是
// KeyHold v1 文档。Key 密码只用于该文件，不能拿 device-bootstrap 的引导
// 密码代替；导入和导出只复制原始 bytes，不要求密码，也不重新加密。

import type {
  KeyHoldDocumentV1,
  StorageBucketProvider,
} from "@keymaster/contracts";
import { KEYHOLD_LIMITS } from "@keymaster/contracts";
import { StorageRuntimeError } from "../runtime/storageError.js";
import {
  createKeyHoldDocument,
  decryptKeyHoldDocument,
  parseKeyHoldDocument,
  serializeKeyHoldDocument,
} from "./keyholdDocument.js";

/** KeyHold 文件所在的桶内目录。 */
export const KEYHOLD_KEYS_PREFIX = "keys/";
/** KeyHold 文件名后缀。 */
export const KEYHOLD_FILE_EXTENSION = ".keyhold";
/** 单次目录页大小；实际 Provider 仍可返回更小页。 */
export const KEYHOLD_LIST_LIMIT = 256;

export interface KeyHoldFileSummary {
  /** UI 显示名称。 */
  label: string;
  /** 小写压缩公钥 hex。 */
  publicKeyHex: string;
  /** 桶内文件路径。 */
  path: string;
  /** Provider 返回的版本标签。 */
  etag?: string;
}

export interface KeyHoldFile {
  /** 已严格校验的 KeyHold 文档。 */
  document: KeyHoldDocumentV1;
  /** 文件原始 bytes；导出时必须原样返回。 */
  bytes: Uint8Array;
  /** Provider 返回的版本标签。 */
  etag?: string;
}

export interface KeyHoldInvalidFile {
  /** 无法作为合法 KeyHold 文件处理的桶内路径。 */
  path: string;
  /** 脱敏的本地诊断文本。 */
  reason: string;
}

export interface KeyHoldListResult {
  /** 可解析文件的公开列表。 */
  keys: KeyHoldFileSummary[];
  /** 被跳过的损坏/不兼容文件；不影响其它 Key。 */
  invalidFiles: KeyHoldInvalidFile[];
}

export interface UnlockedKeyHold {
  /** 解锁后的公开文档。 */
  document: KeyHoldDocumentV1;
  /** 32 字节私钥；调用方使用后必须清零。 */
  privateKeyBytes: Uint8Array;
  /** 解锁时读取到的版本标签；改密/条件写使用它防止覆盖并发更新。 */
  etag?: string;
}

export interface KeyHoldRepository {
  /** 列出可解析 Key；单个损坏文件只进入 invalidFiles。 */
  list(): Promise<KeyHoldListResult>;
  /** 读取全部可解析 Key 的完整文件（含密文），供保险箱适配层使用。 */
  readAll(): Promise<KeyHoldFile[]>;
  /** 读取指定公钥对应的原始 KeyHold 文件；不存在返回 undefined。 */
  read(publicKeyHex: string): Promise<KeyHoldFile | undefined>;
  /** 使用该 Key 自己的密码解锁。 */
  unlock(publicKeyHex: string, password: string): Promise<UnlockedKeyHold>;
  /** 创建一份新的 KeyHold 文件；目标文件已存在时拒绝覆盖。 */
  create(input: { label: string; privateKeyBytes: Uint8Array; password: string; iterations?: number }): Promise<KeyHoldFile>;
  /** 导入一份已经存在的 KeyHold 原始文件；不需要密码、不重新加密。 */
  import(bytes: Uint8Array): Promise<KeyHoldFile>;
  /** 原样导出指定 KeyHold 文件；不需要密码。 */
  export(publicKeyHex: string): Promise<Uint8Array>;
  /** 使用 Key 自己的旧密码验证后改密；新文件仍只覆盖同一条路径。 */
  changePassword(input: { publicKeyHex: string; oldPassword: string; newPassword: string; iterations?: number }): Promise<KeyHoldFile>;
  /** 删除指定 Key 文件；调用方应先用 Key 密码完成业务认证。 */
  delete(publicKeyHex: string, ifMatch?: string): Promise<void>;
}

function keysError(
  message: string,
  code: "storage_remote_corrupt" | "storage_not_found" | "storage_identity_required" | "storage_provider_error" | "storage_limit_exceeded" | "storage_conflict" = "storage_remote_corrupt",
): StorageRuntimeError {
  return new StorageRuntimeError(code, message);
}

function normalizePublicKeyHex(value: string): string {
  if (typeof value !== "string" || !/^(02|03)[0-9a-f]{64}$/u.test(value)) {
    throw keysError("Key publicKeyHex must be lowercase compressed secp256k1 hex", "storage_identity_required");
  }
  return value;
}

function pathForPublicKey(publicKeyHex: string): string {
  return `${KEYHOLD_KEYS_PREFIX}${normalizePublicKeyHex(publicKeyHex)}${KEYHOLD_FILE_EXTENSION}`;
}

function publicKeyFromPath(path: string): string | undefined {
  if (!path.startsWith(KEYHOLD_KEYS_PREFIX) || !path.endsWith(KEYHOLD_FILE_EXTENSION)) return undefined;
  const publicKeyHex = path.slice(KEYHOLD_KEYS_PREFIX.length, -KEYHOLD_FILE_EXTENSION.length);
  return /^(02|03)[0-9a-f]{64}$/u.test(publicKeyHex) ? publicKeyHex : undefined;
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function parseFile(path: string, bytes: Uint8Array, etag?: string): KeyHoldFile {
  if (bytes.byteLength > KEYHOLD_LIMITS.maxSerializedBytes) throw keysError("KeyHold file exceeds its size limit", "storage_limit_exceeded");
  const expectedPublicKeyHex = publicKeyFromPath(path);
  if (!expectedPublicKeyHex) throw keysError("KeyHold file name is invalid");
  let document: KeyHoldDocumentV1;
  try {
    document = parseKeyHoldDocument(bytes);
  } catch {
    throw keysError("KeyHold file is invalid or incompatible");
  }
  if (document.publicKeyHex !== expectedPublicKeyHex) throw keysError("KeyHold publicKeyHex does not match its file name");
  return { document, bytes: cloneBytes(bytes), ...(etag === undefined ? {} : { etag }) };
}

async function getObject(provider: Pick<StorageBucketProvider, "get">, path: string): Promise<KeyHoldFile | undefined> {
  const object = await provider.get(path);
  return object ? parseFile(path, object.bytes, object.etag) : undefined;
}

/** 创建绑定当前桶 Provider 的 KeyHold 文件仓储。 */
export function createKeyHoldRepository(provider: Pick<StorageBucketProvider, "get" | "list" | "put" | "delete">): KeyHoldRepository {
  async function read(publicKeyHex: string): Promise<KeyHoldFile | undefined> {
    try {
      return await getObject(provider, pathForPublicKey(publicKeyHex));
    } catch (caught) {
      if (caught instanceof StorageRuntimeError) throw caught;
      throw keysError("KeyHold file could not be read", "storage_provider_error");
    }
  }

  async function list(): Promise<KeyHoldListResult> {
    const keys: KeyHoldFileSummary[] = [];
    const invalidFiles: KeyHoldInvalidFile[] = [];
    let cursor: string | undefined;
    do {
      let page;
      try {
        page = await provider.list({ prefix: KEYHOLD_KEYS_PREFIX, cursor, limit: KEYHOLD_LIST_LIMIT });
      } catch (caught) {
        if (caught instanceof StorageRuntimeError) throw caught;
        throw keysError("KeyHold directory could not be listed", "storage_provider_error");
      }
      for (const object of page.objects) {
        const path = object.path;
        if (!publicKeyFromPath(path)) {
          invalidFiles.push({ path, reason: "文件名不是小写公钥加 .keyhold" });
          continue;
        }
        try {
          const file = await getObject(provider, path);
          if (!file) {
            invalidFiles.push({ path, reason: "文件在列目录后消失" });
            continue;
          }
          keys.push({ label: file.document.label, publicKeyHex: file.document.publicKeyHex, path, ...(file.etag === undefined ? {} : { etag: file.etag }) });
        } catch (caught) {
          // 单个文件损坏/不兼容只跳过；Provider 的网络/权限错误必须中止整个目录读取。
          if (caught instanceof StorageRuntimeError && (caught.code === "storage_remote_corrupt" || caught.code === "storage_limit_exceeded")) {
            invalidFiles.push({ path, reason: caught.message });
            continue;
          }
          throw caught;
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
    keys.sort((left, right) => left.publicKeyHex.localeCompare(right.publicKeyHex));
    invalidFiles.sort((left, right) => left.path.localeCompare(right.path));
    return { keys, invalidFiles };
  }

  async function readAll(): Promise<KeyHoldFile[]> {
    const listed = await list();
    const files: KeyHoldFile[] = [];
    for (const summary of listed.keys) {
      const file = await read(summary.publicKeyHex);
      if (file) files.push(file);
    }
    return files;
  }

  async function unlock(publicKeyHex: string, password: string): Promise<UnlockedKeyHold> {
    const file = await read(publicKeyHex);
    if (!file) throw keysError("KeyHold file does not exist", "storage_not_found");
    try {
      const plain = await decryptKeyHoldDocument(file.document, password);
      return {
        document: file.document,
        privateKeyBytes: plain.privateKey,
        ...(file.etag === undefined ? {} : { etag: file.etag }),
      };
    } catch {
      throw keysError("KeyHold password or authentication is invalid", "storage_identity_required");
    }
  }

  async function create(input: { label: string; privateKeyBytes: Uint8Array; password: string; iterations?: number }): Promise<KeyHoldFile> {
    let document: KeyHoldDocumentV1 | undefined;
    try {
      document = await createKeyHoldDocument({ label: input.label, privateKey: input.privateKeyBytes }, input.password, input.iterations === undefined ? undefined : { iterations: input.iterations });
      const serialized = serializeKeyHoldDocument(document);
      const bytes = new TextEncoder().encode(serialized);
      const path = pathForPublicKey(document.publicKeyHex);
      try {
        const written = await provider.put(path, bytes, { ifNoneMatch: "*" });
        return { document, bytes: cloneBytes(bytes), ...(written.etag === undefined ? {} : { etag: written.etag }) };
      } catch (caught) {
        if (caught instanceof StorageRuntimeError) throw caught;
        throw keysError("KeyHold file could not be written", "storage_provider_error");
      }
    } catch (caught) {
      if (caught instanceof StorageRuntimeError) throw caught;
      throw keysError("KeyHold file could not be created", "storage_remote_corrupt");
    }
  }

  async function importFile(bytes: Uint8Array): Promise<KeyHoldFile> {
    if (!(bytes instanceof Uint8Array)) throw keysError("KeyHold import must be bytes", "storage_remote_corrupt");
    // 先检查原始文件大小：解析后的 JSON 可能很小，但导入 bytes 仍可能被
    // 大量空白填充；冷导入也不能绕过单文件资源上限。
    if (bytes.byteLength > KEYHOLD_LIMITS.maxSerializedBytes) {
      throw keysError("KeyHold import exceeds its size limit", "storage_limit_exceeded");
    }
    let document: KeyHoldDocumentV1;
    try { document = parseKeyHoldDocument(bytes); }
    catch { throw keysError("KeyHold import is invalid", "storage_remote_corrupt"); }
    const path = pathForPublicKey(document.publicKeyHex);
    try {
      const written = await provider.put(path, bytes.slice(), { ifNoneMatch: "*" });
      return { document, bytes: cloneBytes(bytes), ...(written.etag === undefined ? {} : { etag: written.etag }) };
    } catch (caught) {
      if (caught instanceof StorageRuntimeError) throw caught;
      throw keysError("KeyHold import could not be written", "storage_provider_error");
    }
  }

  async function exportFile(publicKeyHex: string): Promise<Uint8Array> {
    const file = await read(publicKeyHex);
    if (!file) throw keysError("KeyHold file does not exist", "storage_not_found");
    return cloneBytes(file.bytes);
  }

  async function changePassword(input: { publicKeyHex: string; oldPassword: string; newPassword: string; iterations?: number }): Promise<KeyHoldFile> {
    const old = await unlock(input.publicKeyHex, input.oldPassword);
    try {
      const oldPath = pathForPublicKey(input.publicKeyHex);
      // 改密是同一文件的整文件替换，不能调用 create()：create() 使用
      // If-None-Match，只允许新建，会与当前文件必然冲突。
      const nextDocument = await createKeyHoldDocument(
        { label: old.document.label, privateKey: old.privateKeyBytes },
        input.newPassword,
        input.iterations === undefined ? undefined : { iterations: input.iterations },
      );
      const nextBytes = new TextEncoder().encode(serializeKeyHoldDocument(nextDocument));
      if (nextDocument.publicKeyHex !== input.publicKeyHex) throw keysError("KeyHold public key changed", "storage_remote_corrupt");
      try {
        const written = await provider.put(oldPath, nextBytes, old.etag === undefined ? {} : { ifMatch: old.etag });
        return { document: nextDocument, bytes: cloneBytes(nextBytes), ...(written.etag === undefined ? {} : { etag: written.etag }) };
      } catch (caught) {
        if (caught instanceof StorageRuntimeError) throw caught;
        throw keysError("KeyHold password change could not be written", "storage_provider_error");
      }
    } finally {
      old.privateKeyBytes.fill(0);
    }
  }

  async function remove(publicKeyHex: string, ifMatch?: string): Promise<void> {
    try {
      await provider.delete(pathForPublicKey(publicKeyHex), ifMatch === undefined ? {} : { ifMatch });
    } catch (caught) {
      if (caught instanceof StorageRuntimeError) throw caught;
      throw keysError("KeyHold file could not be deleted", "storage_provider_error");
    }
  }

  return { list, readAll, read, unlock, create, import: importFile, export: exportFile, changePassword, delete: remove };
}
