// 页面侧 Storage 门面。
//
// 它不持有 Provider 配置、数据库连接、游标或任何物理路径：所有 I/O 都转成
// Coordinator RPC。这里只做三件事：把 Worker 结果解包成领域错误、维护跨 Tab
// 状态订阅、缓存当前 Connect 会话的目录授权。
//
import type {
  CoordinatorStorageControl,
  CoordinatorStorageData,
  CoordinatorValueResult,
  StorageCoordinatorControl,
  OwnerAppStorageGrant,
  StorageDeleteResult,
  StorageDirectoryResult,
  StorageGetResult,
  StorageListResult,
  StoragePutResult,
  StorageRuntimeController,
  StorageRuntimeControllerStatus,
  StorageRuntimeSummary,
} from "@keymaster/contracts";
import { StorageRuntimeError } from "../runtime/storageError.js";

type StateEvent = {
  topic: "storage.state";
  sessionEpoch: string;
  status: StorageRuntimeControllerStatus;
  summary?: StorageRuntimeSummary | null;
  activity?: { reads: number; writes: number };
};

/** 把 Coordinator 的结果信封解包；失败一律成为可区分的 StorageRuntimeError。 */
function unwrap<T>(result: CoordinatorValueResult<unknown>): Promise<T> {
  if (result.status === "ok") return Promise.resolve(result.value as T);
  if (result.status === "transport-error") {
    throw new StorageRuntimeError("storage_unavailable", result.message || "Storage Coordinator request was cancelled");
  }
  const code = "code" in result && typeof result.code === "string"
    ? result.code as import("@keymaster/contracts").StorageErrorCode
    : undefined;
  const message = "message" in result && typeof result.message === "string"
    ? result.message
    : result.status === "blocked"
      ? (typeof result.reason === "string" ? result.reason : result.reason.fallback)
      : "Storage Coordinator request failed";
  throw new StorageRuntimeError(code ?? "storage_provider_error", message);
}

export class StorageRpcProxy implements StorageRuntimeController {
  private current: StateEvent = {
    topic: "storage.state",
    sessionEpoch: "boot",
    status: "locked",
    summary: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly grants = new Map<string, Promise<string>>();
  private readonly unsubscribeState: () => void;

  constructor(private readonly coordinator: StorageCoordinatorControl) {
    this.unsubscribeState = coordinator.subscribeTopic("storage.state", (event: StateEvent) => {
      // 会话世代变化意味着旧授权全部失效：缓存必须一起清掉，否则下一个请求
      // 会带着已经撤销的 grant 去访问数据。
      if (event.sessionEpoch !== this.current.sessionEpoch) this.grants.clear();
      this.current = event;
      for (const listener of this.listeners) listener();
    });
  }

  activity(): { reads: number; writes: number } { return this.current.activity ?? { reads: 0, writes: 0 }; }

  status(): StorageRuntimeControllerStatus {
    return this.current.status;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  dispose(): void {
    this.unsubscribeState();
    this.listeners.clear();
    this.grants.clear();
  }

  summary(): Promise<StorageRuntimeSummary> {
    return this.control<StorageRuntimeSummary>({ type: "summary" });
  }

  abortSession(connectSessionId: string): Promise<void> {
    return this.coordinator.storageSessionAbort(connectSessionId).then((result) => {
      if (result.status !== "ok") throw new StorageRuntimeError("storage_unavailable", "Storage session abort failed");
      for (const key of [...this.grants.keys()]) {
        if (key.startsWith(`${connectSessionId}|`)) this.grants.delete(key);
      }
    });
  }

  list(ctx: OwnerAppStorageGrant, input: { prefix?: string; cursor?: string; limit?: number; signal?: AbortSignal }): Promise<StorageListResult> {
    return this.dataFor<StorageListResult>(ctx, (grantId) => ({
      type: "list",
      grantId,
      input: {
        ...(input.prefix === undefined ? {} : { prefix: input.prefix }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      },
    }), [], input.signal);
  }

  createDirectory(ctx: OwnerAppStorageGrant, input: { path: string; overwrite?: boolean; signal?: AbortSignal }): Promise<StorageDirectoryResult> {
    return this.dataFor<StorageDirectoryResult>(ctx, (grantId) => ({
      type: "create-directory",
      grantId,
      input: { path: input.path, ...(input.overwrite === undefined ? {} : { overwrite: input.overwrite }) },
    }), [], input.signal);
  }

  deleteDirectory(ctx: OwnerAppStorageGrant, input: { path: string; signal?: AbortSignal }): Promise<StorageDirectoryResult> {
    return this.dataFor<StorageDirectoryResult>(ctx, (grantId) => ({
      type: "delete-directory",
      grantId,
      input: { path: input.path },
    }), [], input.signal);
  }

  put(ctx: OwnerAppStorageGrant, input: {
    path: string;
    content: { $type: "binary"; bytes: ArrayBuffer; mime?: string };
    contentType?: string;
    overwrite?: boolean;
    signal?: AbortSignal;
  }): Promise<StoragePutResult> {
    return this.dataFor<StoragePutResult>(ctx, (grantId) => ({
      type: "put",
      grantId,
      input: {
        path: input.path,
        content: input.content,
        ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
        ...(input.overwrite === undefined ? {} : { overwrite: input.overwrite }),
      },
    }), [input.content.bytes], input.signal);
  }

  getRange(ctx: OwnerAppStorageGrant, input: {
    path: string;
    offset?: number;
    length?: number;
    ifMatch?: string;
    signal?: AbortSignal;
  }): Promise<StorageGetResult> {
    return this.dataFor<StorageGetResult>(ctx, (grantId) => ({
      type: "get-range",
      grantId,
      input: {
        path: input.path,
        ...(input.offset === undefined ? {} : { offset: input.offset }),
        ...(input.length === undefined ? {} : { length: input.length }),
        ...(input.ifMatch === undefined ? {} : { ifMatch: input.ifMatch }),
      },
    }), [], input.signal);
  }

  delete(ctx: OwnerAppStorageGrant, input: { path: string; signal?: AbortSignal }): Promise<StorageDeleteResult> {
    return this.dataFor<StorageDeleteResult>(ctx, (grantId) => ({
      type: "delete",
      grantId,
      input: { path: input.path },
    }), [], input.signal);
  }

  private control<T>(control: CoordinatorStorageControl): Promise<T> {
    return this.coordinator.storageControl(control).then(unwrap<T>);
  }

  /** 同一 Connect 会话 + 同一 App 身份复用同一个目录授权。 */
  private grantFor(ctx: OwnerAppStorageGrant): Promise<string> {
    const key = `${ctx.connectSessionId}|${ctx.transportOrigin}|${ctx.appIdentity.identityDigestHex}`;
    const existing = this.grants.get(key);
    if (existing) return existing;
    const pending = this.coordinator.storageGrant(ctx).then(unwrap<string>).catch((error) => {
      this.grants.delete(key);
      throw error;
    });
    this.grants.set(key, pending);
    return pending;
  }

  private dataFor<T>(
    ctx: OwnerAppStorageGrant,
    build: (grantId: string) => CoordinatorStorageData,
    transfer: ArrayBuffer[] = [],
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(new StorageRuntimeError("storage_unavailable", "Storage request was cancelled"));
    const key = `${ctx.connectSessionId}|${ctx.transportOrigin}|${ctx.appIdentity.identityDigestHex}`;
    return this.grantFor(ctx)
      .then((grantId) => {
        if (signal?.aborted) throw new StorageRuntimeError("storage_unavailable", "Storage request was cancelled");
        return this.coordinator.storageData(build(grantId), transfer, signal);
      })
      .then(unwrap<T>)
      .catch((error) => {
        // 身份或可用性失败说明这份授权不再可信：丢弃缓存，下次重新申请。
        if (error instanceof StorageRuntimeError
          && (error.code === "storage_identity_required" || error.code === "storage_unavailable")) {
          this.grants.delete(key);
        }
        throw error;
      });
  }
}

export function createStorageRuntimeController(coordinator: StorageCoordinatorControl): StorageRuntimeController {
  return new StorageRpcProxy(coordinator);
}
