// MSFile 跨插件内容能力的生产装配。
//
// 远程获取复用 MSFile 既有的 BitFS 买方通道：`stat` 找来源 → 发布需求拿报价 →
// 用已验签报价执行购买 → 购买完成时内容已经由 BitFS 提交进 msfiles。这里不建立
// 第二套传输，也不自己决定价格：金额策略属于既有 MSFile 设置。
//
// 价格上限的作用：默认不付费（`maxFullBlockPriceSatoshis: "0"`），只有用户明确
// 打开阅读/重试时才由调用方传入上限；没有上限时不会自动购买正文。

import type {
  MsFileBitfsQuoteView,
  MsFileContentEnsureInput,
  MsFileService,
} from "@keymaster/contracts";
import { MSFILE_LOCAL_SOURCE_ID, msFileRemoteSourceId, normalizeMsFileSatoshiAmount } from "@keymaster/contracts";

import type { MsFileRemoteContentFetcher } from "./msfileContentService.js";

export interface MsFileRemoteContentFetcherDeps {
  service: Pick<
    MsFileService,
    "status" | "stat" | "publishBitfsDemand" | "getBitfsDemand" | "startBitfsPurchase" | "getBitfsBuyerSettings"
  >;
  /** 观察内容状态变化，用于把购买结果并入共享任务。 */
  onProgress?(seedHashHex: string, note: string): void;
}

/**
 * 构造生产装配用的远程获取器。
 *
 * 缺能力时如实返回不可用：`publishBitfsDemand`/`startBitfsPurchase` 是可选方法，
 * 缺席意味着该服务还没有 BitFS 买方流程，此时不能假装能取到内容。
 */
export function createMsFileRemoteContentFetcher(
  deps: MsFileRemoteContentFetcherDeps,
): MsFileRemoteContentFetcher {
  return {
    listSourceIds(): readonly string[] {
      // 来源清单由 MSFile 自己回答；这里不维护第二份副本。
      return [MSFILE_LOCAL_SOURCE_ID];
    },

    async fetch(input: { seedHashHex: string; allowPurchase: boolean; signal?: AbortSignal }): Promise<boolean> {
      const service = deps.service;
      if (service.publishBitfsDemand === undefined || service.startBitfsPurchase === undefined) {
        // 没有买方流程：如实让上层报「无可用渠道」。
        return false;
      }
      // 1. 先看本地/远端有没有这个 hash 的来源；这一步不付钱。
      const stat = await service.stat({ seedHashHex: input.seedHashHex, ...(input.signal ? { signal: input.signal } : {}) });
      const available = stat.sources.filter(
        (source) => source.status === "available" || source.status === "quoted",
      );
      if (available.length === 0) return false;

      // 2. 没有明确授权就不购买：列表浏览不得自动触发付费获取。
      if (!input.allowPurchase) return false;

      // 3. 发布需求并取已验签报价。
      // 需求快照上的 `availableQuotes` 是可选的：没有它就只能发布需求再等一轮报价。
      const demand = await service.publishBitfsDemand(input.seedHashHex);
      const quotes: readonly MsFileBitfsQuoteView[] = demand.quotes ?? [];
      if (quotes.length === 0) return false;

      // 4. 价格上限取自 MSFile 的买方设置；上限为 0 表示不允许付费。
      const settings = await service.getBitfsBuyerSettings?.();
      const cap = normalizeMsFileSatoshiAmount(settings?.maxFullBlockPriceSatoshis ?? "0");
      if (cap === undefined || cap === "0") {
        deps.onProgress?.(input.seedHashHex, "价格上限为 0，未购买");
        return false;
      }
      // 报价里给的是完整 Block 的单价；用它与买方上限比较，价格降序取最便宜的一家。
      const affordable = quotes
        .filter((quote) => {
          const price = normalizeMsFileSatoshiAmount(quote.fullBlockPriceSatoshis);
          return price !== undefined && price !== "0" && BigInt(price) <= BigInt(cap);
        })
        .sort((left, right) => {
          const leftPrice = BigInt(normalizeMsFileSatoshiAmount(left.fullBlockPriceSatoshis) ?? "0");
          const rightPrice = BigInt(normalizeMsFileSatoshiAmount(right.fullBlockPriceSatoshis) ?? "0");
          return leftPrice === rightPrice ? 0 : leftPrice < rightPrice ? -1 : 1;
        });
      const chosen = affordable[0];
      if (chosen === undefined) {
        deps.onProgress?.(input.seedHashHex, "没有报价落在价格上限内");
        return false;
      }

      // 5. 执行购买。购买完成时内容已经写进 msfiles。
      const purchase = await service.startBitfsPurchase(input.seedHashHex, chosen.sessionId, cap);
      // 买入流程的状态在 purchase 子视图里；完成后 MSFile 已把内容提交进本地。
      const phase = purchase.purchase?.phase;
      deps.onProgress?.(input.seedHashHex, `购买阶段 ${phase ?? "unknown"}`);
      return phase === "completed";
    },
  };
}

/** 供诊断用：把来源清单与状态摘要成一行文本。 */
export function describeMsFileSources(
  result: Awaited<ReturnType<MsFileService["stat"]>>,
): string {
  return result.sources
    .map((source) => {
      const id = "supplierPublicKeyHex" in source ? source.supplierPublicKeyHex : source.sourceId;
      return `${id}:${source.status}`;
    })
    .join(", ");
}

export { msFileRemoteSourceId };
export type { MsFileContentEnsureInput };