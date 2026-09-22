// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TransferWidgetProps } from "@keymaster/contracts";
import { TransferPage } from "./transfer.js";

const OWNER = "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "03bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MAIN_ADDRESS = "main-contact-address";
const OTHER_MAIN_ADDRESS = "main-other-address";
const TEST_ADDRESS = "test-contact-address";

const mocks = vi.hoisted(() => {
  const widget = vi.fn((_props: TransferWidgetProps): any => null);
  const contactPicker = vi.fn((_props: any): any => null);
  const provider = {
    id: "p2pkh",
    component: widget,
    supportsRecipientPublicKeyHex: vi.fn(() => true)
  };
  return {
    includeTestnet: false,
    contacts: [] as Array<{ publicKeyHex: string; name: string; tags: string[]; createdAt: string; updatedAt: string }>,
    offers: [
      {
        id: "p2pkh:bsv",
        providerId: "p2pkh",
        assetProviderId: "p2pkh",
        assetId: "bsv",
        label: { key: "asset.bsv", fallback: "BSV" },
        status: "ready",
        network: "main",
        recipientTargetSection: "mainnet"
      },
      {
        id: "p2pkh:bsvtest",
        providerId: "p2pkh",
        assetProviderId: "p2pkh",
        assetId: "bsvtest",
        label: { key: "asset.bsvtest", fallback: "BSV Testnet" },
        status: "ready",
        network: "test",
        recipientTargetSection: "testnet"
      },
      {
        id: "bsv21:main",
        providerId: "bsv21",
        assetProviderId: "bsv21",
        assetId: "bsv21.main",
        label: { key: "bsv21", fallback: "BSV-21" },
        status: "ready",
        network: "main",
        recipientTargetSection: "mainnet"
      }
    ],
    provider,
    widget,
    contactPicker,
    routerPush: vi.fn((path: string) => window.history.pushState(null, "", path))
  };
});

vi.mock("@keymaster/runtime", () => ({
  router: { push: mocks.routerPush },
  useCurrentPath: () => undefined,
  useI18n: () => ({
    t: (_key: string, values?: { defaultValue?: string }) => values?.defaultValue ?? _key
  }),
  usePluginHost: () => ({
    resourceStore: {},
    i18n: { text: (value: string | { fallback: string }) => typeof value === "string" ? value : value.fallback }
  }),
  useOptionalResourceSelector: (_store: unknown, resourceId: string, _args: readonly string[], _selector: unknown, fallback: unknown) => {
    if (resourceId === "p2pkh.settings") return mocks.includeTestnet;
    if (resourceId === "contacts.list") return mocks.contacts;
    return fallback;
  }
}));

vi.mock("webloom-framework/react", () => ({
  useResourceSelector: (_store: unknown, resourceId: string) => {
    if (resourceId === "transfer.offers") return mocks.offers;
    if (resourceId === "transfer.active-key") return { activePublicKeyHex: OWNER };
    throw new Error(`unexpected resource ${resourceId}`);
  },
  useCapability: (capability: string | { id: string }) => {
    const capabilityId = typeof capability === "string" ? capability : capability.id;
    if (capabilityId === "transfer.registry") return { list: () => [mocks.provider] };
    throw new Error(`unexpected capability ${capabilityId}`);
  },
  useOptionalCapability: (capability: string | { id: string }) => {
    const capabilityId = typeof capability === "string" ? capability : capability.id;
    if (capabilityId === "contacts.picker") return mocks.contactPicker;
    if (capabilityId === "p2pkh.address-codec") {
      return {
        deriveAddress: (publicKeyHex: string, network: "main" | "test") => {
          if (publicKeyHex === OWNER) return network === "main" ? MAIN_ADDRESS : TEST_ADDRESS;
          return network === "main" ? OTHER_MAIN_ADDRESS : "test-other-address";
        },
        parseAddress: (address: string) => {
          if (address === MAIN_ADDRESS) return { network: "main" as const, hash160Hex: "hash-contact" };
          if (address === TEST_ADDRESS) return { network: "test" as const, hash160Hex: "hash-contact" };
          if (address === OTHER_MAIN_ADDRESS) return { network: "main" as const, hash160Hex: "hash-other" };
          if (address === "main-unknown-address") return { network: "main" as const, hash160Hex: "hash-unknown" };
          return undefined;
        }
      };
    }
    return undefined;
  }
}));

vi.mock("@keymaster/ui", () => ({
  EmptyState: ({ title, description }: { title: string; description?: string }) => <div><h2>{title}</h2>{description ? <p>{description}</p> : null}</div>,
  PageHeader: ({ title, description }: { title: string; description?: string }) => <header><h1>{title}</h1>{description ? <p>{description}</p> : null}</header>,
  TextInput: ({ label, ...props }: { label?: string; [key: string]: unknown }) => <label>{label}<input {...props} /></label>
}));

function TestWidget({ recipientAddress, recipientPublicKeyHex }: TransferWidgetProps) {
  return <section data-testid="provider-step"><span>2</span><code>{recipientAddress ?? "missing-address"}</code><p>{recipientPublicKeyHex ?? "manual-recipient"}</p></section>;
}

function TestContactPicker({ onChange }: { onChange(publicKeyHex: string): void }) {
  return <button type="button" onClick={() => onChange(OWNER)}>选择 Alice</button>;
}

describe("TransferPage 收款方与 P2PKH 范围", () => {
  beforeEach(() => {
    mocks.widget.mockImplementation(TestWidget);
    mocks.contactPicker.mockImplementation(TestContactPicker);
    mocks.includeTestnet = false;
    mocks.contacts.length = 0;
    window.history.replaceState(null, "", "/transfer");
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("T01：入口只显示收款方，不显示资产网格或收藏品区", () => {
    render(<TransferPage />);

    expect(screen.getByRole("heading", { name: "收款方" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "资产类型" })).toBeNull();
    expect(screen.queryByText("BSV-21")).toBeNull();
    expect(screen.queryByText("收藏品")).toBeNull();
  });

  it("T02：通讯录公钥显示昵称、派生地址和来源徽标", () => {
    mocks.contacts.push({ publicKeyHex: OWNER, name: "Alice", tags: [], createdAt: "", updatedAt: "" });
    window.history.replaceState(null, "", `/transfer?recipientPublicKeyHex=${OWNER}`);
    render(<TransferPage />);

    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.getByTestId("recipient-address").textContent).toBe(MAIN_ADDRESS);
    expect(screen.getByTestId("recipient-source").textContent).toBe("联系人公钥派生");
    expect(screen.getByTestId("provider-step").textContent).toContain(MAIN_ADDRESS);
  });

  it("T03/T09：testnet 关闭时公钥模式不显示选择器且降级主网", () => {
    window.history.replaceState(null, "", `/transfer?recipientPublicKeyHex=${OWNER}&network=testnet`);
    render(<TransferPage />);

    expect(screen.getByTestId("recipient-address").textContent).toBe(MAIN_ADDRESS);
    expect(screen.queryByRole("combobox", { name: "网络" })).toBeNull();
  });

  it("T04：手工主网地址即收款真值", () => {
    window.history.replaceState(null, "", `/transfer?recipientAddress=${MAIN_ADDRESS}`);
    render(<TransferPage />);

    expect(screen.getByTestId("recipient-address").textContent).toBe(MAIN_ADDRESS);
    expect(screen.getByTestId("recipient-source").textContent).toBe("手工地址");
  });

  it("T05：testnet 地址在关闭时被拒绝并提示设置入口", () => {
    window.history.replaceState(null, "", `/transfer?recipientAddress=${TEST_ADDRESS}`);
    render(<TransferPage />);

    expect(screen.getByText("未启用 testnet，请在设置中开启。")).toBeTruthy();
    expect(screen.queryByTestId("p2pkh-transfer-widget")).toBeNull();
  });

  it("T05：手工输入 testnet 地址在关闭时也被拒绝", () => {
    render(<TransferPage />);
    fireEvent.click(screen.getByRole("tab", { name: "手工输入" }));
    fireEvent.change(screen.getByPlaceholderText("粘贴公钥、地址，或搜索联系人"), { target: { value: TEST_ADDRESS } });

    expect(screen.getByText("未启用 testnet，请在设置中开启。")).toBeTruthy();
    expect(screen.queryByTestId("p2pkh-transfer-widget")).toBeNull();
  });

  it("T06：testnet 开启时地址网络锁定不可切换", () => {
    mocks.includeTestnet = true;
    window.history.replaceState(null, "", `/transfer?recipientAddress=${TEST_ADDRESS}&network=main`);
    render(<TransferPage />);

    expect(screen.getByTestId("recipient-target").textContent).toContain("testnet");
    expect(screen.getByRole("combobox", { name: "网络" })).toHaveProperty("disabled", true);
    expect(screen.getByTestId("provider-step").textContent).toContain(TEST_ADDRESS);
  });

  it("T07：公钥切换 testnet 后重新派生地址并提示重新核对", async () => {
    mocks.includeTestnet = true;
    window.history.replaceState(null, "", `/transfer?recipientPublicKeyHex=${OWNER}`);
    render(<TransferPage />);

    const network = screen.getByRole("combobox", { name: "网络" });
    fireEvent.change(network, { target: { value: "test" } });
    await waitFor(() => expect(screen.getByTestId("recipient-address").textContent).toBe(TEST_ADDRESS));
    expect(screen.getByText("地址已更新，请重新核对。")).toBeTruthy();
    expect(screen.getByTestId("provider-step").textContent).toContain(TEST_ADDRESS);
  });

  it("T08：URL 公钥与地址矛盾时阻断，不猜测", () => {
    window.history.replaceState(null, "", `/transfer?recipientPublicKeyHex=${OWNER}&recipientAddress=${OTHER_MAIN_ADDRESS}`);
    render(<TransferPage />);

    expect(screen.getByText("公钥与地址不一致，已阻断转账。")).toBeTruthy();
    expect(screen.queryByTestId("p2pkh-transfer-widget")).toBeNull();
  });

  it("T08：URL 公钥与一致地址同时存在时保留身份核对信息", () => {
    window.history.replaceState(null, "", `/transfer?recipientPublicKeyHex=${OWNER}&recipientAddress=${MAIN_ADDRESS}`);
    render(<TransferPage />);

    expect(screen.getByTestId("recipient-target").textContent).toContain(OWNER);
    expect(screen.getByTestId("provider-step").textContent).toContain(OWNER);
  });

  it("T10：地址命中联系人时回填昵称并标记地址反查", () => {
    mocks.contacts.push({ publicKeyHex: OWNER, name: "Alice", tags: [], createdAt: "", updatedAt: "" });
    window.history.replaceState(null, "", `/transfer?recipientAddress=${MAIN_ADDRESS}`);
    render(<TransferPage />);

    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.getByTestId("recipient-source").textContent).toBe("地址命中联系人");
  });

  it("T11：非法地址被拒绝，不进入 P2PKH Widget", () => {
    window.history.replaceState(null, "", "/transfer?recipientAddress=1invalid-address-with-bad-checksum");
    render(<TransferPage />);

    expect(screen.getByText("这不是有效的 P2PKH 地址，请从对应资产入口转账。")).toBeTruthy();
    expect(screen.queryByTestId("p2pkh-transfer-widget")).toBeNull();
  });

  it("T11：手工输入 P2SH 地址被拒绝，不进入联系人搜索", () => {
    render(<TransferPage />);
    fireEvent.click(screen.getByRole("tab", { name: "手工输入" }));
    fireEvent.change(screen.getByPlaceholderText("粘贴公钥、地址，或搜索联系人"), { target: { value: `3${"a".repeat(30)}` } });

    expect(screen.getByText("这不是有效的 P2PKH 地址，请从对应资产入口转账。")).toBeTruthy();
    expect(screen.queryByTestId("contact-search-results")).toBeNull();
    expect(screen.queryByTestId("p2pkh-transfer-widget")).toBeNull();
  });

  it("地址模式手工输入时显示锁定的网络选择器", () => {
    mocks.includeTestnet = true;
    render(<TransferPage />);
    fireEvent.click(screen.getByRole("tab", { name: "手工输入" }));
    fireEvent.change(screen.getByPlaceholderText("粘贴公钥、地址，或搜索联系人"), { target: { value: MAIN_ADDRESS } });

    expect(screen.getByRole("combobox", { name: "网络" })).toHaveProperty("disabled", true);
  });

  it("T02 兼容旧通讯录动作 URL，并把地址传给 Widget", () => {
    render(<TransferPage />);
    fireEvent.click(screen.getByRole("button", { name: "选择 Alice" }));
    expect(mocks.routerPush).toHaveBeenCalledWith(`/transfer?recipientPublicKeyHex=${OWNER}`);
  });

  it("手工公钥自动分流并显示手工公钥来源", () => {
    render(<TransferPage />);
    fireEvent.click(screen.getByRole("tab", { name: "手工输入" }));
    fireEvent.change(screen.getByPlaceholderText("粘贴公钥、地址，或搜索联系人"), { target: { value: OTHER } });

    expect(screen.getByTestId("recipient-source").textContent).toBe("手工公钥");
    expect(screen.getByTestId("provider-step").textContent).toContain(OTHER_MAIN_ADDRESS);
  });

  it("手工输入已存在于通讯录的公钥仍标记为手工公钥", () => {
    mocks.contacts.push({ publicKeyHex: OWNER, name: "Alice", tags: [], createdAt: "", updatedAt: "" });
    render(<TransferPage />);
    fireEvent.click(screen.getByRole("tab", { name: "手工输入" }));
    fireEvent.change(screen.getByPlaceholderText("粘贴公钥、地址，或搜索联系人"), { target: { value: OWNER } });

    expect(screen.getByTestId("recipient-source").textContent).toBe("手工公钥");
  });
});
