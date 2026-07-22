// packages/plugin-broadcast/src/broadcastConnectionLifecycle.ts
// 广播连接生命周期协调器（施工单 §6.3）。
//
// 设计缘由：
//   - 远端断开后采用**固定延迟重连**策略，**不**做指数退避；
//   - 协调器是连接生命周期真值拥有者，必须可被单测覆盖完整路径；
//   - owner 真值变化、active provider 变化：立即重绑；
//   - 远端断开：固定延迟（默认 5000ms）后重试；
//   - 不做 replay / resubscribe journal：本地 union 由 core 持有，
//     重连成功后 core 内部会下推 union。

import type { BroadcastConnectionIdentity, BroadcastCore, KeyspaceService, VaultService } from "@keymaster/contracts";

export interface BroadcastConnectionLifecycleLogger {
  info(input: unknown): void;
  warn(input: unknown): void;
}

export interface CreateBroadcastConnectionLifecycleInput {
  core: BroadcastCore;
  vault: VaultService;
  keyspace: KeyspaceService;
  /** 固定重连延迟（ms）；缺省 5000。 */
  reconnectDelayMs?: number;
  logger?: BroadcastConnectionLifecycleLogger;
}

/**
 * 广播系统重连协调器。
 *
 * 行为：
 *   - 订阅 vault status 变化：locked → 解锁时立即重试一次；
 *   - 订阅 keyspace active key 变化：立即重试一次；
 *   - 订阅 core state 变化：state === "closed" 且 nextReconnectAtMs
 *     已设时按时间戳定时触发 owner connection reconcile；
 *   - 当前 owner 解锁 → 自动重连；locked → 自动断开（保持 idle）。
 */
export function createBroadcastConnectionLifecycle(
  cfg: CreateBroadcastConnectionLifecycleInput
): {
  dispose(): void;
} {
  const delayMs = cfg.reconnectDelayMs ?? 5000;
  const log = cfg.logger;

  const safeInfo = (input: unknown): void => {
    try {
      log?.info(input);
    } catch {
      // ignore
    }
  };
  const safeWarn = (input: unknown): void => {
    try {
      log?.warn(input);
    } catch {
      // ignore
    }
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let lastReconciledConnectionIdentity: BroadcastConnectionIdentity | null = null;
  let inFlightReconcile: { key: string; promise: Promise<void> } | null = null;

  const identityKey = (identity: BroadcastConnectionIdentity): string =>
    `${identity.sessionEpoch}:${identity.activePublicKeyHex}:${identity.keyspaceGeneration}`;

  const cancelTimer = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const reconcileBroadcastConnection = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    const vaultLifecycle = cfg.vault.getLifecycleSnapshot();
    if (vaultLifecycle.status !== "unlocked") {
      cfg.core.markStructurallyOffline();
      return Promise.resolve();
    }
    const owner = cfg.keyspace.active().activePublicKeyHex ?? null;
    if (!owner) {
      cfg.core.markStructurallyOffline();
      return Promise.resolve();
    }
    const identity = {
      sessionEpoch: vaultLifecycle.sessionEpoch,
      activePublicKeyHex: owner,
      keyspaceGeneration: cfg.keyspace.active().generation ?? 0
    };
    const key = identityKey(identity);
    if (key === (lastReconciledConnectionIdentity && identityKey(lastReconciledConnectionIdentity)) && cfg.core.inspect().state === "bound") {
      return Promise.resolve();
    }
    if (inFlightReconcile?.key === key) return inFlightReconcile.promise;

    const promise = (async (): Promise<void> => {
      try {
      await cfg.core.reconcileOwnerConnection(identity);
      if (cfg.core.inspect().state === "bound") lastReconciledConnectionIdentity = identity;
      } catch (err) {
        safeWarn({
          scope: "broadcast.core",
          event: "broadcast.connection.lifecycle.reconcile.failed",
          message: "",
          data: { err: err instanceof Error ? err.message : String(err) }
        });
      }
    })();
    inFlightReconcile = { key, promise };
    void promise.finally(() => {
      if (inFlightReconcile?.promise === promise) inFlightReconcile = null;
    });
    return promise;
  };

  const onVaultLifecycleChanged = (snapshot: { status: string }): void => {
    safeInfo({
      scope: "broadcast.core",
      event: "broadcast.vault.status.changed",
      message: "",
      data: { status: snapshot.status }
    });
    if (snapshot.status === "unlocked") {
      void reconcileBroadcastConnection();
    } else {
      lastReconciledConnectionIdentity = null;
      cancelTimer();
      cfg.core.markStructurallyOffline();
    }
  };

  const onActiveKeyChanged = (): void => {
    safeInfo({
      scope: "broadcast.core",
      event: "broadcast.keyspace.changed",
      message: ""
    });
    void reconcileBroadcastConnection();
  };

  const onBroadcastConnectionStateChanged = (): void => {
    if (disposed) return;
    const snap = cfg.core.inspect();
    if (snap.state === "closed" && snap.nextReconnectAtMs !== null) {
      const wait = Math.max(0, snap.nextReconnectAtMs - Date.now());
      cancelTimer();
      timer = setTimeout(() => {
        timer = null;
        void reconcileBroadcastConnection();
      }, wait);
    } else {
      cancelTimer();
    }
  };

  const offVault = cfg.vault.onLifecycleChange(onVaultLifecycleChanged);
  const offKeyspace = cfg.keyspace.onActiveKeyChanged(onActiveKeyChanged);
  const offCore = cfg.core.onConnectionStateChanged(onBroadcastConnectionStateChanged);

  // 启动期：vault 已解锁 + 有 active key 时主动重连一次。
  if (cfg.vault.getLifecycleSnapshot().status === "unlocked") {
    void reconcileBroadcastConnection();
  }

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelTimer();
      try {
        offVault();
      } catch {
        // ignore
      }
      try {
        offKeyspace();
      } catch {
        // ignore
      }
      try {
        offCore();
      } catch {
        // ignore
      }
      void cfg.core.disconnect();
    }
  };
}
