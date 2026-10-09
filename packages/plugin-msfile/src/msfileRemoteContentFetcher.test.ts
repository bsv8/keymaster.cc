// 远程内容获取的等待纪律。
//
// 这里盯的是三个曾经会误报的点：
//   - 报价是异步到的：只看发布需求那一次快照会把「暂时没人报价」当成不可达；
//   - 购买返回的是当前进度：只检查一次 completed 会把刚开始的购买当成失败；
//   - 不要求 stat 里已经有可用来源：需求发现本身就是获取途径。

import { describe, expect, it, vi } from "vitest";

import type {
  MsFileBitfsDemandSnapshot,
  MsFileBitfsPurchasePhase,
  MsFileBitfsQuoteView,
  MsFileService,
} from "@keymaster/contracts";

import { MSFILE_LOCAL_SOURCE_ID } from "@keymaster/contracts";

import { createMsFileRemoteContentFetcher } from "./msfileRemoteContentFetcher.js";

const SEED = "ab".repeat(32);

function quote(input: { sessionId: string; price: string }): MsFileBitfsQuoteView {
  return {
    sessionId: input.sessionId,
    seedHashHex: SEED,
    fileSizeBytes: "1024",
    sellerPublicKeyHex: "02".padEnd(66, "a"),
    seedPriceSatoshis: "1",
    fullBlockPriceSatoshis: input.price,
    quoteExpiresAtUnixSeconds: "1800000000",
    recommendedFilename: "post.md",
    supportedArbiterPublicKeys: [],
  };
}

function demand(input: {
  quotes?: MsFileBitfsQuoteView[];
  phase?: MsFileBitfsPurchasePhase;
  requestMessageId?: string | null;
}): MsFileBitfsDemandSnapshot {
  return {
    seedHashHex: SEED,
    requestMessageId: input.requestMessageId ?? "msg-1",
    expiresAtMs: Date.now() + 60_000,
    quotes: input.quotes ?? [],
    purchase: input.phase === undefined ? null : { phase: input.phase, ...(input.phase === "completed" ? { verifiedBytes: "1024" } : {}) } as MsFileBitfsDemandSnapshot["purchase"],
  };
}

interface Script {
  onPublish: number;
  onPurchase: number;
  polls: number;
}

/**
 * 用**同一条快照序列**驱动 `getBitfsDemand`。
 *
 * 真实装配里报价与购买进度都从这一个快照读出来，所以这里也用一条序列：先给
 * 陆续到达的报价，再给购买阶段的推进。这样「等待」与「只检查一次」的差别才会
 * 真的被测到。
 */
function harness(input: {
  published: MsFileBitfsDemandSnapshot;
  polls: readonly MsFileBitfsDemandSnapshot[];
  cap?: string;
}): { fetcher: ReturnType<typeof createMsFileRemoteContentFetcher>; script: Script } {
  let pollIndex = 0;
  const script: Script = { onPublish: 0, onPurchase: 0, polls: 0 };
  const service = {
    status: async () => ({ available: true, state: "fresh", syncedAt: "t", items: [] }),
    async stat() {
      return { seedHashHex: SEED, sources: [] };
    },
    async publishBitfsDemand() {
      script.onPublish += 1;
      return input.published;
    },
    async getBitfsDemand() {
      script.polls += 1;
      return input.polls[Math.min(pollIndex++, input.polls.length - 1)] as MsFileBitfsDemandSnapshot;
    },
    async startBitfsPurchase() {
      script.onPurchase += 1;
      return input.published;
    },
    async getBitfsBuyerSettings() {
      return { maxFullBlockPriceSatoshis: input.cap ?? "100" };
    },
  } as unknown as Pick<
    MsFileService,
    "status" | "stat" | "publishBitfsDemand" | "getBitfsDemand" | "startBitfsPurchase" | "getBitfsBuyerSettings"
  >;
  return {
    script,
    fetcher: createMsFileRemoteContentFetcher({
      service,
      quoteWaitMs: 5_000,
      purchaseWaitMs: 5_000,
      pollIntervalMs: 0,
      sleep: async () => undefined,
      onProgress: vi.fn(),
    }),
  };
}

describe("远程内容获取的等待纪律", () => {
  it("等待异步到达的报价，而不是只看发布需求那一次快照", async () => {
    const quotes = [quote({ sessionId: "s1", price: "50" })];
    const { fetcher, script } = harness({
      // 发布需求那一刻还没有任何报价；报价在后续轮询里才到。
      published: demand({ quotes: [] }),
      polls: [demand({ quotes }), demand({ phase: "completed", quotes })],
    });
    await expect(fetcher.fetch({ seedHashHex: SEED, allowPurchase: true })).resolves.toBe(true);
    // 关键是「等到了」：至少发生过一次轮询。
    expect(script.polls).toBeGreaterThan(0);
    expect(script.onPurchase).toBe(1);
  });

  it("等待购买走到 completed，而不是把开始购买当成失败", async () => {
    const quotes = [quote({ sessionId: "s1", price: "50" })];
    const { fetcher, script } = harness({
      published: demand({ quotes }),
      polls: [
        demand({ phase: "funding", quotes }),
        demand({ phase: "requesting-blocks", quotes }),
        demand({ phase: "content-committing", quotes }),
        demand({ phase: "completed", quotes }),
      ],
    });
    await expect(fetcher.fetch({ seedHashHex: SEED, allowPurchase: true })).resolves.toBe(true);
    // 报价立刻就有，所以这 4 次轮询全部花在等购买终态上：funding → 取块 →
    // 写入 → completed。只看 startBitfsPurchase 的返回值会在这里误报失败。
    expect(script.polls).toBe(4);
  });

  it("购买进入失败终态时如实报失败", async () => {
    const quotes = [quote({ sessionId: "s1", price: "50" })];
    const { fetcher } = harness({
      published: demand({ quotes }),
      polls: [demand({ phase: "funding", quotes }), demand({ phase: "failed", quotes })],
    });
    await expect(fetcher.fetch({ seedHashHex: SEED, allowPurchase: true })).resolves.toBe(false);
  });

  it("等待上限内没有终态时如实报失败", async () => {
    const quotes = [quote({ sessionId: "s1", price: "50" })];
    const impatient = createMsFileRemoteContentFetcher({
      service: {
        status: async () => ({ available: true, state: "fresh", syncedAt: "t", items: [] }),
        async stat() {
          return { seedHashHex: SEED, sources: [] };
        },
        async publishBitfsDemand() {
          return demand({ quotes });
        },
        async getBitfsDemand() {
          return demand({ phase: "requesting-blocks", quotes });
        },
        async startBitfsPurchase() {
          return demand({ phase: "requesting-blocks", quotes });
        },
        async getBitfsBuyerSettings() {
          return { maxFullBlockPriceSatoshis: "100" };
        },
      } as unknown as Pick<
        MsFileService,
        "status" | "stat" | "publishBitfsDemand" | "getBitfsDemand" | "startBitfsPurchase" | "getBitfsBuyerSettings"
      >,
      // 上限为 0 表示不给等待时间：第一轮轮询后就判定未到终态。
      quoteWaitMs: 0,
      purchaseWaitMs: 0,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });
    await expect(impatient.fetch({ seedHashHex: SEED, allowPurchase: true })).resolves.toBe(false);
  });

  it("不要求 stat 里已经有可用来源", async () => {
    // 需求发现本身就是获取途径：stat 一个来源都没有时也必须走需求流程。
    const quotes = [quote({ sessionId: "s1", price: "50" })];
    const { fetcher, script } = harness({
      published: demand({ quotes }),
      polls: [demand({ phase: "completed", quotes })],
    });
    await expect(fetcher.fetch({ seedHashHex: SEED, allowPurchase: true })).resolves.toBe(true);
    expect(script.onPublish).toBe(1);
  });

  it("没有授权购买时不发布需求", async () => {
    const quotes = [quote({ sessionId: "s1", price: "50" })];
    const { fetcher, script } = harness({ published: demand({ quotes }), polls: [demand({ phase: "completed", quotes })] });
    await expect(fetcher.fetch({ seedHashHex: SEED, allowPurchase: false })).resolves.toBe(false);
    expect(script.onPublish).toBe(0);
    expect(script.onPurchase).toBe(0);
  });

  it("价格上限为 0 时不购买", async () => {
    const quotes = [quote({ sessionId: "s1", price: "1" })];
    const { fetcher, script } = harness({
      cap: "0",
      published: demand({ quotes }),
      polls: [demand({ phase: "completed", quotes })],
    });
    await expect(fetcher.fetch({ seedHashHex: SEED, allowPurchase: true })).resolves.toBe(false);
    expect(script.onPurchase).toBe(0);
  });

  it("报价高于上限时不购买", async () => {
    const quotes = [quote({ sessionId: "s1", price: "5000" })];
    const { fetcher, script } = harness({
      cap: "100",
      published: demand({ quotes }),
      polls: [demand({ phase: "completed", quotes })],
    });
    await expect(fetcher.fetch({ seedHashHex: SEED, allowPurchase: true })).resolves.toBe(false);
    expect(script.onPurchase).toBe(0);
  });

  it("缺买方能力时如实报不可用", async () => {
    const fetcher = createMsFileRemoteContentFetcher({
      service: {
        status: async () => ({ available: false, state: "unavailable", syncedAt: "t", items: [] }),
        async stat() {
          return { seedHashHex: SEED, sources: [] };
        },
      } as unknown as Pick<MsFileService, "status" | "stat" | "publishBitfsDemand" | "getBitfsDemand" | "startBitfsPurchase" | "getBitfsBuyerSettings">,
    });
    await expect(fetcher.fetch({ seedHashHex: SEED, allowPurchase: true })).resolves.toBe(false);
  });

  it("listSourceIds 只列本地来源：买方通道不是发布渠道", () => {
    const quotes = [quote({ sessionId: "s1", price: "50" })];
    const { fetcher } = harness({ published: demand({ quotes }), polls: [demand({ phase: "completed", quotes })] });
    // 下载来源不能被当成「读者可达」的证据。
    expect(fetcher.listSourceIds()).toEqual([MSFILE_LOCAL_SOURCE_ID]);
  });
});
