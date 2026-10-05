import type { StorageBrowseOpenRequest, StorageBrowseSession, StorageBrowseListRequest, StorageBrowsePage, StorageBrowsePreviewRequest, StorageBrowsePreview } from "./storageBrowseTypes.js";

/** Storage 自己的 UI 浏览服务，不属于公开领域契约。 */
export interface StorageBrowseService {
  /** 打开一个绑定当前三种世代的临时浏览句柄。 */
  openSession(request: StorageBrowseOpenRequest): Promise<StorageBrowseSession>;
  /**
   * 列举一页对象元数据；只读元数据，不返回字节。
   *
   * 请求里没有浏览句柄：调用方拿到的是页面侧已经绑定好句柄的服务，句柄由实现
   * 自己管理并随世代失效重建。句柄只出现在 Coordinator RPC 层（见
   * {@link StorageBrowsePrivateData}），因此页面永远拿不到它。
   */
  list(request: StorageBrowseListRequest, options?: { signal?: AbortSignal }): Promise<StorageBrowsePage>;
  /** 请求文件预览；Worker 强制字节上限与版本条件。 */
  preview(request: StorageBrowsePreviewRequest, options?: { signal?: AbortSignal }): Promise<StorageBrowsePreview>;
  /** 关闭浏览会话并释放它的全部游标与在途请求。 */
  closeSession(browseSessionId: string): Promise<void>;
}

/**
 * 浏览服务用到的钱包只读面。
 *
 * 它只有元数据列举和单对象读取两个方法，没有任何写入；这是「浏览动作不得写入
 * 钱包」在类型上的保证，而不是靠调用方自觉。
 */
export interface StorageBrowseWallet {
  /** 游标分页列举；只读元数据，永不返回字节。 */
  list(input?: { prefix?: string; cursor?: string; limit?: number; signal?: AbortSignal }): Promise<{
    objects: Array<{ path: string; size: number; lastModified: string; revision: number; contentType?: string }>;
    nextCursor?: string;
  }>;
  /** 读取一个对象；不存在返回 undefined。 */
  get(path: string, options?: { signal?: AbortSignal }): Promise<{
    path: string;
    size: number;
    lastModified: string;
    revision: number;
    contentType?: string;
    bytes: Uint8Array;
  } | undefined>;
}
