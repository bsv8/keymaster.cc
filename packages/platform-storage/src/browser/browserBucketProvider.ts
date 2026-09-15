// 浏览器组合边界：页面侧 Local 桶 Provider 的唯一构造点。
//
// 生产代码中只有本模块允许解析浏览器存储对象（见存储硬切换门禁的显式
// 白名单）。本模块绝不导出原始存储句柄：返回的 Provider 被固定到
// `keymaster.bucket.<bucketId>.` 命名空间，只能读写该桶自己的对象，
// 不能触碰其它桶或设备引导记录。Worker 侧一律走 bridge，不得使用本模块。
import type { StorageBucketProvider } from "@keymaster/contracts";
import { createLocalStorageBucketProvider } from "../bucket-providers/local/localStorageBucketProvider.js";
import { StorageRuntimeError } from "../runtime/storageError.js";

type InjectedBucketStorage = NonNullable<Parameters<typeof createLocalStorageBucketProvider>[0]["storage"]>;

/** 为指定桶构造页面侧 Local Provider；存储对象永不离开本模块。 */
export function createBrowserLocalBucketProvider(bucketId: string): StorageBucketProvider {
  let storage: InjectedBucketStorage | undefined;
  try {
    storage = (globalThis as typeof globalThis & { localStorage?: InjectedBucketStorage }).localStorage;
  } catch {
    storage = undefined;
  }
  if (!storage) throw new StorageRuntimeError("storage_unavailable", "Local browser storage is unavailable");
  return createLocalStorageBucketProvider({ bucketId, storage });
}
