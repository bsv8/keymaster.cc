// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TransferWidgetProps } from "@keymaster/contracts";
import { TransferPage } from "./transfer.js";

const OWNER = "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const mocks = vi.hoisted(() => {
  const widget = vi.fn((_props: any): any => null);
  const contactPicker = vi.fn((_props: any): any => null);
  const provider = {
    id: "p2pkh",
    component: widget,
    supportsRecipientPublicKeyHex: vi.fn(() => true)
  };
  return {
    offers: [{
      id: "bsv",
      providerId: "p2pkh",
      assetProviderId: "p2pkh",
      assetId: "bsv",
      label: { key: "asset.bsv", fallback: "BSV" },
      status: "ready",
      recipientTargetSection: "mainnet"
    }],
    collectibles: [] as Array<{ providerId: string; items: Array<{ collectibleId: string; name: string; status: string }> }>,
    provider,
    widget,
    contactPicker,
    listSupporting: vi.fn((_input?: unknown): Array<{ supportsRecipientPublicKeyHex?(publicKeyHex: string): boolean }> => []),
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
  useResourceSelector: (_store: unknown, resourceId: string) => {
    if (resourceId === "transfer.offers") return mocks.offers;
    if (resourceId === "transfer.active-key") return { activePublicKeyHex: OWNER };
    if (resourceId === "transfer.recipient-collectibles") return mocks.collectibles;
    throw new Error(`unexpected resource ${resourceId}`);
  },
  useCapability: (capability: string) => {
    if (capability === "transfer.registry") return { list: () => [mocks.provider] };
    if (capability === "collectible-transfer.registry") return { listSupporting: mocks.listSupporting };
    if (capability === "contacts.picker") return mocks.contactPicker;
    if (capability === "feature.transfer") {
      return {
        subscribe: () => () => undefined,
        listSources: () => [],
        listQuoteProviders: () => [],
        listReviewSections: () => [],
        listSubmitHandlers: () => []
      };
    }
    throw new Error(`unexpected capability ${capability}`);
  }
}));

vi.mock("@keymaster/ui", () => ({
  EmptyState: ({ title, description }: { title: string; description?: string }) => <div><h2>{title}</h2>{description ? <p>{description}</p> : null}</div>,
  PageHeader: ({ title, description }: { title: string; description?: string }) => <header><h1>{title}</h1>{description ? <p>{description}</p> : null}</header>
}));

function TestWidget({ recipientPublicKeyHex }: TransferWidgetProps) {
  return <section data-testid="provider-step"><span>3</span><p>{recipientPublicKeyHex ?? "manual-recipient"}</p></section>;
}

function TestContactPicker({ onChange }: { onChange(publicKeyHex: string): void }) {
  return <button type="button" onClick={() => onChange(OWNER)}>选择 Alice</button>;
}

describe("TransferPage entry flows", () => {
  beforeEach(() => {
    mocks.widget.mockImplementation(TestWidget);
    mocks.contactPicker.mockImplementation(TestContactPicker);
    mocks.collectibles.length = 0;
    mocks.listSupporting.mockReturnValue([]);
    window.history.replaceState(null, "", "/transfer");
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("无参数入口按 1 收款人、2 资产、3 表单的顺序前进", () => {
    render(<TransferPage />);

    const recipient = screen.getByRole("heading", { name: "收款人" });
    const asset = screen.getByRole("heading", { name: "资产类型" });
    expect(recipient.compareDocumentPosition(asset) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId("provider-step")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /BSV/ }));

    const providerStep = screen.getByTestId("provider-step");
    expect(asset.compareDocumentPosition(providerStep) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("manual-recipient")).toBeTruthy();
  });

  it("联系人入口在第 1 步显示参数，并传给第 3 步表单", () => {
    window.history.replaceState(null, "", `/transfer?recipientPublicKeyHex=${OWNER}`);
    render(<TransferPage />);

    expect(screen.getByTestId("recipient-target").dataset.recipientPublicKeyHex).toBe(OWNER);
    fireEvent.click(screen.getByRole("button", { name: /BSV/ }));
    expect(screen.getByTestId("provider-step").textContent).toContain(OWNER);
  });

  it("无参数时不越过收款人步骤展示联系人藏品", () => {
    mocks.collectibles.push({
      providerId: "ordinals",
      items: [{ collectibleId: "tx:0", name: "Ordinal #1", status: "ready" }]
    });
    mocks.listSupporting.mockReturnValue([{ supportsRecipientPublicKeyHex: () => true }]);

    render(<TransferPage />);

    expect(screen.queryByText("Ordinal #1")).toBeNull();
  });

  it("在第 1 步选联系人后进入带参数路由", () => {
    render(<TransferPage />);
    fireEvent.click(screen.getByRole("button", { name: "选择 Alice" }));
    expect(mocks.routerPush).toHaveBeenCalledWith(`/transfer?recipientPublicKeyHex=${OWNER}`);
  });
});
