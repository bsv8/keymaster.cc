// Forum 的附件读取与发布可达性。
//
// 两个曾经会让界面说谎的地方：
//   - 附件读取走正文入口时会被 1 MiB 的 Markdown 限额拦住，于是「32 MiB 附件
//     上限」这条代码路径永远到不了；
//   - 发布可达性如果只停留在 MSFile 内部，Forum 界面就只能显示「已发布」，而
//     读者其实取不到。

import { describe, expect, it, vi } from "vitest";

import type { MsFileContentService, MsFileVerifiedContent } from "@keymaster/contracts";

import { createForumService, type ForumFundingSource } from "./forumService.js";
import { createForumRepository, type ForumRepository } from "../storage/forumRepository.js";

const SEED_HASH = "cc".repeat(32);
const OWNER = "02".repeat(33);
const CONFIG = {
  id: "test-forum",
  label: "test",
  network: "test" as const,
  forumTxid: "aa".repeat(32),
  forumPublicKeyHex: OWNER,
  endpoints: [{ kind: "https" as const, url: "https://forum.example" }],
};

/** 2 MiB 的「图片」：超过 Markdown 的 1 MiB 上限，但附件入口应当能读。 */
function bigAttachment(): MsFileVerifiedContent {
  const bytes = new Uint8Array(2 * 1024 * 1024);
  bytes.set([0x89, 0x50, 0x4e, 0x47], 0);
  return {
    seedHashHex: SEED_HASH,
    bytes,
    byteLength: String(bytes.byteLength),
    mediaType: "image/png",
    fileName: "big.png",
  };
}

function contentStub(overrides: Partial<MsFileContentService> = {}): MsFileContentService {
  return {
    async ensureContent() {
      return { seedHashHex: SEED_HASH, state: "absent" as const, localCopy: false };
    },
    async openVerifiedContent() {
      return undefined;
    },
    async openVerifiedAttachment() {
      return undefined;
    },
    async importContent() {
      return { seedHashHex: SEED_HASH, byteLength: "0" };
    },
    async getContentStatus() {
      return { seedHashHex: SEED_HASH, state: "absent" as const, localCopy: false };
    },
    subscribeContent() {
      return () => undefined;
    },
    async publicationReachability() {
      return { seedHashHex: SEED_HASH, published: false, sourceIds: [], detail: "渠道未实现" };
    },
    ...overrides,
  } as unknown as MsFileContentService;
}

function memoryStore() {
  const files = new Map<string, { bytes: Uint8Array; revision: number }>();
  return {
    async get(path: string) {
      const entry = files.get(path);
      return entry === undefined ? undefined : { path, bytes: entry.bytes, revision: String(entry.revision), lastModified: "now" };
    },
    async put(path: string, bytes: Uint8Array) {
      files.set(path, { bytes, revision: (files.get(path)?.revision ?? 0) + 1 });
      return { revision: String(files.get(path)?.revision ?? 1), lastModified: "now" };
    },
    async delete(path: string) {
      files.delete(path);
    },
    async list() {
      return { files: [...files.keys()].map((path) => ({ path, sizeBytes: 0 })), nextCursor: null };
    },
    close() {},
  } as never;
}

async function serviceWith(content: MsFileContentService): Promise<ReturnType<typeof createForumService>> {
  const repository: ForumRepository = createForumRepository(memoryStore());
  await repository.writeConfig(CONFIG);
  return createForumService({
    repository,
    content,
    async activeCrypto() {
      throw new Error("附件测试不需要签名");
    },
    ownerPublicKeyHex: () => OWNER,
    protocolSpend: () => undefined,
    async fetchRootRaw() {
      return new Uint8Array(0);
    },
    sessionEpoch: () => "epoch-1",
  });
}

describe("附件读取不受正文限额约束", () => {
  it("本地 2 MiB 附件可以直接读出，不经过正文入口", async () => {
    const ensure = vi.fn();
    const content = contentStub({
      // 正文入口在这里会拒绝超限内容（MSFile 的 Markdown 上限）。
      async ensureContent() {
        ensure();
        return { seedHashHex: SEED_HASH, state: "verification-failed" as const, failureCode: "too-large" as const, localCopy: false };
      },
      async openVerifiedAttachment() {
        return bigAttachment();
      },
    });
    const forum = await serviceWith(content);
    const read = await forum.readAttachmentContent(CONFIG.id, SEED_HASH);
    expect(read?.byteLength).toBe(String(2 * 1024 * 1024));
    expect(read?.mediaType).toBe("image/png");
    // 关键：本地已有附件时不该先被正文路径拦一次。
    expect(ensure).not.toHaveBeenCalled();
  });

  it("本地没有时才调度获取，并允许用户触发的付费获取", async () => {
    const calls: { allowPurchase?: boolean }[] = [];
    const content = contentStub({
      async ensureContent(input: { allowPurchase?: boolean }) {
        calls.push(input);
        return { seedHashHex: SEED_HASH, state: "verified" as const, localCopy: false };
      },
      // 第一次（本地探测）返回 undefined，模拟「本地没有附件」。
      async openVerifiedAttachment() {
        return calls.length === 0 ? undefined : bigAttachment();
      },
    });
    const forum = await serviceWith(content);
    const read = await forum.readAttachmentContent(CONFIG.id, SEED_HASH);
    expect(read).toBeDefined();
    // 用户明确点开附件是获取授权；否则远程附件永远拿不到。
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ allowPurchase: true });
  });

  it("获取后仍读不到字节时返回 undefined（不展示空图片框）", async () => {
    const content = contentStub({
      async ensureContent() {
        return { seedHashHex: SEED_HASH, state: "unreachable" as const, failureCode: "no-available-channel" as const, localCopy: false };
      },
    });
    const forum = await serviceWith(content);
    await expect(forum.readAttachmentContent(CONFIG.id, SEED_HASH)).resolves.toBeUndefined();
  });
});

describe("发布可达性被 Forum 消费", () => {
  it("渠道缺失时如实报告不可达，并给出原因", async () => {
    const content = contentStub({
      async publicationReachability() {
        return { seedHashHex: SEED_HASH, published: false, sourceIds: [], detail: "发布渠道尚未实现" };
      },
    });
    const forum = await serviceWith(content);
    const reach = await forum.publicationReachability(CONFIG.id, SEED_HASH);
    expect(reach.reachable).toBe(false);
    expect(reach.sourceIds).toEqual([]);
    expect(reach.detail).toContain("发布渠道");
  });

  it("有真实发布证据时报告可达", async () => {
    const content = contentStub({
      async publicationReachability() {
        return { seedHashHex: SEED_HASH, published: true, sourceIds: [`seller:${SEED_HASH}`], detail: "卖方模式已开池" };
      },
    });
    const forum = await serviceWith(content);
    const reach = await forum.publicationReachability(CONFIG.id, SEED_HASH);
    expect(reach.reachable).toBe(true);
    expect(reach.sourceIds).toEqual([`seller:${SEED_HASH}`]);
  });

  it("证据查询失败按不可达处理，而不是当作可达", async () => {
    const content = contentStub({
      async publicationReachability() {
        throw new Error("storage down");
      },
    });
    const forum = await serviceWith(content);
    const reach = await forum.publicationReachability(CONFIG.id, SEED_HASH);
    expect(reach.reachable).toBe(false);
    expect(reach.detail).toContain("无法取得");
  });

  it("preparePublishContent 在渠道缺失时仍然冻结正文并记录状态", async () => {
    const content = contentStub({
      async importContent() {
        return { seedHashHex: SEED_HASH, byteLength: "8" };
      },
      async publicationReachability() {
        return { seedHashHex: SEED_HASH, published: false, sourceIds: [], detail: "发布渠道尚未实现" };
      },
    });
    const forum = await serviceWith(content);
    const prepared = await forum.preparePublishContent(CONFIG.id, "# hi");
    // 链上发布不依赖渠道，因此不能因为不可达就拒绝冻结。
    expect(prepared.seedHashHex).toBe(SEED_HASH);
    expect(prepared.publication.reachable).toBe(false);
    expect(prepared.publication.detail).toContain("发布渠道");
  });

  it("超限正文仍然被拒绝（附件放宽不波及正文上限）", async () => {
    const content = contentStub({
      async importContent() {
        return { seedHashHex: SEED_HASH, byteLength: "8" };
      },
    });
    const forum = await serviceWith(content);
    await expect(forum.preparePublishContent(CONFIG.id, "x".repeat(2 * 1024 * 1024))).rejects.toMatchObject({
      code: "markdown-oversize",
    });
  });
});

// 让未使用导入保持显式：ForumFundingSource 是本文件装配契约的一部分。
export type { ForumFundingSource };