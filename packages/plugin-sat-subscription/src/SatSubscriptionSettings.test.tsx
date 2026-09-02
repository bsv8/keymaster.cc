// @vitest-environment jsdom

// SatSubscription 设置页组件契约：页面只调用 trusted admin/SPI service，
// 不直接打开 DB、发送网络请求或接触私钥。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  SatOwnerSupplierSettingsV1,
  SatSubscriptionAdminService,
  SatSubscriptionSettingsSnapshot,
  SatSubscriptionSpiService
} from "@keymaster/contracts";

const state = vi.hoisted(() => ({
  admin: undefined as unknown as SatSubscriptionAdminService,
  spi: undefined as unknown as SatSubscriptionSpiService,
  snapshot: undefined as unknown as SatSubscriptionSettingsSnapshot,
  invalidated: 0
}));

vi.mock("@keymaster/runtime", () => ({
  useCapability: <T,>(key: string): T => {
    if (key === "sat-subscription.service") return state.admin as unknown as T;
    if (key === "sat-subscription.spi.service") return state.spi as unknown as T;
    throw new Error(`unexpected capability: ${key}`);
  },
  useI18n: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? ""
  }),
  usePluginHost: () => ({ resourceStore: { invalidate: vi.fn(() => { state.invalidated += 1; }) } }),
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
    }],
    feeAudit: []
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
    setSubscription: vi.fn(async (input) => ({
      ok: true,
      ...input,
      requestIdHex: "aa".repeat(32),
      chargedAmount: "1"
    })),
    publish: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    refreshSubscriptions: vi.fn(async () => ({ channels: [], chargedAmount: "0" })),
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

  it("requires the remote Subscribe result before changing the local receive intent", async () => {
    makeServices();
    render(<SatSubscriptionSettings />);

    await waitFor(() => expect(screen.getByText("Supplier A")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "启用接收（可能收费）" }));

    await waitFor(() => expect(state.admin.setSubscription).toHaveBeenCalledWith({
      supplierId: "supplier-a",
      channel: `bsv8.inbox.${OWNER}`,
      subscribed: true
    }));
    expect(state.admin.setOwnerSettings).toHaveBeenCalledWith(expect.objectContaining({
      ownerPublicKeyHex: OWNER,
      receiveSupplierIds: ["supplier-a"]
    }));
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
});
