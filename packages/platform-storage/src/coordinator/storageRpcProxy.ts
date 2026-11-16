// 页面侧 Storage 门面。
//
// 它不持有 Provider 配置、数据库连接、游标或任何物理路径：所有 I/O 都转成
// Coordinator RPC。这里只做三件事：把 Worker 结果解包成领域错误、维护跨 Tab
// 状态订阅。
//
import type {
  CoordinatorStorageControl,
  CoordinatorValueResult,
  StorageCoordinatorControl,
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
  private readonly unsubscribeState: () => void;

  constructor(private readonly coordinator: StorageCoordinatorControl) {
    this.unsubscribeState = coordinator.subscribeTopic("storage.state", (event: StateEvent) => {
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
  }

  summary(): Promise<StorageRuntimeSummary> {
    return this.control<StorageRuntimeSummary>({ type: "summary" });
  }

  abortSession(walletPublicKeyHex: string): Promise<void> {
    return this.coordinator.storageSessionAbort(walletPublicKeyHex).then((result) => {
      if (result.status !== "ok") throw new StorageRuntimeError("storage_unavailable", "Storage session abort failed");

    });
  }

  private control<T>(control: CoordinatorStorageControl): Promise<T> {
    return this.coordinator.storageControl(control).then(unwrap<T>);
  }

}

export function createStorageRuntimeController(coordinator: StorageCoordinatorControl): StorageRuntimeController {
  return new StorageRpcProxy(coordinator);
}
