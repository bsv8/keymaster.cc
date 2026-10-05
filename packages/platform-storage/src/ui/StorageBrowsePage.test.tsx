import { createFixtureHost as createPluginHost } from "@keymaster/runtime/test-support";
import type { StorageBrowseService } from "../runtime/storageBrowsePrivate.js";
// 浏览页的交互测试（L01/U01）：刷新、删除、快速切换与目录标记。
//
// 这些行为都在 useEffect 与 Promise 竞态里，纯逻辑测试测不到，所以用假浏览
// 服务驱动真实的组件：响应不自动兑现，由测试手动结算，「迟到的响应不覆盖新
// 选择」这条规则才能被确定地验证，而不是碰运气等它自己发生。
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import type { PluginConsumer } from "webloom-framework";
import { PluginConsumerProvider } from "webloom-framework/react";
import { I18N_SERVICE_CAPABILITY } from "@keymaster/contracts";
import { type StorageBrowseEntry, type StorageBrowsePage, type StorageBrowsePreview, type StoragePreviewFormat } from "../runtime/storageBrowseTypes.js";
import { PluginHostProvider } from "@keymaster/runtime/assembly";
// manifest 导出的 feature entry 也叫 StorageBrowsePage，这里显式改名避免同名冲突。
import { StorageBrowsePage as StorageBrowsePageView } from "./StorageBrowsePage.js";
import { StoragePrivateProvider } from "./StoragePrivateContext.js";
import { BROWSE_DISPLAY_PAGE_SIZE } from "./storageBrowseDisplay.js";
import { storageResources } from "../manifest.js";

const ENCODER = new TextEncoder();

function entry(path: string, extra: Partial<StorageBrowseEntry> = {}): StorageBrowseEntry {
  return { path, size: 12, lastModified: "2026-10-01T00:00:00.000Z", revision: "rev-1", ...extra };
}

interface ListCall {
  prefix: string;
  cursor?: string;
  signal?: AbortSignal;
}

interface PendingList {
  call: ListCall;
  resolve: (page: StorageBrowsePage) => void;
}

interface PendingPreview {
  path: string;
  resolve: (preview: StorageBrowsePreview) => void;
  reject: (error: unknown) => void;
}

/** 假浏览服务：请求入队，由测试按需要的顺序结算响应。 */
function createFakeService() {
  const listCalls: ListCall[] = [];
  const previewCalls: Array<{ path: string; ifRevision?: string }> = [];
  const pendingLists: PendingList[] = [];
  const pendingPreviews: PendingPreview[] = [];
  const service: StorageBrowseService = {
    openSession: async () => ({ browseSessionId: "s1", walletGeneration: "w1", sessionEpoch: "e1", runGeneration: "r1" }),
    list: (request, options) => {
      const call: ListCall = {
        prefix: request.prefix,
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      };
      listCalls.push(call);
      return new Promise<StorageBrowsePage>((resolve, reject) => {
        pendingLists.push({ call, resolve });
        options?.signal?.addEventListener("abort", () => reject(abortError()));
      });
    },
    preview: (request, options) => {
      previewCalls.push({ path: request.path, ...(request.ifRevision === undefined ? {} : { ifRevision: request.ifRevision }) });
      return new Promise<StorageBrowsePreview>((resolve, reject) => {
        pendingPreviews.push({ path: request.path, resolve, reject });
        options?.signal?.addEventListener("abort", () => reject(abortError()));
      });
    },
    closeSession: async () => undefined,
  };
  /** 按 path 取出一条待结算的预览请求；顺手出队，保证乱序兑现不会互相干扰。 */
  function takePendingPreview(path: string): PendingPreview {
    const index = pendingPreviews.findIndex((pending) => pending.path === path);
    const pending = pendingPreviews[index];
    if (!pending) throw new Error("no pending preview for " + path);
    pendingPreviews.splice(index, 1);
    return pending;
  }

  return {
    service,
    listCalls,
    previewCalls,
    pendingListCount: () => pendingLists.length,
    /** 结算最后一次列表请求。 */
    async settleList(entries: StorageBrowseEntry[], nextCursor?: string) {
      const pending = pendingLists[pendingLists.length - 1];
      if (!pending) throw new Error("no pending list request");
      pending.resolve({ entries, ...(nextCursor === undefined ? {} : { nextCursor }) });
      await flush();
    },
    /** 结算某一次预览请求（按 path 定位，便于乱序兑现）。 */
    async settlePreview(path: string, body: string, extra: { revision?: string; format?: StoragePreviewFormat } = {}) {
      const pending = takePendingPreview(path);
      const bytes = ENCODER.encode(body);
      const format = extra.format ?? "text";
      pending.resolve({
        path,
        format,
        bytes,
        totalSize: bytes.byteLength,
        returnedSize: bytes.byteLength,
        truncated: false,
        revision: extra.revision ?? "rev-1",
        lastModified: "2026-10-01T00:00:00.000Z",
        contentType: format === "json" ? "application/json" : "text/plain",
      });
      await flush();
    },
    /** 让某一次预览请求失败（对象已删除或其它错误码）。 */
    async failPreview(path: string, code = "storage_not_found") {
      const pending = takePendingPreview(path);
      const error = new Error("Object no longer exists") as Error & { code?: string };
      error.code = code;
      pending.reject(error);
      await flush();
    },
    pendingPreviewPaths: () => pendingPreviews.map((pending) => pending.path),
  };
}

/** 让已结算的 promise 及其状态更新落地。 */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

async function renderPage(service: StorageBrowseService, wrap?: (node: ReactNode) => ReactNode) {
  // 带上真实文案资源：断言的是界面上的实际用词，而不是组件里的 defaultValue。
  let consumer: PluginConsumer | undefined;
  const host = createPluginHost({
    initialI18nResources: [storageResources],
    runtimeUnitImplementationRegistry: { get: () => (ctx) => { consumer = ctx.consumer; } },
  });
  await host.register({ id: "storage-ui-test", name: "Storage UI test", units: [{
    id: "storage-ui-test.window", runtime: "window-main", scopeKind: "root",
    dependencies: [{ capability: I18N_SERVICE_CAPABILITY, sourceRuntime: "window-main" }],
  }] });
  if (!consumer) throw new Error("Storage UI test consumer was not issued");
  const tree = <PluginHostProvider host={host}><PluginConsumerProvider consumer={consumer}><StoragePrivateProvider service={service}><StorageBrowsePageView /></StoragePrivateProvider></PluginConsumerProvider></PluginHostProvider>;
  return render(wrap ? wrap(tree) : tree);
}

afterEach(() => {
  cleanup();
});

describe("StorageBrowsePage initial load", () => {
  it("still lists the root directory under StrictMode remount", async () => {
    // StrictMode 会在开发环境模拟一次 unmount/remount。卸载时的取消必须配上一个
    // 会重新发出的请求：否则开发环境下首屏永远停在「加载中」，而普通渲染看不出来。
    const fake = createFakeService();
    await renderPage(fake.service, (node) => <StrictMode>{node}</StrictMode>);
    await waitFor(() => expect(fake.listCalls.length).toBeGreaterThan(0));
    await fake.settleList([entry("notes.txt")]);
    expect(await screen.findByRole("button", { name: "notes.txt" })).toBeTruthy();
  });
});

describe("StorageBrowsePage refresh (U01)", () => {
  it("keeps the current directory and a still-valid selection across refresh", async () => {
    const fake = createFakeService();
    await renderPage(fake.service);
    await waitFor(() => expect(fake.pendingListCount()).toBe(1));
    await fake.settleList([entry("notes.txt", { revision: "rev-7" })]);

    fireEvent.click(await screen.findByRole("button", { name: "notes.txt" }));
    await waitFor(() => expect(fake.previewCalls.length).toBe(1));
    await fake.settlePreview("notes.txt", "first body");
    await screen.findByText("first body");

    // 刷新：同一个文件仍在列且版本没变，选中项与预览都应留在新内容上。
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fake.listCalls.length).toBe(2));
    await fake.settleList([entry("notes.txt", { revision: "rev-7" })]);

    expect(await screen.findByRole("button", { name: "notes.txt" })).toBeTruthy();
    await waitFor(() => expect(fake.previewCalls.length).toBe(2));
    // 条件读取沿用列表记录的版本，不会退化成无条件读取。
    expect(fake.previewCalls.at(-1)).toEqual({ path: "notes.txt", ifRevision: "rev-7" });
  });

  it("clears the stale preview and explains when the selected file was deleted", async () => {
    const fake = createFakeService();
    await renderPage(fake.service);
    await waitFor(() => expect(fake.pendingListCount()).toBe(1));
    await fake.settleList([entry("notes.txt")]);

    fireEvent.click(await screen.findByRole("button", { name: "notes.txt" }));
    await waitFor(() => expect(fake.previewCalls.length).toBe(1));
    await fake.settlePreview("notes.txt", "old body");
    await screen.findByText("old body");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fake.listCalls.length).toBe(2));
    await fake.settleList([]);
    // 第一页里没有它并不等于已删除：页面必须直接核验这个路径。
    await waitFor(() => expect(fake.pendingPreviewPaths()).toContain("notes.txt"));
    await fake.failPreview("notes.txt");

    // 旧内容必须离开屏幕：留在那里就等于还在声称这个文件存在。
    await waitFor(() => expect(screen.queryByText("old body")).toBeNull());
    expect(await screen.findByText("The selected file no longer exists.")).toBeTruthy();
  });

  it("keeps an updated file selected and re-reads it at its new revision (U01)", async () => {
    const fake = createFakeService();
    await renderPage(fake.service);
    await waitFor(() => expect(fake.pendingListCount()).toBe(1));
    await fake.settleList([entry("notes.txt", { size: 12, revision: "rev-7", lastModified: "2026-10-01T00:00:00.000Z" })]);

    fireEvent.click(await screen.findByRole("button", { name: "notes.txt" }));
    await waitFor(() => expect(fake.previewCalls.length).toBe(1));
    await fake.settlePreview("notes.txt", "old body", { revision: "rev-7" });
    await screen.findByText("old body");

    // 同路径文件被改写：大小、时间、版本都变了，但它仍是同一个文件。
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fake.listCalls.length).toBe(2));
    await fake.settleList([entry("notes.txt", { size: 40, revision: "rev-9", lastModified: "2026-10-02T00:00:00.000Z" })]);

    // 不能报「已删除」，而要按新元数据重新预览。
    await waitFor(() => expect(fake.previewCalls.length).toBe(2));
    expect(fake.previewCalls.at(-1)).toEqual({ path: "notes.txt", ifRevision: "rev-9" });
    expect(screen.queryByText("The selected file no longer exists.")).toBeNull();
    await fake.settlePreview("notes.txt", "new body", { revision: "rev-9" });
    expect(await screen.findByText("new body")).toBeTruthy();
  });

  it("does not call a transient read failure a deletion (U01/L01)", async () => {
    const fake = createFakeService();
    await renderPage(fake.service);
    await waitFor(() => expect(fake.pendingListCount()).toBe(1));
    await fake.settleList([entry("notes.txt")]);

    fireEvent.click(await screen.findByRole("button", { name: "notes.txt" }));
    await waitFor(() => expect(fake.previewCalls.length).toBe(1));
    await fake.settlePreview("notes.txt", "old body");
    await screen.findByText("old body");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fake.listCalls.length).toBe(2));
    // 第一页没列到它，核验读又失败：provider/forbidden 都不证明文件被删除。
    await fake.settleList([]);
    await waitFor(() => expect(fake.pendingPreviewPaths()).toContain("notes.txt"));
    await fake.failPreview("notes.txt", "storage_provider_error");

    // 选中项保留，说明与重试都在；不显示「文件已不存在」。
    expect(screen.queryByText("The selected file no longer exists.")).toBeNull();
    expect(await screen.findByText("The selected file could not be verified after refreshing; it may still exist.")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    // 旧内容不应被误当成当前内容继续展示：失败状态是明确可见的。
    expect(screen.queryByText("old body")).toBeNull();

    // 重试会重新读同一个文件。
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fake.previewCalls.length).toBe(3));
    await fake.settlePreview("notes.txt", "recovered body");
    expect(await screen.findByText("recovered body")).toBeTruthy();
  });

  it("explains an unavailable store instead of silently dropping the check (L02)", async () => {
    const fake = createFakeService();
    await renderPage(fake.service);
    await waitFor(() => expect(fake.pendingListCount()).toBe(1));
    await fake.settleList([entry("notes.txt")]);

    fireEvent.click(await screen.findByRole("button", { name: "notes.txt" }));
    await waitFor(() => expect(fake.previewCalls.length).toBe(1));
    await fake.settlePreview("notes.txt", "old body");
    await screen.findByText("old body");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fake.listCalls.length).toBe(2));
    await fake.settleList([]);
    await waitFor(() => expect(fake.pendingPreviewPaths()).toContain("notes.txt"));
    // 锁定/句柄作废属于存储暂不可用：既不是删除，也不该静默。
    await fake.failPreview("notes.txt", "storage_unavailable");

    expect(screen.queryByText("The selected file no longer exists.")).toBeNull();
    // 提示与失败状态都写明「暂不可用」，而不是把它当成删除。
    expect((await screen.findAllByText("Storage browsing is not available. The wallet may be locked.")).length).toBeGreaterThan(0);
  });

  it("does not report a file on a later page as deleted (U01/F03)", async () => {
    const fake = createFakeService();
    await renderPage(fake.service);
    await waitFor(() => expect(fake.pendingListCount()).toBe(1));
    // 深目录：还有后续页，选中的文件在第二页。
    await fake.settleList([entry("b.txt", { revision: "rev-3" })], "cursor-1");

    fireEvent.click(await screen.findByRole("button", { name: "b.txt" }));
    await waitFor(() => expect(fake.previewCalls.length).toBe(1));
    await fake.settlePreview("b.txt", "body of b", { revision: "rev-3" });
    await screen.findByText("body of b");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fake.listCalls.length).toBe(2));
    // 刷新后的第一页里也没有它，且分页未完成：不能因此断言删除。
    await fake.settleList([entry("a.txt", { revision: "rev-3" })], "cursor-2");
    await waitFor(() => expect(fake.pendingPreviewPaths()).toContain("b.txt"));
    await fake.settlePreview("b.txt", "body of b after refresh", { revision: "rev-4" });

    expect(screen.queryByText("The selected file no longer exists.")).toBeNull();
    expect(await screen.findByText("body of b after refresh")).toBeTruthy();
    // 核对用的是权威读；它返回的内容直接成为新预览，不再重复请求一次。
    expect(fake.previewCalls.filter((call) => call.path === "b.txt").length).toBe(2);
    expect(fake.previewCalls.at(-1)).toEqual({ path: "b.txt" });
  });
});

describe("StorageBrowsePage races (L01)", () => {
  it("never lets a late response overwrite the newly selected file", async () => {
    const fake = createFakeService();
    await renderPage(fake.service);
    await waitFor(() => expect(fake.pendingListCount()).toBe(1));
    await fake.settleList([entry("a.txt"), entry("b.txt")]);

    fireEvent.click(await screen.findByRole("button", { name: "a.txt" }));
    await waitFor(() => expect(fake.previewCalls.length).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "b.txt" }));
    await waitFor(() => expect(fake.previewCalls.length).toBe(2));

    // 先兑现 b，再兑现 a 的迟到响应。
    await fake.settlePreview("b.txt", "body of b");
    await screen.findByText("body of b");
    await fake.settlePreview("a.txt", "body of a");
    await flush();

    expect(screen.queryByText("body of a")).toBeNull();
    expect(screen.getByText("body of b")).toBeTruthy();
  });
});

describe("StorageBrowsePage directory marker (F04)", () => {
  it("shows the selected directory's own marker object in properties", async () => {
    const fake = createFakeService();
    await renderPage(fake.service);
    await waitFor(() => expect(fake.pendingListCount()).toBe(1));
    await fake.settleList([
      entry("apps/.dir", { size: 0, contentType: "application/x-directory", revision: "rev-marker" }),
      entry("apps/notes.txt"),
    ]);

    fireEvent.click(await screen.findByRole("button", { name: "apps" }));
    await waitFor(() => expect(fake.listCalls.at(-1)?.prefix).toBe("apps"));
    await fake.settleList([entry("apps/.dir", { size: 0, contentType: "application/x-directory", revision: "rev-marker" })]);

    fireEvent.click(screen.getByRole("tab", { name: "Properties" }));
    // 空目录也有标记可追踪：属性里能看到 .dir 的完整路径。
    expect(await screen.findByText("apps/.dir")).toBeTruthy();
  });
});

describe("StorageBrowsePage view switches (P01)", () => {
  it("resets the original-text view when the previewed file changes", async () => {
    const fake = createFakeService();
    await renderPage(fake.service);
    await waitFor(() => expect(fake.pendingListCount()).toBe(1));
    await fake.settleList([entry("a.json"), entry("b.json")]);

    fireEvent.click(await screen.findByRole("button", { name: "a.json" }));
    await waitFor(() => expect(fake.pendingPreviewPaths()).toContain("a.json"));
    await fake.settlePreview("a.json", '{"a":1}', { format: "json" });
    fireEvent.click(await screen.findByRole("button", { name: "Original text" }));
    await waitFor(() => expect(document.querySelector(".storage-browse__raw")?.textContent).toBe('{"a":1}'));

    // 换文件后回到默认视图：上一份文件的「原文」不能继承到下一份。
    fireEvent.click(screen.getByRole("button", { name: "b.json" }));
    await waitFor(() => expect(fake.pendingPreviewPaths()).toContain("b.json"));
    await fake.settlePreview("b.json", '{"b":2}', { format: "json" });
    await waitFor(() => expect(document.querySelector(".storage-browse__json-node")).not.toBeNull());
    expect(document.querySelector(".storage-browse__raw")).toBeNull();
  });
});

describe("StorageBrowsePage bounded rendering (F03/U01)", () => {
  it("pages through every loaded row without growing the rendered page", async () => {
    const fake = createFakeService();
    await renderPage(fake.service);
    await waitFor(() => expect(fake.pendingListCount()).toBe(1));
    // 一页列举结果折叠出超过一个展示页的子项。补零让名称顺序与下标一致，
    // 否则字典序会把最后几项排进第一页，测不到分页本身。
    const total = BROWSE_DISPLAY_PAGE_SIZE + 5;
    const name = (index: number) => "f" + String(index).padStart(3, "0") + ".txt";
    const entries = Array.from({ length: total }, (_, index) => entry(name(index)));
    await fake.settleList(entries);

    const listing = within(document.querySelector(".storage-browse__listing") as HTMLElement);
    const listNames = () => Array.from(document.querySelectorAll(".storage-browse__row-name")).map((node) => node.textContent);
    const treeNames = () => Array.from(document.querySelectorAll(".storage-browse__tree-label")).map((node) => node.textContent);

    await waitFor(() => expect(listNames()).toHaveLength(BROWSE_DISPLAY_PAGE_SIZE));
    // 渲染量等于一页：列表与文件树都是，目录再大也不会全量进 DOM。
    expect(treeNames()).toHaveLength(BROWSE_DISPLAY_PAGE_SIZE);
    expect(listNames()).not.toContain(name(total - 1));
    expect(listing.getByText("Showing 1–200 of 205 loaded items.")).toBeTruthy();

    // 翻页换的是下标窗口，不是不断加长同一个切片。
    fireEvent.click(listing.getByRole("button", { name: "Next items" }));
    await waitFor(() => expect(listNames()).toHaveLength(5));
    expect(listNames().at(-1)).toBe(name(total - 1));
    expect(listNames().at(0)).toBe(name(BROWSE_DISPLAY_PAGE_SIZE));
    expect(listing.getByText("Showing 201–205 of 205 loaded items.")).toBeTruthy();
    expect(listing.getByRole("button", { name: "Next items" })).toHaveProperty("disabled", true);

    // 翻回第一页：每一项都仍然可达。
    fireEvent.click(listing.getByRole("button", { name: "Previous items" }));
    await waitFor(() => expect(listNames()).toHaveLength(BROWSE_DISPLAY_PAGE_SIZE));
    expect(listNames().at(0)).toBe(name(0));
  });
});
