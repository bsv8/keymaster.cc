// @vitest-environment jsdom

// 桶存储文件页面的关键交互：列表渲染（含元数据缺失）、单文件上传并刷新、
// 校验提示、删除确认。服务通过 capability 提供，页面不接触真实存储。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { MsFileSeedEntry } from "./storage/msfileSeedStore.js";
import type { MsFileBucketService } from "./msfileBucketService.js";
import { MsFileBucketPage } from "./MsFileBucketPage.js";

const HASH = "4f8b42c22dd3729b519ba6f68d2da7cc5b2d606d05daed5ad5128cc03e6c6358";

// 与真实 @keymaster/runtime 对齐：useI18n 返回的 t 必须跨渲染稳定
// （runtime 用 useMemo 锁定），否则放进 useCallback 依赖会让 effect 每次都跑。
const mocks = vi.hoisted(() => ({
  t: (key: string, options?: Record<string, unknown>) => {
    let value = String(options?.defaultValue ?? key);
    value = value.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ""));
    return value;
  },
  host: { resourceStore: {}, resourceRegistry: { get: () => ({}) } },
  state: {
    service: undefined as unknown as MsFileBucketService,
    vault: "unlocked" as "locked" | "unlocked",
    lifecycle: { activePublicKeyHex: `02${"33".repeat(32)}`, generation: 1 },
  },
}));

const state = mocks.state;

vi.mock("@keymaster/runtime", () => ({
  useI18n: () => ({ t: mocks.t }),
  usePluginHost: () => mocks.host,
  useRuntimeStatus: () => ({ vault: mocks.state.vault }),
}));

vi.mock("webloom-framework/react", () => ({
  useOptionalCapability: <T,>(_key: unknown): T | undefined => state.service as unknown as T,
  useResourceSelector: () => state.lifecycle,
}));

function entryWithMeta(): MsFileSeedEntry {
  return {
    seedHashHex: HASH,
    seedFileSizeBytes: "32",
    meta: {
      seedHashHex: HASH,
      fileName: "abc.txt",
      mediaType: "text/plain",
      fileSizeBytes: "3",
      blockCount: 1,
      seedSizeBytes: "32",
      storedAt: "2026-09-19T08:00:00.000Z",
    },
  };
}

function makeService(overrides: Partial<MsFileBucketService> = {}): MsFileBucketService {
  return {
    list: vi.fn(async () => []),
    upload: vi.fn(async () => ({ entry: entryWithMeta(), meta: entryWithMeta().meta! })),
    read: vi.fn(),
    verify: vi.fn(async () => ({ metaAvailable: true, blockCount: "1", verifiedBlocks: 1 })),
    remove: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as MsFileBucketService;
}

async function renderPage(service: MsFileBucketService) {
  state.service = service;
  const rendered = render(<MsFileBucketPage />);
  await waitFor(() => expect(service.list).toHaveBeenCalled());
  return rendered;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  state.vault = "unlocked";
});

describe("MsFileBucketPage", () => {
  it("renders stored entries and marks missing metadata", async () => {
    const service = makeService({
      list: vi.fn(async () => [entryWithMeta(), { seedHashHex: "aa".repeat(32), meta: null }]),
    });
    await renderPage(service);
    await screen.findByText("abc.txt");
    expect(screen.getByText("text/plain")).toBeTruthy();
    expect(screen.getByText("元数据缺失")).toBeTruthy();
  });

  it("uploads a single file and reloads the list", async () => {
    const service = makeService();
    await renderPage(service);
    const input = screen.getByLabelText("选择文件并上传") as HTMLInputElement;
    const file = new File([new Uint8Array([0x61, 0x62, 0x63])], "abc.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(service.upload).toHaveBeenCalledTimes(1));
    const source = (service.upload as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { name: string };
    expect(source.name).toBe("abc.txt");
    await waitFor(() => expect(service.list).toHaveBeenCalledTimes(2));
  });

  it("verifies an entry and shows the verified block count", async () => {
    const service = makeService({ list: vi.fn(async () => [entryWithMeta()]) });
    await renderPage(service);
    fireEvent.click(await screen.findByRole("button", { name: "校验" }));
    await waitFor(() => expect(service.verify).toHaveBeenCalledWith(HASH, expect.anything()));
    await screen.findByText(/校验通过：种子、1 个文件块/);
  });

  it("deletes an entry after confirmation", async () => {
    const service = makeService({ list: vi.fn(async () => [entryWithMeta()]) });
    await renderPage(service);
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(service.remove).toHaveBeenCalledWith(HASH, expect.anything()));
    await waitFor(() => expect(service.list).toHaveBeenCalledTimes(2));
    await screen.findByText(/条目已删除/);
  });
});
