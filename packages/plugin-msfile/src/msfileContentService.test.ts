// MSFile 跨插件内容能力的测试。
//
// 覆盖 FC01..FC04 的核心断言：
//   - 远程取得的正文落到同一 msfiles 布局，重启后本地命中；
//   - 完整性：损坏 seed/块/长度/部分写入都不能返回完整正文；
//   - 同 hash 多消费者合并、独立取消、删除失效、重新获取；
//   - 渠道缺失时如实报告不可达，不伪造「已获取」。

import { describe, expect, it, vi } from "vitest";

import { createMsFileContentService, MsFileContentTooLargeError, type MsFileRemoteContentFetcher } from "./msfileContentService.js";
import { createInMemoryOwnerFileStore, type InMemoryOwnerFileStore } from "./storage/inMemoryOwnerFileStore.testutil.js";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** 让共享任务走完本地优先检查（它包含真实异步 I/O，微任务轮数不够）。 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function importText(content: { importContent(input: { bytes: Uint8Array; fileName: string; mediaType: string }): Promise<{ seedHashHex: string; byteLength: string }> } | ReturnType<typeof createMsFileContentService>, text: string): Promise<string> {
  return (await content.importContent({ bytes: utf8(text), fileName: "post.md", mediaType: "text/markdown" })).seedHashHex;
}

describe("内容导入与本地读取", () => {
  it("导入后可在本地读回已验证内容，字节逐一致", async () => {
    const store = createInMemoryOwnerFileStore();
    const service = createMsFileContentService({ store });
    const text = "# 标题\n\n正文内容";
    const seedHashHex = await importText(service, text);
    expect(seedHashHex).toMatch(/^[0-9a-f]{64}$/u);
    const opened = await service.openVerifiedContent(seedHashHex);
    expect(opened).toBeDefined();
    expect(new TextDecoder().decode(opened!.bytes)).toBe(text);
    expect(opened!.byteLength).toBe(String(utf8(text).byteLength));
    // 内容真值只在 MSFile 的既有布局里：seeds/storage/meta 三个前缀都出现了。
    const paths = [...store.objects.keys()];
    expect(paths.some((path) => path.startsWith("seeds/"))).toBe(true);
    expect(paths.some((path) => path.startsWith("storage/"))).toBe(true);
    expect(paths.some((path) => path.startsWith("meta/"))).toBe(true);
  });

  it("未导入的内容返回 undefined 而不是空内容", async () => {
    const service = createMsFileContentService({ store: createInMemoryOwnerFileStore() });
    expect(await service.openVerifiedContent("ab".repeat(32))).toBeUndefined();
    // 非法 hash 一律拒绝。
    expect(await service.openVerifiedContent("nope")).toBeUndefined();
    expect(await service.openVerifiedContent("AB".repeat(32))).toBeUndefined();
  });

  it("本地完整命中不走远程", async () => {
    const store = createInMemoryOwnerFileStore();
    const fetchSpy = vi.fn<MsFileRemoteContentFetcher["fetch"]>().mockResolvedValue(true);
    const service = createMsFileContentService({
      store,
      remote: { listSourceIds: () => ["local-bitfs"], fetch: fetchSpy },
    });
    const seedHashHex = await importText(service, "local");
    const status = await service.ensureContent({ seedHashHex, allowPurchase: true });
    expect(status.state).toBe("verified");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("列表浏览不得自动购买正文：没有授权就停在未获取", async () => {
    const store = createInMemoryOwnerFileStore();
    const fetchSpy = vi.fn<MsFileRemoteContentFetcher["fetch"]>().mockResolvedValue(true);
    const service = createMsFileContentService({
      store,
      remote: { listSourceIds: () => ["local-bitfs"], fetch: fetchSpy },
    });
    const status = await service.ensureContent({ seedHashHex: "cd".repeat(32), allowPurchase: false });
    expect(status.state).toBe("absent");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("远程获取与唯一归档", () => {
  /** 远程 fetcher：把内容按 MSFile 自己的布局写进 store（真实实现走既有通道）。 */
  async function remoteInto(store: InMemoryOwnerFileStore, text: string): Promise<MsFileRemoteContentFetcher> {
    const { storeMsFileSeed } = await import("./storage/msfileSeedStore.js");
    return {
      listSourceIds: () => ["remote-proxy:02".padEnd(64, "a")],
      async fetch() {
        const bytes = utf8(text);
        await storeMsFileSeed({
          store,
          source: {
            name: "post.md",
            mediaType: "text/markdown",
            size: BigInt(bytes.byteLength),
            async *stream() {
              yield bytes;
            },
            async read(offset: bigint, length: number) {
              const start = Number(offset);
              return bytes.subarray(start, start + length);
            },
          },
        });
        return true;
      },
    };
  }

  it("远程取得的正文落到同一 msfiles，读回时逐字节一致", async () => {
    const text = "# 远端正文\n\n内容";
    // 先确定这段字节的 seed hash：请求的 hash 必须就是内容自己的 hash。
    const probe = createMsFileContentService({ store: createInMemoryOwnerFileStore() });
    const seedHashHex = await importText(probe, text);

    const store = createInMemoryOwnerFileStore();
    const service = createMsFileContentService({ store, remote: await remoteInto(store, text) });
    const status = await service.ensureContent({ seedHashHex, allowPurchase: true });
    expect(status.state).toBe("verified");
    expect(status.verifiedBytes).toBe(String(utf8(text).byteLength));
    const opened = await service.openVerifiedContent(seedHashHex);
    expect(new TextDecoder().decode(opened!.bytes)).toBe(text);
    // 远程取得的正文落在同一 msfiles 布局里，而不是 Forum 私有仓库。
    expect([...store.objects.keys()].some((path) => path.startsWith("meta/"))).toBe(true);
  });

  it("渠道缺失时如实报告不可达，不伪造已获取", async () => {
    const service = createMsFileContentService({ store: createInMemoryOwnerFileStore() });
    const status = await service.ensureContent({ seedHashHex: "ab".repeat(32), allowPurchase: true });
    expect(status.state).toBe("unreachable");
    expect(status.failureCode).toBe("no-available-channel");
    expect(status.localCopy).toBe(false);
  });

  it("远程返回成功但内容未落盘时状态不是 verified", async () => {
    const service = createMsFileContentService({
      store: createInMemoryOwnerFileStore(),
      // fetcher 谎报成功但什么都没写：完整性验证必须挡住它。
      remote: { listSourceIds: () => ["remote-proxy:02".padEnd(64, "a")], fetch: async () => true },
    });
    const status = await service.ensureContent({ seedHashHex: "ab".repeat(32), allowPurchase: true });
    expect(status.state).not.toBe("verified");
  });
});

describe("完整性与失效", () => {
  it("删除内容后投影失效，不再呈现过时可用标记", async () => {
    const store = createInMemoryOwnerFileStore();
    const service = createMsFileContentService({ store });
    const seedHashHex = await importText(service, "to be deleted");
    expect((await service.getContentStatus(seedHashHex)).state).toBe("verified");

    const statuses: string[] = [];
    const off = service.subscribeContent(seedHashHex, (status) => statuses.push(status.state));
    // 删除 meta 后内容不再可读。
    for (const path of [...store.objects.keys()]) {
      if (path.startsWith("meta/") || path.startsWith("seeds/")) await store.delete(path);
    }
    expect(await service.openVerifiedContent(seedHashHex)).toBeUndefined();
    expect((await service.getContentStatus(seedHashHex)).state).not.toBe("verified");
    expect(statuses.length).toBeGreaterThan(0);
    off();
  });

  it("损坏的块文件不能被当作完整内容", async () => {
    const store = createInMemoryOwnerFileStore();
    const service = createMsFileContentService({ store });
    const text = "0123456789".repeat(40_000);
    const seedHashHex = await importText(service, text);
    expect((await service.getContentStatus(seedHashHex)).state).toBe("verified");
    // 改掉一个块的内容：块 hash 校验必须失败。
    for (const [path, bytes] of store.objects) {
      if (path.startsWith("storage/")) {
        const tampered = bytes.slice();
        tampered[0] = (tampered[0] as number) ^ 0xff;
        store.objects.set(path, tampered);
        break;
      }
    }
    const status = await service.getContentStatus(seedHashHex);
    expect(status.state).not.toBe("verified");
    expect(status.localCopy).toBe(false);
  });

  it("缺失块文件不能被当作完整内容", async () => {
    const store = createInMemoryOwnerFileStore();
    const service = createMsFileContentService({ store });
    const seedHashHex = await importText(service, "y".repeat(600_000));
    expect((await service.getContentStatus(seedHashHex)).state).toBe("verified");
    for (const path of [...store.objects.keys()]) {
      if (path.startsWith("storage/")) {
        await store.delete(path);
        break;
      }
    }
    expect((await service.getContentStatus(seedHashHex)).state).not.toBe("verified");
  });

  it("部分写入（只有 seed 没有块）不能返回完整正文", async () => {
    const store = createInMemoryOwnerFileStore();
    const service = createMsFileContentService({ store });
    const seedHashHex = await importText(service, "z".repeat(600_000));
    for (const path of [...store.objects.keys()]) {
      if (path.startsWith("storage/") || path.startsWith("meta/")) await store.delete(path);
    }
    // meta 缺失同样不能算完整：meta 不是完整性证据。
    expect(await service.openVerifiedContent(seedHashHex)).toBeUndefined();
  });

  it("超过体积上限的内容被明确拒绝，而不是被截断", async () => {
    const service = createMsFileContentService({ store: createInMemoryOwnerFileStore(), maxContentBytes: 64 });
    await expect(service.importContent({ bytes: new Uint8Array(65), fileName: "big.bin", mediaType: "application/octet-stream" })).rejects.toBeInstanceOf(
      MsFileContentTooLargeError,
    );
    expect(await service.importContent({ bytes: new Uint8Array(64), fileName: "ok.bin", mediaType: "application/octet-stream" })).toMatchObject({
      byteLength: "64",
    });
  });
});

describe("同 hash 多消费者", () => {
  it("相同 hash 的并发请求合并为一个任务", async () => {
    const store = createInMemoryOwnerFileStore();
    let resolveFetch: ((value: boolean) => void) | undefined;
    const fetchSpy = vi.fn<MsFileRemoteContentFetcher["fetch"]>(
      () =>
        new Promise<boolean>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const service = createMsFileContentService({
      store,
      remote: { listSourceIds: () => ["remote-proxy:02".padEnd(64, "a")], fetch: fetchSpy },
    });
    const first = service.ensureContent({ seedHashHex: "ab".repeat(32), allowPurchase: true });
    const second = service.ensureContent({ seedHashHex: "ab".repeat(32), allowPurchase: true });
    await tick();
    // 只有一个任务在飞。
    expect(fetchSpy.mock.calls.length).toBe(1);
    resolveFetch?.(false);
    const [a, b] = await Promise.all([first, second]);
    expect(a.state).toBe(b.state);
  });

  it("取消一个消费者不终止其他消费者仍需要的任务", async () => {
    const store = createInMemoryOwnerFileStore();
    let aborts = 0;
    const service = createMsFileContentService({
      store,
      remote: {
        listSourceIds: () => ["remote-proxy:02".padEnd(64, "a")],
        fetch: ({ signal }) =>
          new Promise<boolean>((resolve) => {
            signal?.addEventListener("abort", () => {
              aborts += 1;
              resolve(false);
            });
          }),
      },
    });
    const controller = new AbortController();
    const cancelled = service.ensureContent({ seedHashHex: "ab".repeat(32), allowPurchase: true, signal: controller.signal });
    const kept = service.ensureContent({ seedHashHex: "ab".repeat(32), allowPurchase: true });
    await tick();
    controller.abort();
    // 被取消的消费者立刻拿到 cancelled，而不是等到任务结束。
    expect((await cancelled).failureCode).toBe("cancelled");
    await tick();
    // 另一个消费者仍然挂着，任务没有被中止。
    expect(aborts).toBe(0);
    void kept;
  });
});

describe("发布可达性", () => {
  it("本地已存不等于读者可取得：没有渠道时 published 为 false", async () => {
    const service = createMsFileContentService({ store: createInMemoryOwnerFileStore() });
    const seedHashHex = await importText(service, "local only");
    const reach = await service.publicationReachability(seedHashHex);
    expect(reach.published).toBe(false);
    expect(reach.detail).toContain("供应渠道");
    expect(reach.detail).toContain("尚未实现");
  });

  it("本地已存且存在渠道时 published 为 true", async () => {
    const service = createMsFileContentService({
      store: createInMemoryOwnerFileStore(),
      remote: { listSourceIds: () => ["remote-proxy:02".padEnd(64, "a")], fetch: async () => true },
    });
    const seedHashHex = await importText(service, "published");
    expect((await service.publicationReachability(seedHashHex)).published).toBe(true);
  });

  it("内容尚未完整保存时不是已发布", async () => {
    const service = createMsFileContentService({
      store: createInMemoryOwnerFileStore(),
      remote: { listSourceIds: () => ["remote-proxy:02".padEnd(64, "a")], fetch: async () => true },
    });
    expect((await service.publicationReachability("ab".repeat(32))).published).toBe(false);
  });
});