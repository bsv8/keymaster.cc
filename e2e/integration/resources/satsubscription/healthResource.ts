import { randomUUID } from "node:crypto";
import type { E2ESatSubscriptionConfig } from "../config/types.js";
import { assertSafeIdentifier } from "../../support/ids.js";

export interface SatSubscriptionHealth {
  /** 服务端运行时声明的货币网络，不能由 URL 或文件名推断。 */
  readonly network: "testnet" | "mainnet" | "unknown";
  /** 服务身份公钥；只保留公开身份。 */
  readonly servicePublicKeyHex: string;
  /** 服务返回的连接入口，用于确认双入口没有静默分叉。 */
  readonly entrypoint: "websocket" | "webrtc-direct";
}

/** 未通过校验的探针原始结果允许显式 unknown，避免缺字段被默认为合法入口。 */
export interface SatSubscriptionProbeHealth {
  readonly network: "testnet" | "mainnet" | "unknown";
  readonly servicePublicKeyHex: string;
  readonly entrypoint: "websocket" | "webrtc-direct" | "unknown";
}

export interface SatSubscriptionProbe {
  checkWebsocket(url: string, requestId: string): Promise<SatSubscriptionProbeHealth>;
  /** WebRTC Direct 需要真实 P2P adapter；没有 adapter 时必须显式失败。 */
  checkWebrtcDirect(address: string, requestId: string): Promise<SatSubscriptionProbeHealth>;
}

function assertHealth(value: SatSubscriptionProbeHealth, expectedEntrypoint: SatSubscriptionHealth["entrypoint"]): SatSubscriptionHealth {
  if (value.entrypoint !== expectedEntrypoint) throw new Error(`SatSubscription ${expectedEntrypoint} probe returned the wrong entrypoint`);
  if (value.network !== "testnet") throw new Error(`SatSubscription ${expectedEntrypoint} is not a testnet service`);
  if (!/^0[23][0-9a-f]{64}$/iu.test(value.servicePublicKeyHex)) throw new Error(`SatSubscription ${expectedEntrypoint} returned an invalid service identity`);
  return { network: "testnet", servicePublicKeyHex: value.servicePublicKeyHex.toLowerCase(), entrypoint: expectedEntrypoint };
}

/**
 * 使用浏览器/Node WebSocket 完成最小正式健康握手。
 * 服务端必须回显可验证的 network、servicePublicKeyHex 和 entrypoint；
 * 连接打开本身不能作为“testnet 服务可用”的证据。
 */
export function createWebSocketProbe(options: { readonly timeoutMs?: number } = {}): Pick<SatSubscriptionProbe, "checkWebsocket"> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    checkWebsocket(url, requestId) {
      return new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        let settled = false;
        const finish = (error?: Error, value?: SatSubscriptionProbeHealth) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { socket.close(); } catch { /* already closed */ }
          if (error) reject(error);
          else if (value) resolve(value);
          else reject(new Error("SatSubscription websocket health response is empty"));
        };
        const timer = setTimeout(() => finish(new Error("SatSubscription websocket health check timed out")), timeoutMs);
        socket.addEventListener("open", () => {
          socket.send(JSON.stringify({ type: "health", request_id: requestId, network: "testnet" }));
        });
        socket.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return finish(new Error("SatSubscription health response is not text JSON"));
          try {
            const value: unknown = JSON.parse(event.data);
            if (!value || typeof value !== "object") throw new Error("health response is not an object");
            const item = value as { network?: unknown; servicePublicKeyHex?: unknown; entrypoint?: unknown };
            finish(undefined, {
              network: item.network === "testnet" || item.network === "mainnet" ? item.network : "unknown",
              servicePublicKeyHex: typeof item.servicePublicKeyHex === "string" ? item.servicePublicKeyHex : "",
              entrypoint: item.entrypoint === "websocket" || item.entrypoint === "webrtc-direct" ? item.entrypoint : "unknown",
            });
          } catch (error) {
            finish(error instanceof Error ? error : new Error("SatSubscription health response is invalid"));
          }
        });
        socket.addEventListener("error", () => finish(new Error("SatSubscription websocket is unreachable")));
        socket.addEventListener("close", (event) => {
          if (!settled) finish(new Error(`SatSubscription websocket closed before health response (${event.code})`));
        });
      });
    },
  };
}

export interface SatSubscriptionVerification {
  readonly runId: string;
  readonly websocket: SatSubscriptionHealth;
  readonly webrtcDirect?: SatSubscriptionHealth;
  readonly servicePublicKeyHex: string;
  readonly network: "testnet";
}

/**
 * SatSubscription 双入口 Resource：身份和网络必须由服务运行时证明，不能信任配置文字。
 */
export class SatSubscriptionHealthResource {
  readonly #config: E2ESatSubscriptionConfig;
  readonly #probe: SatSubscriptionProbe;

  constructor(config: E2ESatSubscriptionConfig, probe: SatSubscriptionProbe) {
    this.#config = config;
    this.#probe = probe;
  }

  async verify(runId: string, options: { readonly requireWebrtcDirect?: boolean } = {}): Promise<SatSubscriptionVerification> {
    const safeRunId = assertSafeIdentifier(runId, "run_id");
    const websocket = assertHealth(await this.#probe.checkWebsocket(this.#config.websocket, `${safeRunId}:${randomUUID()}`), "websocket");
    if (this.#config.expectedServicePublicKeyHex && websocket.servicePublicKeyHex !== this.#config.expectedServicePublicKeyHex.toLowerCase()) throw new Error("SatSubscription websocket identity does not match configured expectation");
    let webrtcDirect: SatSubscriptionHealth | undefined;
    if (options.requireWebrtcDirect) {
      webrtcDirect = assertHealth(await this.#probe.checkWebrtcDirect(this.#config.webrtcDirect, `${safeRunId}:${randomUUID()}`), "webrtc-direct");
      if (webrtcDirect.servicePublicKeyHex !== websocket.servicePublicKeyHex) throw new Error("SatSubscription websocket and WebRTC Direct identities differ");
    }
    return { runId: safeRunId, websocket, ...(webrtcDirect === undefined ? {} : { webrtcDirect }), servicePublicKeyHex: websocket.servicePublicKeyHex, network: "testnet" };
  }
}
