// 卖方发布渠道证据：测试的是 **manifest 装配的那一份**，
// 不是把判断逻辑抄一遍再测（抄一份会全绿而生产仍按旧规则判可达）。

import { describe, expect, it } from "vitest";
import type { MsFileSellerRuntimeStatus } from "@keymaster/contracts";

import { createMsFileContentService } from "./msfileContentService.js";
import { createMsFileSellerPublicationEvidence } from "./msfilePublicationEvidence.js";
// 与 msfileContentService.test.ts 用同一个 owner 文件存储实现，不另写一份近似物。
import { createInMemoryOwnerFileStore } from "./storage/inMemoryOwnerFileStore.testutil.js";

function snapshot(status: MsFileSellerRuntimeStatus, enabled = true) {
  return {
    sellerSettings: { sellerEnabled: enabled },
    sellerRuntimeStatus: status,
  };
}

function serviceWith(status: MsFileSellerRuntimeStatus, enabled = true) {
  return {
    async getSettingsSnapshot() {
      return snapshot(status, enabled);
    },
    async getBitfsBuyerSettings() {
      return { bsvRelayUrls: [], bsvStorageUrls: [], maxInFlightRequests: 1, maxReadConcurrency: 1, maxStatConcurrency: 1, maxBlockReadConcurrency: 1 };
    },
  };
}

describe("卖方发布渠道的可达性判据（生产装配的那一份）", () => {
  it.each(["ready", "selling"] as const)("运行单元 %s 时才报可达", async (status) => {
    const evidence = await createMsFileSellerPublicationEvidence(serviceWith(status)).publicationEvidence();
    expect(evidence.published).toBe(true);
    expect(evidence.sourceIds).toEqual(["seller:local-bitfs"]);
  });

  it.each(["disabled", "waiting-unlock", "waiting-dependency", "configuration-error", "indexing", "degraded"] as const)(
    "%s 不算已发布，且不给出任何来源 id",
    async (status) => {
      const evidence = await createMsFileSellerPublicationEvidence(serviceWith(status)).publicationEvidence();
      // 「查不到就当没有」会把真实缺口藏起来：宁可报不可达。
      expect(evidence.published).toBe(false);
      expect(evidence.sourceIds).toEqual([]);
      expect(evidence.detail).not.toBe("");
    },
  );

  it("卖方模式关闭时永远不可达（哪怕状态写着 ready）", async () => {
    for (const status of ["ready", "selling", "degraded"] as const) {
      const evidence = await createMsFileSellerPublicationEvidence(serviceWith(status, false)).publicationEvidence();
      expect(evidence.published, status).toBe(false);
    }
  });

  it("索引未完成时明确说明原因，而不是笼统报不可用", async () => {
    const evidence = await createMsFileSellerPublicationEvidence(serviceWith("indexing")).publicationEvidence();
    expect(evidence.detail).toContain("索引");
  });
});

async function importMarkdown(service: ReturnType<typeof createMsFileContentService>, text: string): Promise<string> {
  return (await service.importContent({ bytes: new TextEncoder().encode(text), fileName: "post.md", mediaType: "text/markdown" })).seedHashHex;
}

describe("内容服务确实走这份证据", () => {
  function contentHarness(status: MsFileSellerRuntimeStatus) {
    const service = createMsFileContentService({
      store: createInMemoryOwnerFileStore(),
      service: serviceWith(status) as never,
      publication: createMsFileSellerPublicationEvidence(serviceWith(status)),
    });
    return { service };
  }

  it("卖方就绪时发布可达性来自这份证据", async () => {
    const h = contentHarness("selling");
    const seedHashHex = await importMarkdown(h.service, "# hi");
    const reachable = await h.service.publicationReachability(seedHashHex);
    expect(reachable.published).toBe(true);
    expect(reachable.sourceIds).toEqual(["seller:local-bitfs"]);
  });

  it("卖方降级时同一份内容报不可达（内容在本地不等于读者拿得到）", async () => {
    const h = contentHarness("degraded");
    const seedHashHex = await importMarkdown(h.service, "# hi");
    const reachable = await h.service.publicationReachability(seedHashHex);
    expect(reachable.published).toBe(false);
    expect(reachable.sourceIds).toEqual([]);
  });

  it("没有装配发布证据时一律报不可达", async () => {
    const service = createMsFileContentService({
      store: createInMemoryOwnerFileStore(),
      service: serviceWith("selling") as never,
    });
    const seedHashHex = await importMarkdown(service, "# hi");
    const reachable = await service.publicationReachability(seedHashHex);
    expect(reachable.published).toBe(false);
    expect(reachable.detail).toContain("发布渠道");
  });

});