import type {
  OwnerFileListPage,
  OwnerFileObject,
  OwnerFileStore,
  PluginStorageDeclaration,
  StorageBucketProvider,
  StorageBucketRef,
  StorageNamespaceBinding
} from "@keymaster/contracts";
import { assertStorageKeyInNamespace, buildStorageNamespaceRoot, validateOwnerPublicKeyHex, validatePluginStorageDeclaration } from "@keymaster/contracts";
import { StorageRuntimeError } from "../../runtime/storageError.js";

export interface OwnerFileStoreOptions {
  /** 当前抽象桶 Provider；业务调用方不能自行替换。 */
  provider: StorageBucketProvider;
  /** 当前桶及其运行世代。 */
  bucket: StorageBucketRef;
  /** Host 校验后的 owner/App 文件声明（model 必须是 "files"）。 */
  declaration: PluginStorageDeclaration;
  /** 当前 owner 的压缩公钥。 */
  ownerPublicKeyHex: string;
  /** 三方 App 身份根：`<owner>/app.<publisher 公钥>/`；只有 files 模型允许。 */
  appPublisherPublicKeyHex?: string;
  /** 切桶或切 Key 后让旧句柄 fail closed。 */
  isCurrent?: () => boolean;
}

function fail(code: "storage_forbidden" | "storage_unavailable" | "storage_provider_error", message: string): StorageRuntimeError {
  return new StorageRuntimeError(code, message);
}

/**
 * 构造已绑定 owner/App 的文件句柄（`model: "files"`）。
 *
 * 与 K-V 入口相同的权限模型：bucket、owner、声明在这里形成不可变
 * binding；调用方只能给模块根下的相对路径，拿不到 Provider 或物理位置。
 */
export function createOwnerFileStore(options: OwnerFileStoreOptions): OwnerFileStore {
  if (options.declaration.scope !== "owner" || options.declaration.authority === "platform-only" || options.declaration.model !== "files") {
    throw fail("storage_forbidden", "Owner file storage declaration is invalid");
  }
  if (options.provider.bucketId !== options.bucket.bucketId) {
    throw fail("storage_forbidden", "Storage bucket binding mismatch");
  }
  const ownerPublicKeyHex = validateOwnerPublicKeyHex(options.ownerPublicKeyHex);
  const declaration = validatePluginStorageDeclaration(options.declaration);
  const binding: StorageNamespaceBinding = Object.freeze({
    ...declaration,
    bucketId: options.bucket.bucketId,
    bucketGeneration: options.bucket.bucketGeneration,
    ownerPublicKeyHex,
    ...(options.appPublisherPublicKeyHex === undefined ? {} : { appPublisherPublicKeyHex: options.appPublisherPublicKeyHex }),
  });
  const root = buildStorageNamespaceRoot(binding);
  let closed = false;

  function assertOpen(): void {
    if (closed || options.isCurrent?.() === false) throw fail("storage_unavailable", "Storage file handle is stale");
  }

  /** 校验根下相对文件路径；空路径与目录前缀由调用方先行处理。 */
  function absolutePath(relative: string): string {
    if (typeof relative !== "string") throw fail("storage_provider_error", "File path is invalid");
    try {
      assertStorageKeyInNamespace(root, `${root}${relative}`);
    } catch {
      throw fail("storage_provider_error", "File path is outside the module root");
    }
    return `${root}${relative}`;
  }

  /** 目录前缀允许末尾无斜杠；补上斜杠避免 `tx` 误匹配 `txfoo/`。 */
  function absolutePrefix(prefix: string | undefined): string {
    if (prefix === undefined || prefix === "") return root;
    const trimmed = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    if (trimmed.length === 0) throw fail("storage_provider_error", "File prefix is invalid");
    return `${absolutePath(trimmed)}/`;
  }

  function relativePath(path: string): string {
    if (!path.startsWith(root)) throw fail("storage_provider_error", "File path is outside the module root");
    return path.slice(root.length);
  }

  return {
    async list(input = {}): Promise<OwnerFileListPage> {
      assertOpen();
      const prefix = absolutePrefix(input.prefix);
      const page = await options.provider.list({
        prefix,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      assertOpen();
      return {
        files: page.objects.map((object) => ({
          path: relativePath(object.path),
          ...(object.size === undefined ? {} : { size: object.size }),
          ...(object.etag === undefined ? {} : { etag: object.etag }),
          ...(object.lastModified === undefined ? {} : { lastModified: object.lastModified }),
        })),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      };
    },
    async get(path): Promise<OwnerFileObject | undefined> {
      assertOpen();
      const object = await options.provider.get(absolutePath(path));
      assertOpen();
      if (!object) return undefined;
      return {
        path: relativePath(object.path),
        bytes: object.bytes,
        ...(object.etag === undefined ? {} : { etag: object.etag }),
        ...(object.lastModified === undefined ? {} : { lastModified: object.lastModified }),
      };
    },
    async put(path, bytes, condition = {}) {
      assertOpen();
      const result = await options.provider.put(absolutePath(path), bytes, condition);
      assertOpen();
      return result;
    },
    async delete(path, input = {}) {
      assertOpen();
      try {
        await options.provider.delete(absolutePath(path), input);
      } catch (error) {
        // 文件删除不存在视为成功；其它错误（含 CAS 冲突）继续上抛。
        if (!(error instanceof StorageRuntimeError) || error.code !== "storage_not_found") throw error;
      }
      assertOpen();
    },
  };
}
