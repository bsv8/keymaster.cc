// packages/plugin-woc/src/wocStasService.ts
// STAS WOC service：业务插件（plugin-token-stas）调用的唯一 STAS 查询入口。
//
// 设计缘由同 wocBsv21Service：业务插件禁止直接 fetch WOC。

import type {
  BsvNetwork,
  MessageBus,
  PluginLogger,
  WocRequestOptions,
  WocStasService,
  WocStasTokenEntry
} from "@keymaster/contracts";
import { WOC_PRIORITY } from "@keymaster/contracts";
import { WOC_MSG, type WocStasListTokensPayload } from "./wocMessages.js";

export interface WocStasServiceHandle extends WocStasService {
  dispose(): void;
}

export interface CreateWocStasServiceOptions {
  messageBus: MessageBus;
  logger?: PluginLogger;
}

export function createWocStasService(options: CreateWocStasServiceOptions): WocStasServiceHandle {
  if (!options || !options.messageBus) {
    throw new Error("createWocStasService: messageBus is required");
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
    ): Promise<WocStasTokenEntry[]> {
      const payload: WocStasListTokensPayload = {
        network,
        address,
        priority: opts?.priority ?? "background",
        signal: opts?.signal,
        timeoutMs: opts?.timeoutMs
      };
      return messageBus.request(WOC_MSG.STAS_LIST_TOKENS, payload, dispatchOptions(opts));
    },

    dispose() {
      logger?.debug({
        scope: "woc.stas",
        event: "service.disposed",
        message: "woc.stas.service disposed"
      });
    }
  };
}