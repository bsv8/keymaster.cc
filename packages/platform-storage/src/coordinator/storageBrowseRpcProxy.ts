import type { CapabilityClient } from "webloom-framework";
import { STORAGE_PRIVATE_BROWSE_CAPABILITY, parseStorageBrowsePrivateResponse, type StorageBrowsePrivateData, type StorageBrowsePrivateRequest } from "./storageBrowsePrivateCapability.js";
import type { StorageBrowseService } from "../runtime/storageBrowsePrivate.js";
// 页面侧只读存储浏览代理。
//
// 它把 StorageBrowseService 的方法翻译成 Coordinator 的三条 RPC，并把浏览会话
// 的生命周期收在一处：打开一次、复用同一个句柄；会话世代、钱包世代或 Worker
// 运行世代一变，旧句柄立刻作废并重新打开；离开页面时关闭。
//
// 与 StorageRpcProxy 的区别：那里服务的是 Connect 授权面（要自己申请 grant），
// 这里服务的是平台自带的浏览页，拿到的永远是全钱包只读视图，且没有任何写方法。
//
// 打开会话的请求里没有身份字段：浏览授权由 Coordinator 在它自己已验证的 peer
// 上下文里签发。页面这一侧能做的只是「请求一次会话」，声明自己是谁不构成授权。
import type { CoordinatorValueResult } from "@keymaster/contracts";
import type { StorageBrowseListRequest, StorageBrowsePage, StorageBrowsePreview, StorageBrowsePreviewRequest, StorageBrowseSession } from "../runtime/storageBrowseTypes.js";
import { StorageRuntimeError } from "../runtime/storageError.js";

/** 打开会话的失败。已取消不算错误：快速切换时它只是提前退出。 */
export class StorageBrowseCancelledError extends StorageRuntimeError {
  constructor() {
    super("storage_unavailable", "Storage browse request was cancelled");
  }
}

/** 把 Coordinator 结果信封解包；失败统一成 StorageRuntimeError。 */
function unwrap<T>(result: CoordinatorValueResult<unknown>): T {
  if (result.status === "ok") return result.value as T;
  if (result.status === "transport-error") throw new StorageBrowseCancelledError();
  const code = "code" in result && typeof result.code === "string"
    ? result.code as import("@keymaster/contracts").StorageErrorCode
    : undefined;
  const message = "message" in result && typeof result.message === "string"
    ? result.message
    : result.status === "blocked"
      ? (typeof result.reason === "string" ? result.reason : result.reason.fallback)
      : "Storage browse request failed";
  throw new StorageRuntimeError(code ?? "storage_provider_error", message);
}

export interface StorageBrowseRpcProxyOptions {
  client: () => CapabilityClient<typeof STORAGE_PRIVATE_BROWSE_CAPABILITY>;
  sessionEpoch: () => string;
}

export class StorageBrowseRpcProxy implements StorageBrowseService {
  private readonly client: StorageBrowseRpcProxyOptions["client"];
  private readonly sessionEpoch: () => string;
  /** 进行中的打开请求；dispose 或世代变化时用来避免留下孤儿句柄。 */
  private opening: Promise<StorageBrowseSession> | undefined;
  private session: StorageBrowseSession | undefined;
  private disposed = false;

  constructor(options: StorageBrowseRpcProxyOptions) {
    this.client = options.client;
    this.sessionEpoch = options.sessionEpoch;
  }

  private async rpc(request: StorageBrowsePrivateRequest, signal?: AbortSignal): Promise<CoordinatorValueResult<unknown>> {
    const response = parseStorageBrowsePrivateResponse(request, await this.client().call(request, { ...(signal ? { signal } : {}) }));
    if (response.ack.status !== "ok") return response.ack;
    return { status: "ok", value: response.operationResult, sessionEpoch: response.sessionEpoch };
  }

  private closeRpc(browseSessionId: string): Promise<CoordinatorValueResult<unknown>> {
    return this.rpc({ kind: "storage.browse.close", browseSessionId });
  }

  /** 当前句柄的三种世代；没有会话时返回 undefined。 */
  currentSession(): StorageBrowseSession | undefined {
    return this.session;
  }

  async openSession(): Promise<StorageBrowseSession> {
    if (this.disposed) throw new StorageRuntimeError("storage_unavailable", "Storage browse proxy is disposed");
    const cached = this.session;
    if (cached) return cached;
    // 并发调用共享同一次打开：两个句柄意味着两倍的游标预算和两条要清理的路径。
    const pending = this.opening;
    if (pending) return pending;
    const opening = this.rpc({ kind: "storage.browse.open", expectedSessionEpoch: this.sessionEpoch() })
      .then((result) => {
        const session = unwrap<StorageBrowseSession>(result);
        // 打开期间可能已经 dispose 或切了世代：这份句柄不能再用。
        if (this.disposed) {
          void this.closeRpc(session.browseSessionId).catch(() => undefined);
          throw new StorageRuntimeError("storage_unavailable", "Storage browse proxy is disposed");
        }
        if (this.opening === opening) {
          this.session = session;
          this.opening = undefined;
        }
        return session;
      })
      .catch((error: unknown) => {
        if (this.opening === opening) this.opening = undefined;
        throw error;
      });
    this.opening = opening;
    return opening;
  }

  /** 丢弃当前句柄（不通知 Worker）；只在世代已经推进、句柄本就作废时使用。 */
  private forgetSession(): void {
    this.session = undefined;
  }

  /**
   * 用句柄发一次数据请求。
   *
   * Worker 返回 storage_unavailable 说明句柄已经因锁定、重置或 Worker 重启作废；
   * 这里丢掉本地句柄，让下一次调用重新打开，而不是把这个错误直接抛给页面——
   * 页面正在浏览时锁定属于正常操作，不该表现成一次浏览失败。
   */
  private async request<T>(build: (session: StorageBrowseSession) => StorageBrowsePrivateData, signal?: AbortSignal): Promise<T> {
    if (this.disposed) throw new StorageRuntimeError("storage_unavailable", "Storage browse proxy is disposed");
    const session = await this.openSession();
    const result = await this.rpc({ kind: "storage.browse.data", data: build(session), expectedSessionEpoch: this.sessionEpoch() }, signal);
    if (result.status === "error" && result.code === "storage_unavailable") this.forgetSession();
    return unwrap<T>(result);
  }

  async list(request: StorageBrowseListRequest, options?: { signal?: AbortSignal }): Promise<StorageBrowsePage> {
    return this.request<StorageBrowsePage>(
      (session) => ({ type: "browse.list", browseSessionId: session.browseSessionId, prefix: request.prefix, ...(request.cursor === undefined ? {} : { cursor: request.cursor }), ...(request.limit === undefined ? {} : { limit: request.limit }) }),
      options?.signal,
    );
  }

  async preview(request: StorageBrowsePreviewRequest, options?: { signal?: AbortSignal }): Promise<StorageBrowsePreview> {
    return this.request<StorageBrowsePreview>(
      (session) => ({ type: "browse.preview", browseSessionId: session.browseSessionId, path: request.path, ...(request.ifRevision === undefined ? {} : { ifRevision: request.ifRevision }) }),
      options?.signal,
    );
  }

  async closeSession(browseSessionId: string): Promise<void> {
    const current = this.session;
    // 只关自己手上的那一份：外来 id 在 Worker 侧也是空操作，这里不再转发。
    if (!current || current.browseSessionId !== browseSessionId) return;
    this.session = undefined;
    await this.closeRpc(browseSessionId).catch(() => undefined);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const current = this.session;
    this.session = undefined;
    this.opening = undefined;
    if (current) void this.closeRpc(current.browseSessionId).catch(() => undefined);
  }
}
