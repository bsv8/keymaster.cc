// @vitest-environment jsdom

// 首页文件获取组件的关键交互：本地 Hash 校验、唯一候选自动读取、
// 多供应商必须明确选择，以及 256 MiB 边界在 Read 之前阻断。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MsFileReadResult, MsFileService, MsFileSettingsSnapshot, MsFileStatResult, MsFileSupplierStat } from "@keymaster/contracts";
import { MsFileHomeFileWidget } from "./MsFileHomeFileWidget.js";

const HASH = "aa".repeat(32);
const HASH_TWO = "cc".repeat(32);
const BLOCK_HASH = "bb".repeat(32);
const SUPPLIER_A = `02${"11".repeat(32)}`;
const SUPPLIER_B = `03${"22".repeat(32)}`;

const state = vi.hoisted(() => ({
  service: undefined as unknown as MsFileService,
  vault: "unlocked" as "locked" | "unlocked",
  status: { status: "ready", globalSettings: { seedMaxPriceSatoshis: "100", blockMaxPriceSatoshis: "100" }, supplierGeneration: 1 },
  lifecycle: { activePublicKeyHex: "02" + "33".repeat(32), generation: 1 },
}));

vi.mock("@keymaster/runtime", () => ({
  useCapability: <T,>(_key: string): T => state.service as unknown as T,
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      let value = String(options?.defaultValue ?? key);
      return value.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ""));
    },
  }),
  usePluginHost: () => ({ resourceStore: {} }),
  useResourceSelector: <T,>(_store: unknown, id: string, _args: readonly string[], _selector: unknown): T =>
    (id === "msfile.status" ? state.status : state.lifecycle) as unknown as T,
  useRuntimeStatus: () => ({ vault: state.vault }),
  AppLink: ({ children }: { children?: unknown }) => children,
}));

function bytesFromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!.map((pair) => Number.parseInt(pair, 16)));
}

function response(contentHashHex: string, bytes: Uint8Array): MsFileReadResult {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return { contentHashHex, content: { $type: "binary", bytes: buffer } };
}

function settingsSnapshot(): MsFileSettingsSnapshot {
  return {
    globalSettings: { seedMaxPriceSatoshis: "100", blockMaxPriceSatoshis: "100" },
    suppliers: [
      { name: "Alpha", supplierPublicKeyHex: SUPPLIER_A, addresses: [], enabled: true },
      { name: "Beta", supplierPublicKeyHex: SUPPLIER_B, addresses: [], enabled: true },
    ],
    supplierGeneration: 1,
  };
}

function makeService(overrides: Partial<MsFileService> = {}): MsFileService {
  return {
    status: () => "ready",
    subscribe: vi.fn(() => () => undefined),
    getSettingsSnapshot: vi.fn(async () => settingsSnapshot()),
    updateGlobalPriceSettings: vi.fn(async () => undefined),
    upsertSupplier: vi.fn(async () => undefined),
    deleteSupplier: vi.fn(async () => undefined),
    probeSupplier: vi.fn(),
    updateAppPriceOverride: vi.fn(async () => undefined),
    clearAppPriceOverride: vi.fn(async () => undefined),
    listAppAuthorizations: vi.fn(async () => []),
    listPendingApprovals: () => [],
    resolveApproval: vi.fn(async () => undefined),
    abortSession: vi.fn(async () => undefined),
    stat: vi.fn(),
    readSeed: vi.fn(),
    readBlock: vi.fn(),
    connect: undefined as never,
    ...overrides,
  } as unknown as MsFileService;
}

async function renderReady(service: MsFileService) {
  state.service = service;
  const rendered = render(<MsFileHomeFileWidget />);
  await waitFor(() => expect(service.getSettingsSnapshot).toHaveBeenCalled());
  await waitFor(() => expect((screen.getByRole("button", { name: "查询文件" }) as HTMLButtonElement).disabled).toBe(false));
  return rendered;
}

function submit(hash = HASH): void {
  const input = screen.getByLabelText("Seed Hash") as HTMLInputElement;
  fireEvent.change(input, { target: { value: hash } });
  fireEvent.submit(input.closest("form")!);
}

afterEach(() => cleanup());

beforeEach(() => {
  state.vault = "unlocked";
  state.status = { status: "ready", globalSettings: { seedMaxPriceSatoshis: "100", blockMaxPriceSatoshis: "100" }, supplierGeneration: 1 };
  state.lifecycle = { activePublicKeyHex: "02" + "33".repeat(32), generation: 1 };
});

describe("MsFileHomeFileWidget", () => {
  it("rejects a non-canonical Hash without calling Stat", async () => {
    const service = makeService();
    await renderReady(service);

    submit(HASH.toUpperCase());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Seed Hash 必须是 64 位小写十六进制字符"));
    expect(service.stat).not.toHaveBeenCalled();
  });

  it("automatically reads one candidate and previews verified text", async () => {
    const service = makeService({
      stat: vi.fn(async (): Promise<MsFileStatResult> => ({
        seedHashHex: HASH,
        suppliers: [{ supplierPublicKeyHex: SUPPLIER_A, status: "available", recommendedFilename: "note.txt", fileSizeBytes: "5", mediaType: "text/plain" }],
      })),
      readSeed: vi.fn(async (input: { seedHashHex: string }) => response(input.seedHashHex, bytesFromHex(BLOCK_HASH))),
      readBlock: vi.fn(async (input: { blockHashHex: string }) => response(input.blockHashHex, new TextEncoder().encode("hello"))),
    });
    await renderReady(service);

    submit();
    await waitFor(() => expect(screen.getByText("hello")).toBeTruthy());
    expect(service.readSeed).toHaveBeenCalledWith(expect.objectContaining({ supplierPublicKeyHex: SUPPLIER_A, seedHashHex: HASH }));
    expect(service.readBlock).toHaveBeenCalledWith(expect.objectContaining({ supplierPublicKeyHex: SUPPLIER_A, blockHashHex: BLOCK_HASH }));
    expect(service.readSeed).not.toHaveBeenCalledWith(expect.objectContaining({ maxPriceSatoshis: expect.anything() }));
    expect(service.readBlock).not.toHaveBeenCalledWith(expect.objectContaining({ maxPriceSatoshis: expect.anything() }));
  });

  it("requires an explicit supplier choice when multiple candidates exist", async () => {
    const service = makeService({
      stat: vi.fn(async (): Promise<MsFileStatResult> => ({
        seedHashHex: HASH,
        suppliers: [
          { supplierPublicKeyHex: SUPPLIER_A, status: "available", recommendedFilename: "a.bin", fileSizeBytes: "0", mediaType: "application/octet-stream" },
          { supplierPublicKeyHex: SUPPLIER_B, status: "quoted", recommendedFilename: "b.bin", fileSizeBytes: "0", mediaType: "application/octet-stream", minSeedPriceSatoshis: "1", maxSeedPriceSatoshis: "2", minFullBlockPriceSatoshis: "3", maxFullBlockPriceSatoshis: "4" },
        ],
      })),
      readSeed: vi.fn(async (input: { seedHashHex: string }) => response(input.seedHashHex, new Uint8Array())),
    });
    await renderReady(service);

    submit();
    await waitFor(() => expect(screen.getAllByRole("button", { name: "选择此供应商" })).toHaveLength(2));
    expect(service.readSeed).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole("button", { name: "选择此供应商" })[1]!);
    fireEvent.click(await screen.findByRole("button", { name: "下载" }));
    await waitFor(() => expect(service.readSeed).toHaveBeenCalledWith(expect.objectContaining({ supplierPublicKeyHex: SUPPLIER_B })));
  });

  it("blocks files over 256 MiB before Seed Read", async () => {
    const service = makeService({
      stat: vi.fn(async (): Promise<MsFileStatResult> => ({
        seedHashHex: HASH,
        suppliers: [{ supplierPublicKeyHex: SUPPLIER_A, status: "available", recommendedFilename: "large.bin", fileSizeBytes: String(256 * 1024 * 1024 + 1), mediaType: "application/octet-stream" }],
      })),
    });
    await renderReady(service);

    submit();
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("256 MiB"));
    expect(service.readSeed).not.toHaveBeenCalled();
    expect(service.readBlock).not.toHaveBeenCalled();
  });

  it.each([
    { status: "available" as const, expected: "可获取" },
    { status: "quoted" as const, expected: "有报价" },
    { status: "absent" as const, expected: "没有文件" },
    { status: "discovering" as const, expected: "发现中" },
    { status: "network-error" as const, expected: "暂时不可用" },
  ])("keeps the Stat status $status distinct", async ({ status, expected }) => {
    const base = { supplierPublicKeyHex: SUPPLIER_A };
    const entry: MsFileSupplierStat = status === "available"
      ? { ...base, status, recommendedFilename: "available.bin", fileSizeBytes: "0", mediaType: "application/octet-stream" }
      : status === "quoted"
        ? { ...base, status, recommendedFilename: "quoted.bin", fileSizeBytes: "0", mediaType: "application/octet-stream", minSeedPriceSatoshis: "1", maxSeedPriceSatoshis: "2", minFullBlockPriceSatoshis: "3", maxFullBlockPriceSatoshis: "4" }
        : status === "discovering"
          ? { ...base, status, retryAfterMs: 500 }
          : { ...base, status };
    const service = makeService({
      stat: vi.fn(async (): Promise<MsFileStatResult> => ({ seedHashHex: HASH, suppliers: [entry] })),
    });
    await renderReady(service);

    submit();
    await waitFor(() => expect(screen.getByText(expected, { exact: true })).toBeTruthy());
  });

  it("cancels an in-flight read when the Vault locks", async () => {
    let resolveSeed!: (value: MsFileReadResult) => void;
    let readSignal: AbortSignal | undefined;
    const service = makeService({
      stat: vi.fn(async (): Promise<MsFileStatResult> => ({
        seedHashHex: HASH,
        suppliers: [{ supplierPublicKeyHex: SUPPLIER_A, status: "available", recommendedFilename: "locked.txt", fileSizeBytes: "5", mediaType: "text/plain" }],
      })),
      readSeed: vi.fn((input: { signal?: AbortSignal }) => {
        readSignal = input.signal;
        return new Promise<MsFileReadResult>((resolve) => { resolveSeed = resolve; });
      }),
    });
    const rendered = await renderReady(service);

    submit();
    await waitFor(() => expect(service.readSeed).toHaveBeenCalled());
    state.vault = "locked";
    rendered.rerender(<MsFileHomeFileWidget />);
    await waitFor(() => expect(readSignal?.aborted).toBe(true));
    await waitFor(() => expect(screen.getByText("文件获取已取消。", { exact: true })).toBeTruthy());
    resolveSeed(response(HASH, bytesFromHex(BLOCK_HASH)));
  });

  it("cancels an in-flight read when the active key changes", async () => {
    let resolveSeed!: (value: MsFileReadResult) => void;
    let readSignal: AbortSignal | undefined;
    const service = makeService({
      stat: vi.fn(async (): Promise<MsFileStatResult> => ({
        seedHashHex: HASH,
        suppliers: [{ supplierPublicKeyHex: SUPPLIER_A, status: "available", recommendedFilename: "switched.txt", fileSizeBytes: "5", mediaType: "text/plain" }],
      })),
      readSeed: vi.fn((input: { signal?: AbortSignal }) => {
        readSignal = input.signal;
        return new Promise<MsFileReadResult>((resolve) => { resolveSeed = resolve; });
      }),
    });
    const rendered = await renderReady(service);

    submit();
    await waitFor(() => expect(service.readSeed).toHaveBeenCalled());
    state.lifecycle = { activePublicKeyHex: "03" + "44".repeat(32), generation: 2 };
    rendered.rerender(<MsFileHomeFileWidget />);
    await waitFor(() => expect(readSignal?.aborted).toBe(true));
    await waitFor(() => expect(screen.getByText("文件获取已取消。", { exact: true })).toBeTruthy());
    resolveSeed(response(HASH, bytesFromHex(BLOCK_HASH)));
  });

  it("cancels an in-flight read when the supplier generation changes", async () => {
    let resolveSeed!: (value: MsFileReadResult) => void;
    let readSignal: AbortSignal | undefined;
    const service = makeService({
      getSettingsSnapshot: vi.fn(async () => ({ ...settingsSnapshot(), supplierGeneration: state.status.supplierGeneration })),
      stat: vi.fn(async (): Promise<MsFileStatResult> => ({
        seedHashHex: HASH,
        suppliers: [{ supplierPublicKeyHex: SUPPLIER_A, status: "available", recommendedFilename: "generation.txt", fileSizeBytes: "5", mediaType: "text/plain" }],
      })),
      readSeed: vi.fn((input: { signal?: AbortSignal }) => {
        readSignal = input.signal;
        return new Promise<MsFileReadResult>((resolve) => { resolveSeed = resolve; });
      }),
    });
    const rendered = await renderReady(service);

    submit();
    await waitFor(() => expect(service.readSeed).toHaveBeenCalled());
    state.status = { ...state.status, supplierGeneration: 2 };
    rendered.rerender(<MsFileHomeFileWidget />);
    await waitFor(() => expect(readSignal?.aborted).toBe(true));
    await waitFor(() => expect(screen.getByText("文件获取已取消。", { exact: true })).toBeTruthy());
    resolveSeed(response(HASH, bytesFromHex(BLOCK_HASH)));
  });

  it("does not let a late Stat result overwrite a newer Hash query", async () => {
    let resolveFirstStat!: (value: MsFileStatResult) => void;
    const service = makeService({
      stat: vi.fn()
        .mockImplementationOnce(() => new Promise<MsFileStatResult>((resolve) => { resolveFirstStat = resolve; }))
        .mockImplementationOnce(async (input: { seedHashHex: string }): Promise<MsFileStatResult> => ({
          seedHashHex: input.seedHashHex,
          suppliers: [{ supplierPublicKeyHex: SUPPLIER_A, status: "available", recommendedFilename: "new-query.bin", fileSizeBytes: "0", mediaType: "application/octet-stream" }],
        })),
    });
    await renderReady(service);

    submit(HASH);
    await waitFor(() => expect(service.stat).toHaveBeenCalledTimes(1));
    submit(HASH_TWO);
    await waitFor(() => expect(service.stat).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getAllByText("new-query.bin", { exact: true }).length).toBeGreaterThan(0));
    resolveFirstStat({
      seedHashHex: HASH,
      suppliers: [{ supplierPublicKeyHex: SUPPLIER_A, status: "absent" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getAllByText("new-query.bin", { exact: true }).length).toBeGreaterThan(0);
    expect(screen.queryByText("该供应商没有此文件。", { exact: true })).toBeNull();
  });

  it("releases the verified file and Blob URL when triggering a download fails", async () => {
    const service = makeService({
      stat: vi.fn(async (): Promise<MsFileStatResult> => ({
        seedHashHex: HASH,
        suppliers: [{ supplierPublicKeyHex: SUPPLIER_A, status: "available", recommendedFilename: "unsafe.bin", fileSizeBytes: "0", mediaType: "application/octet-stream" }],
      })),
      readSeed: vi.fn(async (input: { seedHashHex: string }) => response(input.seedHashHex, new Uint8Array())),
    });
    const urlConstructor = URL as typeof URL & {
      createObjectURL?: (blob: Blob) => string;
      revokeObjectURL?: (url: string) => void;
    };
    const originalCreateObjectURL = urlConstructor.createObjectURL;
    const originalRevokeObjectURL = urlConstructor.revokeObjectURL;
    const createObjectURL = vi.fn(() => "blob:msfile-download");
    const revokeObjectURL = vi.fn();
    let clickedDownloadFilename = "";
    Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clickedDownloadFilename = this.download;
      throw new Error("browser download dispatch failed");
    });

    try {
      await renderReady(service);
      submit();
      fireEvent.click(await screen.findByRole("button", { name: "下载" }));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("浏览器无法创建下载文件"));

      // 失败后仍保留可诊断元数据，但已验证的文件和 Blob URL 必须被清掉。
      expect(screen.getAllByText("unsafe.bin", { exact: true }).length).toBeGreaterThan(0);
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:msfile-download");
      expect(clickedDownloadFilename).toBe("unsafe.bin");
      expect(click).toHaveBeenCalledTimes(1);
    } finally {
      click.mockRestore();
      if (originalCreateObjectURL) Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: originalCreateObjectURL });
      else Reflect.deleteProperty(URL, "createObjectURL");
      if (originalRevokeObjectURL) Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: originalRevokeObjectURL });
      else Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  });
});
