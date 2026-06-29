// packages/plugin-woc/src/wocBsv21Service.ts
// BSV-21 WOC service：业务插件（plugin-token-bsv21）调用的唯一 BSV-21
// 查询入口。
//
// 设计缘由：
//   - 业务插件禁止越过本 service 直接 fetch WOC；URL 拼接、限流、429
//     backoff、多标签页协调全部由 actor 承担，本 service 只做"按 WOC
//     payload 投递请求、解析结果"。
//   - service 不持自己的 messageBus / actor；与 wocService 共享同一个
//     actor（plugin-woc manifest 在 setup 时创建并 attach）。

import type {
  BsvNetwork,
  MessageBus,
  PluginLogger,
  WocBsv21BalanceResponse,
  WocBsv21Service,
  WocBsv21TokenMeta,
  WocRequestOptions
} from "@keymaster/contracts";
import { WOC_PRIORITY } from "@keymaster/contracts";
import {
  WOC_MSG,
  type WocBsv21ListTokensPayload,
  type WocBsv21TokenBalancePayload
} from "./wocMessages.js";

export interface WocBsv21ServiceHandle extends WocBsv21Service {
  /** 测试/host teardown 用。 */
  dispose(): void;
}

export interface CreateWocBsv21ServiceOptions {
  messageBus: MessageBus;
  logger?: PluginLogger;
}

export function createWocBsv21Service(options: CreateWocBsv21ServiceOptions): WocBsv21ServiceHandle {
  if (!options || !options.messageBus) {
    throw new Error("createWocBsv21Service: messageBus is required");
  }
  const messageBus: MessageBus = options.messageBus;
  const logger = options.logger;

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
    async listAddressTokens(
      network: BsvNetwork,
      address: string,
      opts?: WocRequestOptions
    ): Promise<WocBsv21TokenMeta[]> {
      const payload: WocBsv21ListTokensPayload = {
        network,
        address,
        priority: opts?.priority ?? "background",
        signal: opts?.signal,
        timeoutMs: opts?.timeoutMs
      };
      return messageBus.request(WOC_MSG.BSV21_LIST_TOKENS, payload, dispatchOptions(opts));
    },

    async getAddressTokenBalance(
      network: BsvNetwork,
      address: string,
      origin: string,
      opts?: WocRequestOptions
    ): Promise<WocBsv21BalanceResponse> {
      const payload: WocBsv21TokenBalancePayload = {
        network,
        address,
        origin,
        priority: opts?.priority ?? "background",
        signal: opts?.signal,
        timeoutMs: opts?.timeoutMs
      };
      return messageBus.request(WOC_MSG.BSV21_TOKEN_BALANCE, payload, dispatchOptions(opts));
    },

    dispose() {
      // 共享 actor：本 service 不持 actor 句柄；actor 生命周期由
      // createWocService 持有并随 plugin-woc teardown 一起 dispose。
      logger?.debug({
        scope: "woc.bsv21",
        event: "service.disposed",
        message: "woc.bsv21.service disposed"
      });
    }
  };
}