// packages/plugin-hubcast/src/hubcastProvider.ts
// HubCast BroadcastProvider 实现（施工单 2026-07-06 001 硬切换）。
//
// 设计缘由：
//   - 本类是 `BroadcastProvider` 工厂，**不**持有连接真值——每次
//     `bind(...)` 都创建一条新 `HubCastConnectionImpl` +
//     `HubCastProviderOperations`；
//   - 调用方（plugin-broadcast core）在 owner 真值变化 / 切换 active
//     provider 时调 `shutdown()` 关掉旧 handle，再调新 provider 的
//     `bind(...)`；
//   - 本类**只**实现 typed `BroadcastProvider` 接口，**不**暴露 wire
//     层方法名；
//   - 提供 `health`：返回最近一次 connect 结果的快照。

import type {
  BroadcastProvider,
  BroadcastProviderHandle,
  BroadcastProviderHealth,
  BroadcastProviderSigner
} from "@keymaster/contracts";
import {
  HubCastBindSignerAdapter,
  HubCastConnectionImpl,
  HubCastProviderOperations,
  type HubCastConnection,
  type HubCastConnectionLogger
} from "./hubcastConnection.js";

/** HubCast provider id（plugin-broadcast 用它识别 provider）。 */
export const HUBCAST_PROVIDER_ID = "hubcast";

/** HubCast provider 显示名（管理页用）。 */
export const HUBCAST_PROVIDER_DISPLAY_NAME = "HubCast";

/** HubCast 默认 WSS 入口。 */
export const DEFAULT_HUBCAST_URL = "wss://cast.keymaster.cc/ws/v1";

/**
 * HubCast provider 工厂配置。
 */
export interface HubCastProviderConfig {
  /** WSS 入口；缺省 `DEFAULT_HUBCAST_URL`。 */
  url?: string;
  /** 心跳秒数；缺省 30s。 */
  heartbeatSec?: number;
  /** 握手超时毫秒；缺省沿用连接层默认值。 */
  handshakeTimeoutMs?: number;
  /** 可选日志出口。 */
  logger?: HubCastConnectionLogger;
}

/**
 * HubCast `BroadcastProvider` 实现。
 *
 * 生命周期：
 *   - `bind({signer})` → 创建 connection → connect → 返回 typed handle；
 *   - 同一 provider 重复 `bind(...)`：先 close 旧 connection，再建新的；
 *   - `shutdown()` → close 当前 connection（如有）。
 */
export class HubCastProvider implements BroadcastProvider {
  readonly id: string = HUBCAST_PROVIDER_ID;
  readonly displayName: string = HUBCAST_PROVIDER_DISPLAY_NAME;

  private readonly cfg: HubCastProviderConfig;
  private currentConn: HubCastConnection | null = null;
  private currentOps: HubCastProviderOperations | null = null;
  private lastErrorMessage: string | null = null;
  private lastConnectedAtMsValue: number = 0;

  constructor(cfg: HubCastProviderConfig = {}) {
    this.cfg = { url: DEFAULT_HUBCAST_URL, heartbeatSec: 30, ...cfg };
  }

  private emitLog(
    level: "info" | "warn" | "error",
    event: string,
    data?: Record<string, unknown>
  ): void {
    const logger = this.cfg.logger;
    if (!logger) return;
    try {
      logger[level]({
        scope: "hubcast.provider",
        event,
        message: "",
        data
      });
    } catch {
      // ignore
    }
  }

  async bind(input: { signer: BroadcastProviderSigner }): Promise<BroadcastProviderHandle> {
    if (this.currentConn) {
      try {
        this.currentConn.close();
      } catch {
        // ignore
      }
      this.currentConn = null;
      this.currentOps = null;
    }
    const conn = new HubCastConnectionImpl({
      url: this.cfg.url ?? DEFAULT_HUBCAST_URL,
      heartbeatSec: this.cfg.heartbeatSec ?? 30,
      handshakeTimeoutMs: this.cfg.handshakeTimeoutMs,
      logger: this.cfg.logger
    });
    const adapter = new HubCastBindSignerAdapter(input.signer);
    try {
      await conn.connect(adapter);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastErrorMessage = msg;
      this.emitLog("error", "hubcast.provider.bind.failed", {
        url: this.cfg.url ?? DEFAULT_HUBCAST_URL,
        publicKeyHex: input.signer.publicKeyHex,
        err: msg
      });
      throw err;
    }
    this.currentConn = conn;
    this.currentOps = new HubCastProviderOperations(conn);
    this.lastErrorMessage = null;
    this.lastConnectedAtMsValue = Date.now();
    return this.currentOps;
  }

  async shutdown(): Promise<void> {
    if (this.currentConn) {
      try {
        this.currentConn.close();
      } catch {
        // ignore
      }
      this.currentConn = null;
      this.currentOps = null;
      this.lastErrorMessage = "shut down";
    }
  }

  health(): BroadcastProviderHealth {
    const isHealthy =
      this.currentConn !== null &&
      this.currentConn.state() === "bound" &&
      this.lastErrorMessage === null;
    return {
      isHealthy,
      lastError: this.lastErrorMessage,
      lastConnectedAtMs: this.lastConnectedAtMsValue
    };
  }
}

/**
 * 工厂函数。
 */
export function createHubCastProvider(cfg?: HubCastProviderConfig): HubCastProvider {
  return new HubCastProvider(cfg);
}