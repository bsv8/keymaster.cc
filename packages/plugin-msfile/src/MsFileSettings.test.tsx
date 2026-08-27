// @vitest-environment jsdom

// packages/plugin-msfile/src/MsFileSettings.test.tsx
// 设置页交互：空金额不得变成 0、供应商表单提交形状、App override 编辑与恢复继承。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import type {
  MsFileAppAuthorizationView,
  MsFileService,
  MsFileSettingsSnapshot,
} from "@keymaster/contracts";
import { MsFileSettings } from "./MsFileSettings.js";
import { OWNER_PUBKEY, SUPPLIER_PEER_ID, SUPPLIER_PUBKEY } from "./supplierConfig.test.js";

const SUPPLIER_ADDRESS = `/dns4/nas.example.com/udp/4001/webrtc-direct/certhash/uEiDu8SJ7IdK9W_PfRJfV0clhOP6mG0zNXcZQ8bBhC9ipwg/p2p/${SUPPLIER_PEER_ID}`;

const state = vi.hoisted(() => ({
  service: undefined as unknown as MsFileService,
  resource: undefined as unknown as { status: string; globalSettings: unknown; approvals: unknown[] },
  lastJson: "",
  lastSelected: undefined as unknown
}));

vi.mock("@keymaster/runtime", () => ({
  useCapability: <T,>(_key: string): T => state.service as unknown as T,
  useI18n: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }),
  usePluginHost: () => ({ resourceStore: {} }),
  useRuntimeStatus: () => ({ vault: "unlocked" }),
  // 模拟真实 useResourceSelector 的 equality 语义：内容不变返回同一引用，
  // 否则组件的 effect 会因对象身份变化而无限重跑。
  useResourceSelector: <T,>(_store: unknown, _id: string, _args: readonly string[], selector: (snapshot: { data?: unknown }) => T): T => {
    const selected = selector({ data: state.resource }) as unknown;
    const json = JSON.stringify(selected);
    if (json !== state.lastJson || state.lastSelected === undefined) {
      state.lastJson = json;
      state.lastSelected = selected;
    }
    return state.lastSelected as T;
  }
}));

function snapshot(overrides: Partial<MsFileSettingsSnapshot> = {}): MsFileSettingsSnapshot {
  return {
    globalSettings: { seedMaxPriceSatoshis: "5000", blockMaxPriceSatoshis: "1000" },
    suppliers: [
      {
        name: "nas",
        supplierPublicKeyHex: SUPPLIER_PUBKEY,
        addresses: [SUPPLIER_ADDRESS],
        enabled: true
      }
    ],
    supplierGeneration: 3,
    ...overrides
  };
}

function makeService(overrides: Partial<MsFileService> = {}): MsFileService {
  return {
    status: () => "ready",
    subscribe: vi.fn(() => () => undefined),
    getSettingsSnapshot: vi.fn(async () => snapshot()),
    updateGlobalPriceSettings: vi.fn(async () => undefined),
    upsertSupplier: vi.fn(async () => undefined),
    deleteSupplier: vi.fn(async () => undefined),
    probeSupplier: vi.fn(async () => ({
      supplierPublicKeyHex: SUPPLIER_PUBKEY,
      peerId: SUPPLIER_PEER_ID,
      connected: true,
      startedAt: 1,
      durationMs: 2,
      addresses: []
    })),
    updateAppPriceOverride: vi.fn(async () => undefined),
    clearAppPriceOverride: vi.fn(async () => undefined),
    listAppAuthorizations: vi.fn(async () => [] as MsFileAppAuthorizationView[]),
    listPendingApprovals: () => [],
    resolveApproval: vi.fn(async () => undefined),
    abortSession: vi.fn(async () => undefined),
    stat: vi.fn(),
    readSeed: vi.fn(),
    readBlock: vi.fn(),
    connect: undefined as never,
    ...overrides
  } as unknown as MsFileService;
}

afterEach(() => cleanup());

describe("MsFileSettings", () => {
  it("renders existing price limits and saves explicit values only", async () => {
    const service = makeService();
    state.service = service;
    render(
      <StrictMode>
        <MsFileSettings />
      </StrictMode>
    );
    await waitFor(() => expect(screen.getByDisplayValue("5000")).toBeTruthy());
    const seedInput = screen.getByDisplayValue("5000") as HTMLInputElement;
    // 不限金额开关未开启时空输入不允许保存为 0。
    fireEvent.change(seedInput, { target: { value: "" } });
    const saveButton = screen.getByRole("button", { name: /^Save$/ });
    fireEvent.click(saveButton);
    await waitFor(() => expect(screen.getAllByText(/must be a positive amount/i).length).toBeGreaterThan(0));
    expect(service.updateGlobalPriceSettings).not.toHaveBeenCalled();

    fireEvent.change(seedInput, { target: { value: "777" } });
    fireEvent.click(saveButton);
    await waitFor(() => expect(service.updateGlobalPriceSettings).toHaveBeenCalled());
    expect(vi.mocked(service.updateGlobalPriceSettings).mock.calls[0]?.[0]).toEqual({
      seedMaxPriceSatoshis: "777",
      blockMaxPriceSatoshis: "1000"
    });
  });

  it("treats the unlimited toggle as an explicit zero save", async () => {
    const service = makeService();
    state.service = service;
    render(<MsFileSettings />);
    await waitFor(() => expect(screen.getByDisplayValue("5000")).toBeTruthy());
    const unlimitedToggles = screen.getAllByRole("checkbox");
    fireEvent.click(unlimitedToggles[0]!);
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(service.updateGlobalPriceSettings).toHaveBeenCalled());
    expect(vi.mocked(service.updateGlobalPriceSettings).mock.calls[0]?.[0]).toMatchObject({ seedMaxPriceSatoshis: "0" });
  });

  it("submits supplier drafts and probes via the service", async () => {
    const service = makeService();
    state.service = service;
    render(<MsFileSettings />);
    await waitFor(() => expect(screen.getByText("nas")).toBeTruthy());

    const testButton = screen.getByRole("button", { name: /test connection/i });
    fireEvent.click(testButton);
    await waitFor(() => expect(service.probeSupplier).toHaveBeenCalled());
    expect(vi.mocked(service.probeSupplier).mock.calls[0]?.[0]).toBe(SUPPLIER_PUBKEY);

    // 编辑既有供应商时公钥输入框禁用（不允许原地换 key）。
    fireEvent.click(screen.getByRole("button", { name: /Edit/i }));
    await waitFor(() => expect((screen.getAllByDisplayValue(SUPPLIER_PUBKEY)[0] as HTMLInputElement).disabled).toBe(true));
  });

  it("lists app authorizations with inherit/override state and restores inheritance", async () => {
    const view: MsFileAppAuthorizationView = {
      key: { ownerPublicKeyHex: OWNER_PUBKEY, publisherPublicKeyHex: OWNER_PUBKEY, appId: "player.example" },
      appName: "Player",
      firstSeenAt: 1,
      lastSeenAt: 2,
      policy: {
        key: { ownerPublicKeyHex: OWNER_PUBKEY, publisherPublicKeyHex: OWNER_PUBKEY, appId: "player.example" },
        override: { seedMaxPriceSatoshis: "250" },
        updatedAt: 2
      }
    };
    const service = makeService({ listAppAuthorizations: vi.fn(async () => [view]) });
    state.service = service;
    render(<MsFileSettings />);
    await waitFor(() => expect(screen.getByText("Player")).toBeTruthy());
    expect(screen.getByText(/250/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /restore inheritance/i }));
    await waitFor(() =>
      expect(service.clearAppPriceOverride).toHaveBeenCalledWith({
        ownerPublicKeyHex: OWNER_PUBKEY,
        publisherPublicKeyHex: OWNER_PUBKEY,
        appId: "player.example"
      })
    );
  });
});
