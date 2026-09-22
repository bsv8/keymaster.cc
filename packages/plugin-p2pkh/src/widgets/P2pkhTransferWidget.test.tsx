// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GlobalBalanceSnapshot, TransferOffer } from "@keymaster/contracts";
import type { P2pkhTransferPreview } from "../p2pkhContracts.js";
import { P2pkhTransferWidget } from "./P2pkhTransferWidget.js";

const RECIPIENT_ADDRESS = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
const RECIPIENT_PUBLIC_KEY = "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CHANGE_ADDRESS = "1dice8EMZmqKvrGE4Qc9bUFf9PX3xaYDp";

const mocks = vi.hoisted(() => ({
  service: {
    prepareTransfer: vi.fn(),
    submitTransfer: vi.fn(),
  },
  serviceAvailable: true,
  balanceSnapshot: {
    publicKeyHex: "02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    includeTestnet: false,
    balances: { mainnet: { total: 1234, available: true } },
    revision: 1,
  } as GlobalBalanceSnapshot,
  context: {
    activePublicKeyHex: "02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    identity: {
      publicKeyHex: "02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      label: "Owner",
      capabilities: [],
      createdAt: ""
    },
    resource: { address: "1dice8EMZmqKvrGE4Qc9bUFf9PX3xaYDp" }
  }
}));

vi.mock("@keymaster/runtime", () => ({
  useI18n: () => ({
    t: (_key: string, values?: { defaultValue?: string; [key: string]: unknown }) => {
      const template = values?.defaultValue ?? _key;
      return template.replace(/\{\{(\w+)\}\}/g, (_match: string, key: string) => String(values?.[key] ?? ""));
    }
  }),
  useLocale: () => "en-US",
  usePluginHost: () => ({ resourceStore: {} }),
  useOptionalResourceSelector: (_store: unknown, resourceId: string, _args: readonly string[], _selector: unknown, fallback: unknown) => {
    if (resourceId === "p2pkh.transfer-context") return mocks.context;
    if (resourceId === "p2pkh.settings") return { includeTestnet: false };
    if (resourceId === "p2pkh.balance") return mocks.balanceSnapshot;
    return fallback;
  }
}));

vi.mock("webloom-framework/react", () => ({
  useOptionalCapability: (capability: string | { id: string }) => {
    const id = typeof capability === "string" ? capability : capability.id;
    return id === "p2pkh.service" && mocks.serviceAvailable ? mocks.service : undefined;
  },
  useOptionalResourceSelector: (_store: unknown, resourceId: string, _args: readonly string[], _selector: unknown, fallback: unknown) => {
    if (resourceId === "p2pkh.transfer-context") return mocks.context;
    if (resourceId === "p2pkh.settings") return { includeTestnet: false };
    if (resourceId === "p2pkh.balance") return mocks.balanceSnapshot;
    return fallback;
  }
}));

const OFFER: TransferOffer = {
  id: "p2pkh:bsv",
  providerId: "p2pkh",
  assetProviderId: "p2pkh",
  assetId: "bsv",
  label: { key: "p2pkh.asset.bsv", fallback: "BSV" },
  status: "ready",
  network: "main",
  recipientTargetSection: "mainnet"
};
const TEST_OFFER: TransferOffer = {
  ...OFFER,
  id: "p2pkh:bsvtest",
  assetId: "bsvtest",
  network: "test",
  recipientTargetSection: "testnet"
};

function preview(): P2pkhTransferPreview {
  return {
    assetId: "bsv",
    network: "main",
    ownerPublicKeyHex: mocks.context.activePublicKeyHex,
    recipientAddress: RECIPIENT_ADDRESS,
    amountSatoshis: 1000,
    feeRateSatoshisPerKb: 1000,
    allocation: {
      requestedSatoshis: 1000,
      feeReserveSatoshis: 100,
      selected: [],
      totalInputSatoshis: 1200,
      changeSatoshis: 100
    },
    changeAddress: CHANGE_ADDRESS,
    outputs: [{ address: RECIPIENT_ADDRESS, value: 1000 }],
    estimatedFeeSatoshis: 100,
    serializedSizeBytes: 200,
    txid: "aa".repeat(32),
    rawTxHex: "00",
    previewId: "test-preview"
  };
}

describe("P2pkhTransferWidget 收款地址只读", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    mocks.serviceAvailable = true;
    mocks.balanceSnapshot = {
      publicKeyHex: mocks.context.activePublicKeyHex,
      includeTestnet: false,
      balances: { mainnet: { total: 1234, available: true } },
      revision: 1,
    };
  });

  it("T13：接收 recipientAddress，地址不是可编辑输入", () => {
    render(<P2pkhTransferWidget offer={OFFER} recipientAddress={RECIPIENT_ADDRESS} recipientPublicKeyHex={RECIPIENT_PUBLIC_KEY} onCompleted={vi.fn()} />);

    expect(screen.getByTestId("p2pkh-recipient-address").textContent).toContain(RECIPIENT_ADDRESS);
    expect(screen.queryByRole("textbox", { name: /Recipient address|收款地址/u })).toBeNull();
    expect(screen.getByRole("textbox", { name: /金额/u })).toBeTruthy();
  });

  it("T12：生成预览后修改金额会使只读核对结果失效", async () => {
    mocks.service.prepareTransfer.mockResolvedValue(preview());
    render(<P2pkhTransferWidget offer={OFFER} recipientAddress={RECIPIENT_ADDRESS} onCompleted={vi.fn()} />);

    fireEvent.change(screen.getByRole("textbox", { name: /金额/u }), { target: { value: "1000" } });
    fireEvent.click(screen.getByRole("button", { name: "生成最终交易" }));
    await waitFor(() => expect(screen.getByText("只读核对")).toBeTruthy());

    fireEvent.change(screen.getByRole("textbox", { name: /金额/u }), { target: { value: "900" } });
    expect(screen.queryByText("只读核对")).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: /金额/u }), { target: { value: "1000" } });
    fireEvent.click(screen.getByRole("button", { name: /生成最终交易/u }));
    await waitFor(() => expect(screen.getByText("只读核对")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /高 ·/u }));
    expect(screen.queryByText("只读核对")).toBeNull();
  });

  it("T12：金额输入旁显示当前主网广播余额", () => {
    render(<P2pkhTransferWidget offer={OFFER} recipientAddress={RECIPIENT_ADDRESS} recipientPublicKeyHex={RECIPIENT_PUBLIC_KEY} onCompleted={vi.fn()} />);
    expect(screen.getByText("可用余额：1,234 sats（主网）")).toBeTruthy();
  });

  it("T13：收款网络切到 testnet 后参考值只读取 testnet 键", () => {
    mocks.balanceSnapshot = {
      publicKeyHex: mocks.context.activePublicKeyHex,
      includeTestnet: true,
      balances: {
        mainnet: { total: 1234, available: true },
        testnet: { total: 5678, available: true },
      },
      revision: 2,
    };
    render(<P2pkhTransferWidget offer={TEST_OFFER} recipientAddress={RECIPIENT_ADDRESS} recipientPublicKeyHex={RECIPIENT_PUBLIC_KEY} onCompleted={vi.fn()} />);
    expect(screen.getByText("可用余额：5,678 sats（测试网）")).toBeTruthy();
    expect(screen.queryByText("可用余额：1,234 sats（主网）")).toBeNull();
  });

  it("T14：余额未知或 testnet 未启用时不显示 0 余额", () => {
    mocks.balanceSnapshot = {
      publicKeyHex: mocks.context.activePublicKeyHex,
      includeTestnet: false,
      balances: { mainnet: { total: 0, available: false } },
      revision: 3,
    };
    render(<P2pkhTransferWidget offer={OFFER} recipientAddress={RECIPIENT_ADDRESS} recipientPublicKeyHex={RECIPIENT_PUBLIC_KEY} onCompleted={vi.fn()} />);
    expect(screen.getByText("可用余额未知（主网）")).toBeTruthy();
    expect(screen.queryByText("可用余额：0 sats（主网）")).toBeNull();
  });

  it("T15：余额快照变化只更新参考文案，不覆盖用户已输入金额", () => {
    const view = render(<P2pkhTransferWidget offer={OFFER} recipientAddress={RECIPIENT_ADDRESS} recipientPublicKeyHex={RECIPIENT_PUBLIC_KEY} onCompleted={vi.fn()} />);
    const amount = screen.getByRole("textbox", { name: /金额/u }) as HTMLInputElement;
    fireEvent.change(amount, { target: { value: "777" } });

    mocks.balanceSnapshot = {
      publicKeyHex: mocks.context.activePublicKeyHex,
      includeTestnet: false,
      balances: { mainnet: { total: 4321, available: true } },
      revision: 4,
    };
    view.rerender(<P2pkhTransferWidget offer={OFFER} recipientAddress={RECIPIENT_ADDRESS} recipientPublicKeyHex={RECIPIENT_PUBLIC_KEY} onCompleted={vi.fn()} />);

    expect((screen.getByRole("textbox", { name: /金额/u }) as HTMLInputElement).value).toBe("777");
    expect(screen.getByText("可用余额：4,321 sats（主网）")).toBeTruthy();
  });

  it("T10：余额消费能力缺失时降级为锁定提示，不崩溃", () => {
    mocks.serviceAvailable = false;
    render(<P2pkhTransferWidget offer={OFFER} recipientAddress={RECIPIENT_ADDRESS} recipientPublicKeyHex={RECIPIENT_PUBLIC_KEY} onCompleted={vi.fn()} />);
    expect(screen.getByText("钱包已锁定；解锁后可继续转账。")).toBeTruthy();
  });
});
