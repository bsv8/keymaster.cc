// MSFile 文件 Repository 的内存 OwnerFileStore 测试替身。
//
// 只实现 OwnerFileStore 的路径/字节语义；格式校验、读改写和 publisher
// 枚举都在被测 Repository 内完成。生产代码不引用本文件。

import type { BorrowedOwnerFileStore, OwnerFileObject, OwnerFileListPage } from "@keymaster/contracts";
import type { MsFileRepositoryStores } from "./msfileRepository.js";

/** 测试用 owner 公钥（私钥 1 的压缩公钥）。 */
export const IN_MEMORY_OWNER_PUBKEY = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

export interface InMemoryOwnerFileStore extends BorrowedOwnerFileStore {
  readonly objects: Map<string, Uint8Array>;
}

export function createInMemoryOwnerFileStore(): InMemoryOwnerFileStore {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async list(input = {}): Promise<OwnerFileListPage> {
      const prefix = input.prefix ?? "";
      const files = [...objects.keys()]
        .filter((path) => path.startsWith(prefix))
        .sort()
        .map((path) => ({ path, size: objects.get(path)?.byteLength ?? 0 }));
      return { files };
    },
    async get(path): Promise<OwnerFileObject | undefined> {
      const bytes = objects.get(path);
      return bytes ? { path, bytes: bytes.slice() } : undefined;
    },
    async put(path, bytes) {
      objects.set(path, bytes.slice());
      return {};
    },
    async delete(path) {
      objects.delete(path);
    },
  };
}

export interface InMemoryMsFileRepositoryStores extends MsFileRepositoryStores {
  readonly settings: InMemoryOwnerFileStore;
  readonly appStores: Map<string, InMemoryOwnerFileStore>;
  appSettings(publisherPublicKeyHex: string): InMemoryOwnerFileStore;
}

/** 与生产同形的内存文件绑定：msfiles 根 + 按 publisher 的 app 根 + 枚举。 */
export function createInMemoryMsFileRepositoryStores(
  ownerPublicKeyHex: string = IN_MEMORY_OWNER_PUBKEY,
): InMemoryMsFileRepositoryStores {
  const settings = createInMemoryOwnerFileStore();
  const appStores = new Map<string, InMemoryOwnerFileStore>();
  return {
    ownerPublicKeyHex,
    settings,
    appStores,
    appSettings(publisherPublicKeyHex: string): InMemoryOwnerFileStore {
      const publisher = publisherPublicKeyHex.toLowerCase();
      const existing = appStores.get(publisher);
      if (existing) return existing;
      const created = createInMemoryOwnerFileStore();
      appStores.set(publisher, created);
      return created;
    },
    async listAppPublishers(): Promise<string[]> {
      return [...appStores.keys()]
        .filter((publisher) => appStores.get(publisher)!.objects.size > 0)
        .sort();
    },
  };
}
