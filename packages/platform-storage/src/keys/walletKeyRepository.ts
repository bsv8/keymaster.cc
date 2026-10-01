// 唯一钱包 Key 的仓储。
//
// 与旧「公钥派生文件名」的列表仓储相比只有两处差别,而且都是结构性的:
//   - 路径固定为 key.json,不再由公钥派生文件名,因此取消「文件名与公钥一致」
//     的要求;
//   - 没有 list/readAll/delete:一个钱包只有一把 Key,多 Key、切换和逐 Key
//     删除在产品上已不存在。更换身份只能通过重置钱包后重新创建或导入。
//
// KeyHold 的格式与密码学实现完全沿用 keyhold SDK,这里只负责把固定路径的读写
// 接到新钱包引擎上,并在解码后校验公钥与私钥一致。

import type { KeyHoldDocumentV1, StorageErrorCode } from "@keymaster/contracts";
import { KEYHOLD_LIMITS, WALLET_KEYHOLD_PATH } from "@keymaster/contracts";
import { StorageRuntimeError, storageErrorCode } from "../runtime/storageError.js";
import type { WalletStore } from "../local/indexedDbWalletStore.js";
import {
  createKeyHoldDocument,
  decryptKeyHoldDocument,
  parseKeyHoldDocument,
  serializeKeyHoldDocument,
} from "./keyholdDocument.js";

/** 唯一 KeyHold 的固定路径。 */
export const WALLET_KEYHOLD_FILE_PATH = WALLET_KEYHOLD_PATH;

export interface WalletKeyFile {
  /** 已严格校验的 KeyHold 文档。 */
  document: KeyHoldDocumentV1;
  /** 文件原始 bytes;导出时必须原样返回。 */
  bytes: Uint8Array;
  /** 该文件的 revision;改密等条件写依赖它。 */
  revision: number;
}

export interface UnlockedWalletKey {
  document: KeyHoldDocumentV1;
  /** 32 字节私钥;调用方使用后必须清零。 */
  privateKeyBytes: Uint8Array;
  /** 解锁时读取到的 revision。 */
  revision: number;
}

export interface WalletKeyRepository {
  /** 读取唯一 KeyHold;不存在返回 undefined。 */
  read(): Promise<WalletKeyFile | undefined>;
  /** 使用 Key 密码解锁唯一 Key。 */
  unlock(password: string): Promise<UnlockedWalletKey>;
  /**
   * 创建一把新 Key 并条件写入固定路径。
   *
   * 目标已存在时拒绝覆盖:已有 Key 的钱包只能走重置流程。
   */
  create(input: { label: string; privateKeyBytes: Uint8Array; password: string; iterations?: number }): Promise<WalletKeyFile>;
  /** 导入一份已存在的 KeyHold 原始文件;不要求密码,也不重新加密。 */
  import(bytes: Uint8Array): Promise<WalletKeyFile>;
  /** 原样导出唯一 KeyHold;不需要密码。 */
  export(): Promise<Uint8Array>;
  /** 校验旧密码后改密;仍只覆盖固定路径这一条记录。 */
  changePassword(input: { oldPassword: string; newPassword: string; iterations?: number }): Promise<WalletKeyFile>;
  /** 只修改显示名称,不改密、不换私钥。 */
  rename(label: string): Promise<WalletKeyFile>;
}

function fail(code: StorageErrorCode, message: string): StorageRuntimeError {
  return new StorageRuntimeError(code, message);
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function parseFile(bytes: Uint8Array, revision: number): WalletKeyFile {
  if (bytes.byteLength > KEYHOLD_LIMITS.maxSerializedBytes) {
    throw fail("storage_limit_exceeded", "KeyHold file exceeds its size limit");
  }
  let document: KeyHoldDocumentV1;
  try {
    document = parseKeyHoldDocument(bytes);
  } catch {
    throw fail("storage_wallet_corrupt", "KeyHold file is invalid or incompatible");
  }
  // 文件名不再参与身份校验:公钥由文档自身声明,并在解锁时与解出的私钥比对。
  return { document, bytes: cloneBytes(bytes), revision };
}

async function rethrowStorage(caught: unknown, message: string): Promise<never> {
  if (caught instanceof StorageRuntimeError) throw caught;
  const code = storageErrorCode(caught);
  throw fail(code ?? "storage_provider_error", message);
}

/** 创建绑定新钱包引擎的单 Key 仓储。 */
export function createWalletKeyRepository(store: WalletStore): WalletKeyRepository {
  async function read(): Promise<WalletKeyFile | undefined> {
    let record;
    try {
      record = await store.get(WALLET_KEYHOLD_FILE_PATH);
    } catch (caught) {
      return rethrowStorage(caught, "KeyHold file could not be read");
    }
    if (!record) return undefined;
    return parseFile(record.bytes, record.revision);
  }

  async function writeFresh(bytes: Uint8Array, document: KeyHoldDocumentV1): Promise<WalletKeyFile> {
    try {
      // 条件创建与写入在同一事务:并发创建只能有一个成功。
      const written = await store.put(WALLET_KEYHOLD_FILE_PATH, bytes, {
        ifNoneMatch: true,
        contentType: "application/json",
      });
      return { document, bytes: cloneBytes(bytes), revision: written.revision };
    } catch (caught) {
      return rethrowStorage(caught, "KeyHold file could not be written");
    }
  }

  async function unlock(password: string): Promise<UnlockedWalletKey> {
    const file = await read();
    if (!file) throw fail("storage_not_found", "KeyHold file does not exist");
    try {
      const plain = await decryptKeyHoldDocument(file.document, password);
      return { document: file.document, privateKeyBytes: plain.privateKey, revision: file.revision };
    } catch {
      // 密码错误与密文损坏在这里不可区分,统一按认证失败处理。
      throw fail("storage_identity_required", "KeyHold password or authentication is invalid");
    }
  }

  async function create(input: {
    label: string;
    privateKeyBytes: Uint8Array;
    password: string;
    iterations?: number;
  }): Promise<WalletKeyFile> {
    let document: KeyHoldDocumentV1;
    try {
      document = await createKeyHoldDocument(
        { label: input.label, privateKey: input.privateKeyBytes },
        input.password,
        input.iterations === undefined ? undefined : { iterations: input.iterations }
      );
    } catch {
      throw fail("storage_wallet_corrupt", "KeyHold file could not be created");
    }
    return writeFresh(new TextEncoder().encode(serializeKeyHoldDocument(document)), document);
  }

  async function importFile(bytes: Uint8Array): Promise<WalletKeyFile> {
    if (!(bytes instanceof Uint8Array)) throw fail("storage_wallet_corrupt", "KeyHold import must be bytes");
    // 先看原始大小:JSON 解析后可能很小,但导入 bytes 仍可被大量空白填充。
    if (bytes.byteLength > KEYHOLD_LIMITS.maxSerializedBytes) {
      throw fail("storage_limit_exceeded", "KeyHold import exceeds its size limit");
    }
    let document: KeyHoldDocumentV1;
    try {
      document = parseKeyHoldDocument(bytes);
    } catch {
      throw fail("storage_wallet_corrupt", "KeyHold import is invalid");
    }
    return writeFresh(bytes.slice(), document);
  }

  async function exportFile(): Promise<Uint8Array> {
    const file = await read();
    if (!file) throw fail("storage_not_found", "KeyHold file does not exist");
    return cloneBytes(file.bytes);
  }

  /**
   * 改密:先解锁再重新加密,最后以 revision 条件写覆盖同一条记录。
   *
   * 使用 ifRevision 而不是无条件覆盖:并发的改密或重置会让其中一方失败,
   * 不会出现用陈旧密码派生出的文件悄悄覆盖新结果。
   */
  async function changePassword(input: { oldPassword: string; newPassword: string; iterations?: number }): Promise<WalletKeyFile> {
    const unlocked = await unlock(input.oldPassword);
    try {
      const nextDocument = await createKeyHoldDocument(
        { label: unlocked.document.label, privateKey: unlocked.privateKeyBytes },
        input.newPassword,
        input.iterations === undefined ? undefined : { iterations: input.iterations }
      );
      if (nextDocument.publicKeyHex !== unlocked.document.publicKeyHex) {
        throw fail("storage_wallet_corrupt", "KeyHold public key changed");
      }
      const nextBytes = new TextEncoder().encode(serializeKeyHoldDocument(nextDocument));
      try {
        const written = await store.put(WALLET_KEYHOLD_FILE_PATH, nextBytes, {
          ifRevision: unlocked.revision,
          contentType: "application/json",
        });
        return { document: nextDocument, bytes: cloneBytes(nextBytes), revision: written.revision };
      } catch (caught) {
        return rethrowStorage(caught, "KeyHold password change could not be written");
      }
    } finally {
      unlocked.privateKeyBytes.fill(0);
    }
  }

  async function rename(label: string): Promise<WalletKeyFile> {
    const file = await read();
    if (!file) throw fail("storage_not_found", "KeyHold file does not exist");
    const nextDocument: KeyHoldDocumentV1 = { ...file.document, label };
    const nextBytes = new TextEncoder().encode(serializeKeyHoldDocument(nextDocument));
    try {
      // 改名不要求密码,但也不能覆盖别人的并发更新。
      const written = await store.put(WALLET_KEYHOLD_FILE_PATH, nextBytes, {
        ifRevision: file.revision,
        contentType: "application/json",
      });
      return { document: nextDocument, bytes: cloneBytes(nextBytes), revision: written.revision };
    } catch (caught) {
      return rethrowStorage(caught, "KeyHold label could not be written");
    }
  }

  return { read, unlock, create, import: importFile, export: exportFile, changePassword, rename };
}
