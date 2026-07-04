// packages/plugin-hubmsg/src/hubmsgProvider.ts
// HubMsg MessageProvider 实现（施工单 2026-07-04 001 硬切换）。
//
// 设计缘由：
//   - 本类是 `MessageProvider` 工厂，**不**持有连接真值——每次 `bind(...)`
//     都创建一条新 `HubMsgConnectionImpl` + `HubMsgProviderOperations`；
//   - 调用方（plugin-appmsg）在 owner 真值变化 / 切换 active provider
//     时调 `shutdown()` 关掉旧 handle，再调新 provider 的 `bind(...)`；
//   - 本类**只**实现 typed `MessageProvider` 接口，**不**暴露 wire 层
//     方法名（`request("message.send", ...)` 等）；plugin-appmsg 通过
//     标准化 typed 方法（`sendMessage` / `listMessages` / ...）操作；
//   - 提供 `checkOnline`：与 `HubMsgProviderOperations.checkOnline` 等价
//     的失败语义（handle 未建立 / 协议失败 → 所有 key `"unknown"`）；
//   - 提供 `health`：返回最近一次 connect 结果的快照。

import type {
  MessageProvider,
  MessageProviderHandle,
  MessageProviderHealth,
  ProviderOnlineInput,
  ProviderOnlineResult,
  ProviderSigner
} from "@keymaster/contracts";
import {
  HubMsgBindSignerAdapter,
  HubMsgConnectionImpl,
  HubMsgProviderOperations,
  type HubMsgConnection
} from "./hubmsgConnection.js";

/** HubMsg provider id（plugin-appmsg 用它识别 provider）。 */
export const HUBMSG_PROVIDER_ID = "hubmsg";

/** HubMsg provider 显示名（管理页用）。 */
export const HUBMSG_PROVIDER_DISPLAY_NAME = "HubMsg";

/** HubMsg 默认 WSS 入口。 */
export const DEFAULT_HUBMSG_URL = "wss://msg.keymaster.cc/ws/v1";

/**
 * HubMsg provider 工厂配置。
 */
export interface HubMsgProviderConfig {
  /** WSS 入口；缺省 `DEFAULT_HUBMSG_URL`。 */
  url?: string;
  /** 心跳秒数；缺省 30s。 */
  heartbeatSec?: number;
}

/**
 * HubMsg `MessageProvider` 实现。
 *
 * 生命周期：
 *   - `bind({signer})` → 创建 connection → connect → 返回 typed handle；
 *   - 同一 provider 重复 `bind(...)`：先 close 旧 connection，再建新的；
 *   - `shutdown()` → close 当前 connection（如有）。
 */
export class HubMsgProvider implements MessageProvider {
  readonly id: string = HUBMSG_PROVIDER_ID;
  readonly displayName: string = HUBMSG_PROVIDER_DISPLAY_NAME;

  private readonly cfg: HubMsgProviderConfig;
  private currentConn: HubMsgConnection | null = null;
  private currentOps: HubMsgProviderOperations | null = null;
  private lastErrorMessage: string | null = null;
  private lastConnectedAtMsValue: number = 0;

  constructor(cfg: HubMsgProviderConfig = {}) {
    this.cfg = { url: DEFAULT_HUBMSG_URL, heartbeatSec: 30, ...cfg };
  }

  async bind(input: { signer: ProviderSigner }): Promise<MessageProviderHandle> {
    // 重复 bind：先关旧 connection。
    if (this.currentConn) {
      try {
        this.currentConn.close();
      } catch {
        // ignore
      }
      this.currentConn = null;
      this.currentOps = null;
    }
    const conn = new HubMsgConnectionImpl({
      url: this.cfg.url ?? DEFAULT_HUBMSG_URL,
      heartbeatSec: this.cfg.heartbeatSec ?? 30
    });
    const adapter = new HubMsgBindSignerAdapter(input.signer);
    try {
      await conn.connect(adapter);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastErrorMessage = msg;
      throw err;
    }
    this.currentConn = conn;
    this.currentOps = new HubMsgProviderOperations(conn);
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

  health(): MessageProviderHealth {
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

  async checkOnline(input: ProviderOnlineInput): Promise<ProviderOnlineResult> {
    if (!this.currentOps) {
      const out: ProviderOnlineResult = {};
      for (const h of input.publicKeyHexes) out[h] = "unknown";
      return out;
    }
    return this.currentOps.checkOnline(input);
  }
}

/**
 * 工厂函数。
 */
export function createHubMsgProvider(cfg?: HubMsgProviderConfig): HubMsgProvider {
  return new HubMsgProvider(cfg);
}