// packages/plugin-woc/src/woc1SatOrdinalsService.ts
// 1Sat Ordinals WOC service：业务插件（plugin-collectible-1satordinals）
// 调用的唯一 1Sat 查询入口。
//
// 设计缘由同 wocBsv21Service：业务插件禁止直接 fetch WOC。
//
// 关键不变量：getOutpointInscription 在 WOC 404 / not-found 时返回 null，
// 不抛错；调用方把 null 翻译为"这个 outpoint 不是 1Sat collectible"，
// 不应记成 provider 错误。

import type {
  BsvNetwork,
  MessageBus,
  PluginLogger,
  Woc1SatOrdinalsInscription,
  Woc1SatOrdinalsService,
  WocRequestOptions
} from "@keymaster/contracts";
import { WOC_PRIORITY } from "@keymaster/contracts";
import { WOC_MSG, type Woc1SatOutpointPayload } from "./wocMessages.js";

export interface Woc1SatOrdinalsServiceHandle extends Woc1SatOrdinalsService {
  dispose(): void;
}

export interface CreateWoc1SatOrdinalsServiceOptions {
  messageBus: MessageBus;
  logger?: PluginLogger;
}

export function createWoc1SatOrdinalsService(
  options: CreateWoc1SatOrdinalsServiceOptions
): Woc1SatOrdinalsServiceHandle {
  if (!options || !options.messageBus) {
    throw new Error("createWoc1SatOrdinalsService: messageBus is required");
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
    async getOutpointInscription(
      network: BsvNetwork,
      outpoint: string,
      opts?: WocRequestOptions
    ): Promise<Woc1SatOrdinalsInscription | null> {
      const payload: Woc1SatOutpointPayload = {
        network,
        outpoint,
        priority: opts?.priority ?? "background",
        signal: opts?.signal,
        timeoutMs: opts?.timeoutMs
      };
      return messageBus.request(WOC_MSG.ONE_SAT_OUTPOINT, payload, dispatchOptions(opts));
    },

    dispose() {
      logger?.debug({
        scope: "woc.1sat",
        event: "service.disposed",
        message: "woc.1satordinals.service disposed"
      });
    }
  };
}