// @vitest-environment jsdom

// SatSubscription 设置页组件契约：页面只调用 trusted admin/SPI service，
// 不直接打开 DB、发送网络请求或接触私钥。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  SatOwnerSupplierSettingsV1,
  SatSubscriptionAdminService,
  SatSubscriptionSettingsSnapshot,
  SatSubscriptionSpiService,
  SatTopUpPreview
} from "@keymaster/contracts";
import { SAT_SUBSCRIPTION_SERVICE_CAPABILITY, SAT_SUBSCRIPTION_SPI_SERVICE_CAPABILITY } from "@keymaster/contracts";

const state = vi.hoisted(() => ({
  admin: undefined as unknown as SatSubscriptionAdminService,
  spi: undefined as unknown as SatSubscriptionSpiService,
  snapshot: undefined as unknown as SatSubscriptionSettingsSnapshot,
  invalidated: 0
}));

vi.mock("@keymaster/runtime", () => ({
  useI18n: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? ""
  }),
  usePluginHost: () => ({ resourceStore: { invalidate: vi.fn(() => { state.invalidated += 1; }) } }),
  useOptionalResourceSelector: <T,>(
    _store: unknown,
    _id: string,
    _args: readonly string[],
    selector: (resource: { data?: unknown }) => T,
    _fallback: T
  ): T => selector({ data: state.snapshot })
}));

vi.mock("webloom-framework/react", () => ({
  useCapability: <T,>(key: { id?: string }): T => {
    if (key.id === SAT_SUBSCRIPTION_SERVICE_CAPABILITY.id) return state.admin as unknown as T;
    if (key.id === SAT_SUBSCRIPTION_SPI_SERVICE_CAPABILITY.id) return state.spi as unknown as T;
    throw new Error(`unexpected capability: ${key}`);
  },
  useOptionalCapability: <T,>(key: { id?: string }): T => {
    if (key.id === SAT_SUBSCRIPTION_SERVICE_CAPABILITY.id) return state.admin as unknown as T;
    if (key.id === SAT_SUBSCRIPTION_SPI_SERVICE_CAPABILITY.id) return state.spi as unknown as T;
    throw new Error(`unexpected capability: ${key}`);
  },
  useResourceSelector: <T,>(
    _store: unknown,
    _id: string,
    _args: readonly string[],
    selector: (resource: { data?: unknown }) => T
  ): T => selector({ data: state.snapshot })
}));

import { SatSubscriptionSettings } from "./SatSubscriptionSettings.js";

const OWNER = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const SUPPLIER_KEY = "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";

function makeSnapshot(): SatSubscriptionSettingsSnapshot {
  return {
    ownerPublicKeyHex: OWNER,
    supplierGeneration: 1,
    suppliers: [{
      supplierId: "supplier-a",
      name: "Supplier A",
      supplierPublicKeyHex: SUPPLIER_KEY,
      multiaddrs: ["/ip4/127.0.0.1/tcp/4001"],
      enabled: true
    }],
    ownerSettings: {
      ownerPublicKeyHex: OWNER,
      defaultPublishSupplierId: null,
      receiveSupplierIds: []
    },
    supplierViews: [{
      supplierId: "supplier-a",
      name: "Supplier A",
      supplierPublicKeyHex: SUPPLIER_KEY,
      connectionState: "online",
      inboxChannel: null,
      desiredChannels: [],
      observedChannels: [],
      lastChargedAmount: null,
      lastErrorCode: null
    }]
  };
}

function makeServices(): void {
  state.snapshot = makeSnapshot();
  state.invalidated = 0;
  state.admin = {
    getSettingsSnapshot: vi.fn(async () => state.snapshot),
    upsertSupplier: vi.fn(async () => undefined),
    deleteSupplier: vi.fn(async () => undefined),
    setOwnerSettings: vi.fn(async (_settings: SatOwnerSupplierSettingsV1) => undefined),
    refreshSubscriptions: vi.fn(async () => ({ channels: [], chargedAmount: "0" })),
    getBilling: vi.fn(async () => ({ supplierId: "supplier-a", currency: "BSV", network: "mainnet", records: [], nextCursor: "" })),
    subscribeEvents: vi.fn(() => () => undefined)
  } as unknown as SatSubscriptionAdminService;
  state.spi = {
    getInformation: vi.fn(),
    prepareTopUp: vi.fn(),
    submitTopUp: vi.fn(),
    collectNew: vi.fn(),
    retryCollect: vi.fn(),
    collect: vi.fn()
  } as unknown as SatSubscriptionSpiService;
}

afterEach(() => cleanup());

describe("SatSubscriptionSettings", () => {
  it("edits a supplier through the admin service and preserves its identity fields", async () => {
    makeServices();
    render(<SatSubscriptionSettings />);

    await waitFor(() => expect(screen.getByText("Supplier A")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByDisplayValue("Supplier A"), { target: { value: "Supplier A renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "保存供应商" }));

    await waitFor(() => expect(state.admin.upsertSupplier).toHaveBeenCalledWith(expect.objectContaining({
      supplierId: "supplier-a",
      name: "Supplier A renamed",
      supplierPublicKeyHex: SUPPLIER_KEY,
      enabled: true
    })));
    expect(state.invalidated).toBeGreaterThan(0);
  });

  it("changes only the receive Supplier intent and lets Coordinator reconcile physical subscriptions", async () => {
    makeServices();
    render(<SatSubscriptionSettings />);

    await waitFor(() => expect(screen.getByText("Supplier A")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "启用接收（可能收费）" }));

    await waitFor(() => expect(state.admin.setOwnerSettings).toHaveBeenCalledWith(expect.objectContaining({
      ownerPublicKeyHex: OWNER,
      receiveSupplierIds: ["supplier-a"]
    })));
    expect("setSubscription" in state.admin).toBe(false);
  });

  it("confirms deletion and does not imply automatic balance collection", async () => {
    makeServices();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SatSubscriptionSettings />);

    await waitFor(() => expect(screen.getByText("Supplier A")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() => expect(state.admin.deleteSupplier).toHaveBeenCalledWith("supplier-a"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("不会自动回收"));
    confirm.mockRestore();
  });

  it("uses the displayed testnet account for top-up and Collect confirmations", async () => {
    makeServices();
    const account = {
      currency: "BSV",
      network: "testnet",
      paymentAddress: "mqrAdPBmbvhLohuqFneSmn8TfZahUvu9eJ",
      balance: 10_000n
    } as const;
    state.spi.getInformation = vi.fn(async () => ({
      supplierId: "supplier-a",
      ownerPublicKeyHex: OWNER,
      currencies: [account],
      projectType: "test",
      projectInfoCbor: new Uint8Array(),
      observedAtMs: 1
    }));
    state.spi.prepareTopUp = vi.fn(async () => ({
      supplierId: "supplier-a",
      paymentAddress: account.paymentAddress,
      network: "testnet",
      amountSatoshis: 1000n,
      p2pkhPreview: { changeAddress: "mowner", estimatedFeeSatoshis: 5 }
    } satisfies SatTopUpPreview));
    state.spi.collectNew = vi.fn(async () => ({
      requestIdHex: "aa".repeat(32),
      supplierId: "supplier-a",
      currency: "BSV",
      network: "testnet",
      amount: 1000n,
      paymentAddress: "mowner",
      state: "succeeded" as const
    }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SatSubscriptionSettings />);

    fireEvent.click(screen.getByRole("button", { name: "刷新 SPI 余额" }));
    await waitFor(() => expect(screen.getByText(/BSV\/testnet/)).toBeTruthy());
    const prepareButton = screen.getByRole("button", { name: "生成充值预览" });
    fireEvent.click(prepareButton);
    await waitFor(() => expect(state.spi.prepareTopUp).toHaveBeenCalledWith({
      supplierId: "supplier-a",
      currency: "BSV",
      network: "testnet",
      amountSatoshis: 1000n
    }));
    fireEvent.click(screen.getByRole("button", { name: "确认并广播" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.stringContaining("BSV 测试网")));

    const collectButton = screen.getAllByRole("button", { name: "回收余额" })[0]!;
    fireEvent.click(collectButton);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("BSV 测试网"));
    await waitFor(() => expect(state.spi.collectNew).toHaveBeenCalledWith({
      supplierId: "supplier-a",
      currency: "BSV",
      network: "testnet",
      amount: 1000n
    }));
    confirm.mockRestore();
  });

  it("用红绿灯显示连接状态（绿灯=已连接，中文可读）", async () => {
    makeServices();
    render(<SatSubscriptionSettings />);

    await waitFor(() => expect(screen.getByTestId("ss-connection-light-supplier-a")).toBeTruthy());
    const light = screen.getByTestId("ss-connection-light-supplier-a");
    expect(light.getAttribute("data-state")).toBe("online");
    expect(light.getAttribute("aria-label")).toContain("已连接");
    expect(screen.getByTestId("ss-connection-status-supplier-a").textContent).toContain("已连接");
  });

  it("账单翻页复用同一会话时间范围（cursor 绑定 fromMs/toMs/limit）", async () => {
    makeServices();
    const firstPage = {
      supplierId: "supplier-a",
      currency: "BSV",
      network: "testnet",
      records: [{
        supplierId: "supplier-a",
        chargeId: "charge-1",
        occurredAtMs: 1_700_000_000_000n,
        action: "ssp-publish",
        channel: "bsv8.inbox.x",
        sourceRequestIdHex: "aa",
        chargedAmount: "0"
      }],
      nextCursor: "cursor-2"
    };
    const secondPage = {
      supplierId: "supplier-a",
      currency: "BSV",
      network: "testnet",
      records: [{
        supplierId: "supplier-a",
        chargeId: "charge-2",
        occurredAtMs: 1_700_000_000_001n,
        action: "ssp-subscribe",
        channel: "bsv8.inbox.x",
        sourceRequestIdHex: "bb",
        chargedAmount: "0"
      }],
      nextCursor: ""
    };
    state.admin.getBilling = vi.fn(async (input: { cursor: string; limit: number; fromMs: bigint; toMs: bigint }) => {
      if (input.cursor === "") return firstPage;
      if (input.cursor === "cursor-2") return secondPage;
      throw new Error(`unexpected cursor ${input.cursor}`);
    }) as unknown as SatSubscriptionAdminService["getBilling"];
    render(<SatSubscriptionSettings />);

    await waitFor(() => expect(screen.getByTestId("ss-billing-panel-supplier-a")).toBeTruthy());
    // 首页：默认每页 5 条，cursor=""，创建新会话。
    fireEvent.click(screen.getByRole("button", { name: "查询服务器账单" }));
    await waitFor(() => expect(screen.getByTestId("ss-billing-record-supplier-a-charge-1")).toBeTruthy());
    expect(state.admin.getBilling).toHaveBeenCalledWith(expect.objectContaining({ supplierId: "supplier-a", cursor: "", limit: 5 }));
    expect(screen.getByTestId("ss-billing-status-supplier-a").textContent).toContain("第 1 页");
    type BillingCall = { cursor: string; limit: number; fromMs: bigint; toMs: bigint };
    const billingCalls = () =>
      (state.admin.getBilling as unknown as { mock: { calls: Array<[BillingCall]> } }).mock.calls.map((args) => args[0]);
    const firstCall = billingCalls()[0]!;

    // 下一页：透传 nextCursor，且必须复用同一 fromMs/toMs/limit（否则服务端拒收 cursor）。
    const nextButton = screen.getByRole("button", { name: "下一页" });
    expect(nextButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(nextButton);
    await waitFor(() => expect(screen.getByTestId("ss-billing-record-supplier-a-charge-2")).toBeTruthy());
    expect(state.admin.getBilling).toHaveBeenCalledWith(expect.objectContaining({ cursor: "cursor-2", limit: 5 }));
    expect(screen.getByTestId("ss-billing-status-supplier-a").textContent).toContain("第 2 页");
    const calls = billingCalls();
    expect(calls[1]!.fromMs).toBe(firstCall.fromMs);
    expect(calls[1]!.toMs).toBe(firstCall.toMs);
    expect(calls[1]!.limit).toBe(firstCall.limit);

    // 上一页：回到首页游标并重新查询，仍复用同一会话时间范围。
    const prevButton = screen.getByRole("button", { name: "上一页" });
    expect(prevButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(prevButton);
    await waitFor(() => expect(screen.getByTestId("ss-billing-record-supplier-a-charge-1")).toBeTruthy());
    const callsAfterPrev = billingCalls();
    expect(callsAfterPrev[2]!.cursor).toBe("");
    expect(callsAfterPrev[2]!.fromMs).toBe(firstCall.fromMs);
    expect(callsAfterPrev[2]!.toMs).toBe(firstCall.toMs);
    expect(callsAfterPrev[2]!.limit).toBe(5);

    // 每页条数切换：创建新会话，首页重新查询（cursor="" + 新 limit）。
    const limitSelect = screen.getByTestId("ss-billing-limit-supplier-a") as HTMLSelectElement;
    fireEvent.change(limitSelect, { target: { value: "2" } });
    await waitFor(() => expect(state.admin.getBilling).toHaveBeenCalledWith(expect.objectContaining({ cursor: "", limit: 2 })));
  });
});
