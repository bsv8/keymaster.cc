// packages/plugin-woc/src/wocService.ts
// WOC service：业务插件唯一依赖的 WOC 入口。
//
// 设计缘由：
//   - 内部不直接维护队列 / 限流 / 429 backoff / Web Locks 协调；
//     全部由 wocActor 通过 MessageBus 统一处理。
//   - wocService 的 public API 保持不变；每个 endpoint 内部通过
//     messageBus.request("woc.*", payload, { target: "woc", ... })
//     把请求投递给 actor mailbox。
//   - snapshot / config / dispose 委托给 actor。
//   - 业务插件禁止直接发 "woc.*" 消息；必须通过 WocService。
//   - 默认 baseUrl + requestsPerSecond 仍由 wocSettings 持久化。
//   - 阶段 2：CreateWocServiceOptions.messageBus 强制必填；manifest 必须
//     传 runtime messageBus。WocServiceHandle 不再暴露 messageBus，避免
//     业务插件绕过 WocService 直接发 woc.* 消息。

import type {
  BsvNetwork,
  MessageBus,
  WocBalanceResponse,
  WocBroadcastResult,
  WocConfig,
  WocHistoryPage,
  WocQueueSnapshot,
  WocRequestOptions,
  WocService,
  WocUnconfirmedHistory,
  WocUtxoResponse
} from "@keymaster/contracts";
import { WOC_PRIORITY } from "@keymaster/contracts";
import { createWocActor, type WocActorHandle } from "./wocActor.js";
import {
  WOC_MSG,
  type WocBalancePayload,
  type WocBroadcastPayload,
  type WocHistoryPayload,
  type WocUtxosPayload
} from "./wocMessages.js";

export interface WocServiceHandle extends WocService {
  /** 停止调度器(用于测试)。 */
  dispose(): void;
}

export interface CreateWocServiceOptions {
  /**
   * 必填：actor 挂载的 messageBus。
   * 生产环境必须传 runtime messageBus；测试场景用 createMessageBus() 显式传入。
   * 不传时 createWocService 立即抛错，避免误用。
   */
  messageBus: MessageBus;
}

export function createWocService(options: CreateWocServiceOptions): WocServiceHandle {
  if (!options || !options.messageBus) {
    throw new Error("createWocService: messageBus is required");
  }
  const messageBus: MessageBus = options.messageBus;
  const actor: WocActorHandle = createWocActor();
  actor.attach(messageBus);

  function priorityOf(p?: WocRequestOptions["priority"]): number {
    return WOC_PRIORITY[p ?? "background"];
  }

  function dispatchOptions(opts?: WocRequestOptions) {
    return {
      target: "woc" as const,
      priority: priorityOf(opts?.priority),
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs
    };
  }

  return {
    getConfig: () => actor.getConfig(),
    updateConfig: (input) => actor.updateConfig(input),
    onConfigChange: (h) => actor.onConfigChange(h),
    getQueueSnapshot: () => actor.getQueueSnapshot(),
    onQueueChange: (h) => actor.onQueueChange(h),

    async getAddressConfirmedBalance(
      network: BsvNetwork,
      address: string,
      opts?: WocRequestOptions
    ): Promise<WocBalanceResponse> {
      const payload: WocBalancePayload = {
        network,
        address,
        priority: opts?.priority ?? "background",
        signal: opts?.signal,
        timeoutMs: opts?.timeoutMs
      };
      return messageBus.request<WocBalancePayload, WocBalanceResponse>(
        WOC_MSG.BALANCE_CONFIRMED,
        payload,
        dispatchOptions(opts)
      );
    },

    async getAddressUnconfirmedBalance(
      network: BsvNetwork,
      address: string,
      opts?: WocRequestOptions
    ): Promise<WocBalanceResponse> {
      const payload: WocBalancePayload = {
        network,
        address,
        priority: opts?.priority ?? "background",
        signal: opts?.signal,
        timeoutMs: opts?.timeoutMs
      };
      return messageBus.request<WocBalancePayload, WocBalanceResponse>(
        WOC_MSG.BALANCE_UNCONFIRMED,
        payload,
        dispatchOptions(opts)
      );
    },

    async getAddressConfirmedUtxos(
      network: BsvNetwork,
      address: string,
      opts?: WocRequestOptions
    ): Promise<WocUtxoResponse[]> {
      const payload: WocUtxosPayload = {
        network,
        address,
        priority: opts?.priority ?? "background",
        signal: opts?.signal,
        timeoutMs: opts?.timeoutMs
      };
      return messageBus.request<WocUtxosPayload, WocUtxoResponse[]>(
        WOC_MSG.UTXOS_CONFIRMED,
        payload,
        dispatchOptions(opts)
      );
    },

    async getAddressUnconfirmedUtxos(
      network: BsvNetwork,
      address: string,
      opts?: WocRequestOptions
    ): Promise<WocUtxoResponse[]> {
      const payload: WocUtxosPayload = {
        network,
        address,
        priority: opts?.priority ?? "background",
        signal: opts?.signal,
        timeoutMs: opts?.timeoutMs
      };
      return messageBus.request<WocUtxosPayload, WocUtxoResponse[]>(
        WOC_MSG.UTXOS_UNCONFIRMED,
        payload,
        dispatchOptions(opts)
      );
    },

    async getAddressesConfirmedBalances(
      network: BsvNetwork,
      addresses: string[],
      opts?: WocRequestOptions
    ): Promise<WocBalanceResponse[]> {
      return Promise.all(addresses.map((a) => this.getAddressConfirmedBalance(network, a, opts)));
    },
    async getAddressesUnconfirmedBalances(
      network: BsvNetwork,
      addresses: string[],
      opts?: WocRequestOptions
    ): Promise<WocBalanceResponse[]> {
      return Promise.all(addresses.map((a) => this.getAddressUnconfirmedBalance(network, a, opts)));
    },
    async getAddressesConfirmedUtxos(
      network: BsvNetwork,
      addresses: string[],
      opts?: WocRequestOptions
    ): Promise<WocUtxoResponse[]> {
      const results = await Promise.allSettled(addresses.map((a) => this.getAddressConfirmedUtxos(network, a, opts)));
      return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    },
    async getAddressesUnconfirmedUtxos(
      network: BsvNetwork,
      addresses: string[],
      opts?: WocRequestOptions
    ): Promise<WocUtxoResponse[]> {
      const results = await Promise.allSettled(addresses.map((a) => this.getAddressUnconfirmedUtxos(network, a, opts)));
      return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    },

    async listAddressConfirmedHistory(
      network: BsvNetwork,
      address: string,
      page: { limit?: number; page?: number; nextPageToken?: string } | undefined,
      opts?: WocRequestOptions
    ): Promise<WocHistoryPage> {
      const payload: WocHistoryPayload = {
        network,
        address,
        page,
        priority: opts?.priority ?? "background",
        signal: opts?.signal,
        timeoutMs: opts?.timeoutMs
      };
      return messageBus.request<WocHistoryPayload, WocHistoryPage>(
        WOC_MSG.HISTORY_CONFIRMED,
        payload,
        dispatchOptions(opts)
      );
    },

    async listAddressUnconfirmedHistory(
      network: BsvNetwork,
      address: string,
      opts?: WocRequestOptions
    ): Promise<WocUnconfirmedHistory> {
      const payload: WocHistoryPayload = {
        network,
        address,
        priority: opts?.priority ?? "background",
        signal: opts?.signal,
        timeoutMs: opts?.timeoutMs
      };
      return messageBus.request<WocHistoryPayload, WocUnconfirmedHistory>(
        WOC_MSG.HISTORY_UNCONFIRMED,
        payload,
        dispatchOptions(opts)
      );
    },

    async listAddressesHistory(
      network: BsvNetwork,
      addresses: string[],
      page: { limit?: number; page?: number; nextPageToken?: string } | undefined,
      opts?: WocRequestOptions
    ): Promise<WocHistoryPage> {
      const results = await Promise.allSettled(
        addresses.map((a) => this.listAddressConfirmedHistory(network, a, page, opts))
      );
      const items = results.flatMap((r) => (r.status === "fulfilled" ? r.value.items : []));
      const tokens = results.map((r) => (r.status === "fulfilled" ? r.value.nextPageToken : undefined));
      const nextPageToken = tokens.find((t): t is string => typeof t === "string" && t.length > 0);
      return { items, nextPageToken };
    },

    async broadcast(
      network: BsvNetwork,
      rawTxHex: string,
      opts?: Omit<WocRequestOptions, "priority">
    ): Promise<WocBroadcastResult> {
      const payload: WocBroadcastPayload = {
        network,
        rawTxHex,
        signal: opts?.signal,
        timeoutMs: opts?.timeoutMs
      };
      // broadcast 优先级内部强制为 broadcast，调用方不能降级。
      return messageBus.request<WocBroadcastPayload, WocBroadcastResult>(
        WOC_MSG.TX_BROADCAST,
        payload,
        {
          target: "woc",
          priority: WOC_PRIORITY.broadcast,
          signal: opts?.signal,
          timeoutMs: opts?.timeoutMs
        }
      );
    },

    dispose() {
      actor.dispose();
    }
  };
}
