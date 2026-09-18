// 浏览器组合边界：页面侧 Local 桶 Provider 的唯一构造点。
//
// 生产代码中只有本模块允许解析浏览器存储对象（见存储硬切换门禁的显式
// 白名单）。本模块绝不导出原始存储句柄：返回的 Provider 被固定到
// `bucketId` 命名空间，只能读写该桶自己的对象，不能触碰其它桶。
// Local 桶的物理介质是 IndexedDB；Worker 侧一律走 bridge，不得使用本模块。
import type { StorageBucketProvider } from "@keymaster/contracts";
import { createIndexedDbBucketProvider } from "../bucket-providers/local/indexedDbBucketProvider.js";

/** 为指定桶构造页面侧 Local Provider；存储对象永不离开本模块。 */
export function createBrowserLocalBucketProvider(bucketId: string): StorageBucketProvider {
  return createIndexedDbBucketProvider({ bucketId });
}
