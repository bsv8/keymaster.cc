// packages/plugin-broadcast/src/reconnectCoordinator.ts
// 广播系统的固定延迟重连协调器（施工单 §6.3）。
//
// 设计缘由：
//   - 远端断开后采用**固定延迟重连**策略，**不**做指数退避；
//   - 协调器是连接生命周期真值拥有者，必须可被单测覆盖完整路径；
//   - owner 真值变化、active provider 变化：立即重绑；
//   - 远端断开：固定延迟（默认 5000ms）后重试；
//   - 不做 replay / resubscribe journal：本地 union 由 core 持有，
//     重连成功后 core 内部会下推 union。

import type { BroadcastCore, KeyspaceService, VaultService } from "@keymaster/contracts";

export interface ReconnectLogger {
  info(input: unknown): void;
  warn(input: unknown): void;
}

export interface CreateReconnectCoordinatorInput {
  core: BroadcastCore;
  vault: VaultService;
  keyspace: KeyspaceService;
  /** 固定重连延迟（ms）；缺省 5000。 */
  reconnectDelayMs?: number;
  logger?: ReconnectLogger;
}

/**
 * 广播系统重连协调器。
 *
 * 行为：
 *   - 订阅 vault status 变化：locked → 解锁时立即重试一次；
 *   - 订阅 keyspace active key 变化：立即重试一次；
 *   - 订阅 core state 变化：state === "closed" 且 nextReconnectAtMs
 *     已设时按时间戳定时触发 connectForOwner；
 *   - 当前 owner 解锁 → 自动重连；locked → 自动断开（保持 idle）。
 */
export function createReconnectCoordinator(
  cfg: CreateReconnectCoordinatorInput
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

  const cancelTimer = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const tryConnect = async (): Promise<void> => {
    if (disposed) return;
    const vaultStatus = cfg.vault.status();
    if (vaultStatus !== "unlocked") {
      cfg.core.markStructurallyOffline();
      return;
    }
    const owner = cfg.keyspace.active().activePublicKeyHex ?? null;
    if (!owner) {
      cfg.core.markStructurallyOffline();
      return;
    }
    try {
      await cfg.core.connectForOwner(owner);
    } catch (err) {
      safeWarn({
        scope: "broadcast.core",
        event: "broadcast.reconnect.failed",
        message: "",
        data: { err: err instanceof Error ? err.message : String(err) }
      });
    }
  };

  const onVaultStatusChange = (status: string): void => {
    safeInfo({
      scope: "broadcast.core",
      event: "broadcast.vault.status.changed",
      message: "",
      data: { status }
    });
    if (status === "unlocked") {
      void tryConnect();
    } else {
      cancelTimer();
      cfg.core.markStructurallyOffline();
    }
  };

  const onKeyspaceChange = (): void => {
    safeInfo({
      scope: "broadcast.core",
      event: "broadcast.keyspace.changed",
      message: ""
    });
    void tryConnect();
  };

  const onCoreStateChange = (): void => {
    if (disposed) return;
    const snap = cfg.core.inspect();
    if (snap.state === "closed" && snap.nextReconnectAtMs !== null) {
      const wait = Math.max(0, snap.nextReconnectAtMs - Date.now());
      cancelTimer();
      timer = setTimeout(() => {
        timer = null;
        void tryConnect();
      }, wait);
    } else {
      cancelTimer();
    }
  };

  const offVault = cfg.vault.onStatusChange(onVaultStatusChange);
  const offKeyspace = cfg.keyspace.onActiveChange(onKeyspaceChange);
  const offCore = cfg.core.onStateChange(onCoreStateChange);

  // 启动期：vault 已解锁 + 有 active key 时主动重连一次。
  if (cfg.vault.status() === "unlocked") {
    void tryConnect();
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