// MSFile 跨插件内容能力的生产装配。
//
// 远程获取复用 MSFile 既有的 BitFS 买方通道：`publishBitfsDemand` 发布需求 →
// `getBitfsDemand` 等报价 → 按用户价格上限选已验签报价 → `startBitfsPurchase`
// 执行购买 → 轮询到 `completed`，此时内容已经由 MSFile 写入 msfiles。这里不建立
// 第二套传输，也不自己决定价格：金额策略属于既有 MSFile 设置。
//
// 价格上限的作用：默认不付费（`maxFullBlockPriceSatoshis: "0"`），只有用户明确
// 打开阅读/重试时才由调用方传入上限；没有上限时不会自动购买正文。
//
// 三条不能违反的规则：
//   - 报价是**异步**到的：发布需求的那一次快照通常还没有卖家，因此必须轮询
//     `getBitfsDemand` 而不是只看一次；只看一次会把「还没人报价」误报成不可达；
//   - `startBitfsPurchase` 返回的是**当前购买进度**，不是终态：只检查一次
//     `completed` 会把刚开始的购买误报成失败；
//   - 不要求 `stat` 里已经有 available/quoted 来源：需求发现本身就是获取途径，
//     要求先有来源会让「需要靠发布需求找到卖家」的场景永远走不通。

import type {
  MsFileBitfsDemandSnapshot,
  MsFileBitfsPurchasePhase,
  MsFileBitfsQuoteView,
  MsFileContentEnsureInput,
  MsFileService,
} from "@keymaster/contracts";
import { MSFILE_LOCAL_SOURCE_ID, msFileRemoteSourceId, normalizeMsFileSatoshiAmount } from "@keymaster/contracts";

import type { MsFileRemoteContentFetcher } from "./msfileContentService.js";

export interface MsFileRemoteContentFetcherDeps {
  service: Pick<
    MsFileService,
    "status" | "stat" | "publishBitfsDemand" | "getBitfsDemand" | "startBitfsPurchase" | "getBitfsBuyerSettings" | "cancelBitfsPurchase"
  >;
  /** 观察内容状态变化，用于把购买结果并入共享任务。 */
  onProgress?(seedHashHex: string, note: string): void;
  /** 等待一轮报价的上限；超时按「暂时没有报价」如实报告，不当成不可达。 */
  quoteWaitMs?: number;
  /** 等待购买走到终态的上限。 */
  purchaseWaitMs?: number;
  /** 轮询间隔；测试可调小。 */
  pollIntervalMs?: number;
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
}

/** 没有报价时的等待上限：短到不占用页面，长到足以等一个卖家回应。 */
const DEFAULT_QUOTE_WAIT_MS = 20_000;
/** 购买走完「开池 → 请求块 → 写入 → 关池」需要的时间上限。 */
const DEFAULT_PURCHASE_WAIT_MS = 180_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

/** 购买终态：只有这两种不再是「进行中」。 */
const TERMINAL_PURCHASE_PHASES: ReadonlySet<MsFileBitfsPurchasePhase> = new Set<MsFileBitfsPurchasePhase>([
  "completed",
  "failed",
  "cancelled",
  "refunded",
]);

/**
 * 构造生产装配用的远程获取器。
 *
 * 缺能力时如实返回不可用：`publishBitfsDemand`/`startBitfsPurchase` 是可选方法，
 * 缺席意味着该服务还没有 BitFS 买方流程，此时不能假装能取到内容。
 */
export function createMsFileRemoteContentFetcher(
  deps: MsFileRemoteContentFetcherDeps,
): MsFileRemoteContentFetcher {
  const service = deps.service;
  const quoteWaitMs = deps.quoteWaitMs ?? DEFAULT_QUOTE_WAIT_MS;
  const purchaseWaitMs = deps.purchaseWaitMs ?? DEFAULT_PURCHASE_WAIT_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = deps.sleep ?? defaultSleep;

  return {
    listSourceIds(): readonly string[] {
      // 来源清单由 MSFile 自己回答；这里不维护第二份副本。
      // 只列本地来源是**如实**的：BitFS 买方通道是获取路径，不是发布渠道，
      // 它不能证明「别的读者能取得这份内容」。
      return [MSFILE_LOCAL_SOURCE_ID];
    },

    async fetch(input: { seedHashHex: string; allowPurchase: boolean; signal?: AbortSignal }): Promise<boolean> {
      if (service.publishBitfsDemand === undefined || service.startBitfsPurchase === undefined) {
        // 没有买方流程：如实让上层报「无可用渠道」。
        return false;
      }

      // 1. 没有明确授权就不购买：列表浏览不得自动触发付费获取。
      if (!input.allowPurchase) return false;

      // 2. 价格上限取自 MSFile 的买方设置；上限为 0 表示不允许付费。
      const settings = await service.getBitfsBuyerSettings?.();
      const cap = normalizeMsFileSatoshiAmount(settings?.maxFullBlockPriceSatoshis ?? "0");
      if (cap === undefined || cap === "0") {
        deps.onProgress?.(input.seedHashHex, "价格上限为 0，未购买");
        return false;
      }

      // 3. 发布需求，然后**等待**已验签报价到达。发布需求本身也可能带来即时报价，
      //    所以先看这一次快照，再进入轮询，而不是直接判失败。
      const initial = await service.publishBitfsDemand(input.seedHashHex);
      const quoteWaitDeadline = Date.now() + quoteWaitMs;
      let snapshot = initial;
      let chosen = selectQuote(snapshot.quotes, cap);
      while (chosen === undefined && Date.now() < quoteWaitDeadline) {
        if (input.signal?.aborted === true) return false;
        await sleep(pollIntervalMs, input.signal);
        const next = service.getBitfsDemand === undefined ? undefined : await service.getBitfsDemand(input.seedHashHex);
        if (next === undefined) break;
        snapshot = next;
        chosen = selectQuote(next.quotes, cap);
      }
      if (chosen === undefined) {
        deps.onProgress?.(
          input.seedHashHex,
          describeMissingQuote(snapshot.quotes, cap),
        );
        return false;
      }

      // 4. 执行购买。返回的是**当前进度**：必须轮询到终态才算成功。
      let purchase = await service.startBitfsPurchase(input.seedHashHex, chosen.sessionId, cap);
      const purchaseDeadline = Date.now() + purchaseWaitMs;
      while (!isTerminalPhase(purchase.purchase?.phase)) {
        if (input.signal?.aborted === true) return false;
        if (Date.now() >= purchaseDeadline) {
          deps.onProgress?.(input.seedHashHex, `购买未在等待上限内到达终态（${purchase.purchase?.phase ?? "unknown"}）`);
          return false;
        }
        await sleep(pollIntervalMs, input.signal);
        const next = service.getBitfsDemand === undefined ? undefined : await service.getBitfsDemand(input.seedHashHex);
        if (next === undefined) {
          deps.onProgress?.(input.seedHashHex, "无法读取购买进度");
          return false;
        }
        purchase = next;
        deps.onProgress?.(input.seedHashHex, `购买阶段 ${purchase.purchase?.phase ?? "unknown"}`);
      }
      deps.onProgress?.(input.seedHashHex, `购买终态 ${purchase.purchase?.phase ?? "unknown"}`);
      return purchase.purchase?.phase === "completed";
    },
  };
}

/** 选一条落在价格上限内的报价；同价时保持服务端顺序。 */
function selectQuote(
  quotes: readonly MsFileBitfsQuoteView[] | undefined,
  cap: string,
): MsFileBitfsQuoteView | undefined {
  const affordable = (quotes ?? [])
    .filter((quote) => {
      const price = normalizeMsFileSatoshiAmount(quote.fullBlockPriceSatoshis);
      return price !== undefined && price !== "0" && BigInt(price) <= BigInt(cap);
    })
    .sort((left, right) => {
      const leftPrice = BigInt(normalizeMsFileSatoshiAmount(left.fullBlockPriceSatoshis) ?? "0");
      const rightPrice = BigInt(normalizeMsFileSatoshiAmount(right.fullBlockPriceSatoshis) ?? "0");
      return leftPrice === rightPrice ? 0 : leftPrice < rightPrice ? -1 : 1;
    });
  return affordable[0];
}

/** 没有可选报价时给出稳定区分：有报价但超价，和根本没报价不是一回事。 */
function describeMissingQuote(quotes: readonly MsFileBitfsQuoteView[] | undefined, cap: string): string {
  const received = quotes?.length ?? 0;
  if (received === 0) return `等待 ${cap} sat 上限内没有收到报价`;
  return `收到的 ${received} 条报价都高于价格上限 ${cap}`;
}

function isTerminalPhase(phase: MsFileBitfsPurchasePhase | undefined): boolean {
  return phase !== undefined && TERMINAL_PURCHASE_PHASES.has(phase);
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
export type { MsFileContentEnsureInput, MsFileBitfsDemandSnapshot };