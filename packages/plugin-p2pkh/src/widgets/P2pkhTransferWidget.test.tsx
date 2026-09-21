// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TransferOffer } from "@keymaster/contracts";
import type { P2pkhTransferPreview } from "../p2pkhContracts.js";
import { P2pkhTransferWidget } from "./P2pkhTransferWidget.js";

const RECIPIENT_ADDRESS = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
const RECIPIENT_PUBLIC_KEY = "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CHANGE_ADDRESS = "1dice8EMZmqKvrGE4Qc9bUFf9PX3xaYDp";

const mocks = vi.hoisted(() => ({
  service: {
    prepareTransfer: vi.fn(),
    submitTransfer: vi.fn()
  },
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
  useI18n: () => ({ t: (_key: string, values?: { defaultValue?: string }) => values?.defaultValue ?? _key }),
  useLocale: () => "en-US",
  usePluginHost: () => ({ resourceStore: {} }),
  useOptionalResourceSelector: (_store: unknown, resourceId: string, _args: readonly string[], _selector: unknown, fallback: unknown) => {
    if (resourceId === "p2pkh.transfer-context") return mocks.context;
    if (resourceId === "p2pkh.settings") return { includeTestnet: false };
    return fallback;
  }
}));

vi.mock("webloom-framework/react", () => ({
  useOptionalCapability: (capability: string | { id: string }) => {
    const id = typeof capability === "string" ? capability : capability.id;
    return id === "p2pkh.service" ? mocks.service : undefined;
  },
  useOptionalResourceSelector: (_store: unknown, resourceId: string, _args: readonly string[], _selector: unknown, fallback: unknown) => {
    if (resourceId === "p2pkh.transfer-context") return mocks.context;
    if (resourceId === "p2pkh.settings") return { includeTestnet: false };
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
    rawTxHex: "00"
  };
}

describe("P2pkhTransferWidget 收款地址只读", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
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
});
