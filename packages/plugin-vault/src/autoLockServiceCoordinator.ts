// packages/plugin-vault/src/autoLockServiceCoordinator.ts
// AutoLockService Coordinator Facade
//
// 设计缘由：
//   - 页面只拥有读/写自动锁超时的 facade，真值在 Coordinator SharedWorker；
//   - 页面不持有 timer，不直接操作快照持久化，仅经 RPC 更新并经
//     session.state 广播收敛多 tab。

import type {
  AutoLockService,
  AutoLockSettings,
  SessionStateEvent,
} from "@keymaster/contracts";
import { AUTO_LOCK_DEFAULT_TIMEOUT_MS, normalizeAutoLockTimeoutMs } from "@keymaster/contracts";

type CoordinatorResultLike = { status: string; message?: string };

/** AutoLock facade 所需的最小 Coordinator 面；不把完整 client 强制带入。 */
export interface AutoLockCoordinatorClientLike {
  getIsConnected(): boolean;
  getBootstrapSnapshot(): { autoLockTimeoutMs?: number };
  subscribeTopic(topic: string, listener: (event: SessionStateEvent) => void): () => void;
  autolockSettingsUpdate(settings: AutoLockSettings): Promise<CoordinatorResultLike>;
}

export interface AutoLockServiceCoordinatorDeps {
  coordinatorClient: AutoLockCoordinatorClientLike;
}

export function createAutoLockServiceCoordinator(
  deps: AutoLockServiceCoordinatorDeps
): AutoLockService {
  const { coordinatorClient } = deps;

  let cachedTimeoutMs = normalizeAutoLockTimeoutMs(
    coordinatorClient.getBootstrapSnapshot()?.autoLockTimeoutMs
  );
  const handlers = new Set<(settings: AutoLockSettings) => void>();

  const unsubscribe = coordinatorClient.subscribeTopic("session.state", (event) => {
    if (!event || (event as { type?: string }).type !== "session.state.changed") return;
    const typed = event as SessionStateEvent;
    if (typed.autoLockTimeoutMs === undefined) return;
    const next = normalizeAutoLockTimeoutMs(typed.autoLockTimeoutMs);
    if (next === cachedTimeoutMs) return;
    cachedTimeoutMs = next;
    emit();
  });

  function emit() {
    const snapshot = { timeoutMs: cachedTimeoutMs };
    for (const handler of handlers) {
      try { handler(snapshot); } catch { /* noop */ }
    }
  }

  return {
    getSettings(): AutoLockSettings {
      if (coordinatorClient.getIsConnected()) {
        const fromBootstrap = normalizeAutoLockTimeoutMs(
          coordinatorClient.getBootstrapSnapshot()?.autoLockTimeoutMs ?? cachedTimeoutMs
        );
        if (fromBootstrap !== cachedTimeoutMs) {
          cachedTimeoutMs = fromBootstrap;
          queueMicrotask(emit);
        }
      }
      return { timeoutMs: cachedTimeoutMs };
    },

    onSettingsChanged(handler: (settings: AutoLockSettings) => void): () => void {
      handlers.add(handler);
      handler({ timeoutMs: cachedTimeoutMs });
      return () => { handlers.delete(handler); };
    },

    async updateSettings(settings: AutoLockSettings) {
      if (typeof coordinatorClient.autolockSettingsUpdate !== "function") {
        throw new Error("Coordinator autolock RPC unavailable");
      }
      const result = await coordinatorClient.autolockSettingsUpdate(settings);
      if (result.status === "accepted" || result.status === "ok") {
        if (settings.timeoutMs !== cachedTimeoutMs) {
          cachedTimeoutMs = settings.timeoutMs;
          emit();
        }
        return { status: "accepted" as const };
      }
      if (result.status === "validation-error" || result.status === "error" || result.status === "transport-error") {
        return { status: result.status, message: result.message ?? "Request failed" };
      }
      return { status: result.status as "locked" | "not-ready" | "stale-epoch" };
    },

    dispose() {
      unsubscribe();
      handlers.clear();
    },
  };
}
