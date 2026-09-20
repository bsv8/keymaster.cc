// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { sha256 } from "@noble/hashes/sha256";
import { PluginHostProvider, createKeymasterPluginHost as createPluginHost } from "@keymaster/runtime";
import { KEYSPACE_SERVICE_CAPABILITY, P2PKH_COORDINATOR_CONTROL_CAPABILITY, RESOURCE_REGISTRY_CAPABILITY, type KeyspaceService, type P2pkhCoordinatorControl, type SessionCoordinatorClient } from "@keymaster/contracts";
import { P2PKH_CAPABILITY, type P2pkhBalanceBreakdown, type P2pkhGlobalSettings, type P2pkhHistoryRecord, type P2pkhLocalTransaction, type P2pkhService } from "../p2pkhContracts.js";
import { p2pkhResources } from "../manifest.js";
import { P2pkhWalletPage, type WalletSnapshot } from "./P2pkhWalletPage.js";

const owner = "02" + "11".repeat(32);
const txid = "aa".repeat(32);
const breakdown: P2pkhBalanceBreakdown = { confirmed: 1000, unconfirmed: 200, spendable: 800, pendingInputClaims: 400 };
const historyRecord: P2pkhHistoryRecord = {
  id: `p2pkh:main:${txid}`,
  resourceId: "p2pkh:main",
  publicKeyHex: owner,
  network: "main",
  address: "1abc",
  txid,
  height: 123,
  fee: 10,
  firstSeenAt: "2026-09-18T00:00:00.000Z",
};

function reverseHex(raw: string): string { return raw.match(/../g)!.reverse().join(""); }
function localRawTxFromParents(parentTxids: string[], outputValue: number): { rawTxHex: string; txid: string } {
  const valueHex = outputValue.toString(16).padStart(16, "0").match(/../g)!.reverse().join("");
  const rawTxHex = `01000000${parentTxids.length.toString(16).padStart(2, "0")}${parentTxids.map((parentTxid) => `${reverseHex(parentTxid)}0000000000ffffffff`).join("")}01${valueHex}00` + "00000000";
  const hash = sha256(sha256(Uint8Array.from(rawTxHex.match(/../g)!.map((part) => Number.parseInt(part, 16)))));
  return { rawTxHex, txid: Array.from(hash).reverse().map((byte) => byte.toString(16).padStart(2, "0")).join("") };
}
function localRawTx(parentTxid: string, outputValue: number): { rawTxHex: string; txid: string } {
  return localRawTxFromParents([parentTxid], outputValue);
}

function makeHistory(index: number, network: "main" | "test" = "main"): P2pkhHistoryRecord {
  const suffix = index.toString(16).padStart(2, "0");
  const recordTxid = `${suffix}`.repeat(32);
  return {
    id: `p2pkh:${network}:${recordTxid}`,
    resourceId: `p2pkh:${network}`,
    publicKeyHex: owner,
    network,
    address: network === "main" ? "1abc" : "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn",
    txid: recordTxid,
    height: 100 + index,
    firstSeenAt: "2026-09-18T00:00:00.000Z",
  };
}

function makeLocal(id: string, overrides: Partial<P2pkhLocalTransaction> = {}): P2pkhLocalTransaction {
  const raw = localRawTx("ee".repeat(32), 600);
  return {
    id,
    resourceId: "p2pkh:main",
    publicKeyHex: owner,
    network: "main",
    txid: raw.txid,
    rawTxHex: raw.rawTxHex,
    localState: "submitting",
    chainResolution: "unresolved",
    inputOutpointKeys: [],
    ownOutputs: [],
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    attempts: [],
    ...overrides,
  };
}

function registerWallet(includeTestnet: boolean, history: P2pkhHistoryRecord[] = [historyRecord], serviceOverrides: Partial<P2pkhService> = {}, walletOverrides: Partial<WalletSnapshot> = {}, coordinatorOverrides: Partial<SessionCoordinatorClient> = {}) {
  const host = createPluginHost({ disableConfigPersistence: true, initialI18nResources: [p2pkhResources] });
  const registry = host.capabilities.get(RESOURCE_REGISTRY_CAPABILITY);
  const testResource = { resourceId: "p2pkh:test", publicKeyHex: owner, label: "test", address: "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn", network: "test" as const, createdAt: "now", generation: 0 };
  registry.register({ id: "p2pkh.settings", scope: "global", key: () => ["p2pkh.settings"], load: async () => ({ includeTestnet } satisfies P2pkhGlobalSettings), subscribe: () => () => undefined, invalidation: "immediate" });
  registry.register({
    id: "p2pkh.wallet",
    scope: "active-key",
    key: (_args: unknown, context: { activePublicKeyHex?: string }) => ["p2pkh.wallet", context.activePublicKeyHex ?? "none"],
    load: async () => ({
      resources: [testResource, { resourceId: "p2pkh:main", publicKeyHex: owner, label: "main", address: "1abc", network: "main" as const, createdAt: "now", generation: 0 }],
      history,
      locals: [],
      claims: [],
      utxos: [],
      utxosAvailable: false,
      protectedOutpoints: [],
      sync: [],
      syncStatus: "idle" as const,
      balances: {
        main: { total: 1000, available: true, breakdown },
        test: { total: 2000, available: true },
      },
      historyCursors: {},
      localCursors: {},
      claimCursors: {},
      ...walletOverrides,
    }),
    subscribe: () => () => undefined,
    invalidation: "immediate",
  } as unknown as Parameters<typeof registry.register>[0]);
  host.provide(KEYSPACE_SERVICE_CAPABILITY, { active: () => ({ activePublicKeyHex: owner }), onActiveKeyChanged: () => () => undefined } as unknown as KeyspaceService);
  host.provide(P2PKH_COORDINATOR_CONTROL_CAPABILITY, coordinatorOverrides as unknown as P2pkhCoordinatorControl);
  host.provide(P2PKH_CAPABILITY, serviceOverrides as P2pkhService);
  return host;
}

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

describe("P2pkhWalletPage", () => {
  it("renders history rows with txid, height, chain-confirmed state and time", async () => {
    window.history.replaceState({}, "", "/p2pkh/mainnet/transactions?page=1");
    const host = registerWallet(false);
    render(<PluginHostProvider host={host}><P2pkhWalletPage network="main" /></PluginHostProvider>);
    await waitFor(() => expect(screen.getByText(txid)).toBeTruthy());
    expect(screen.getByText("123")).toBeTruthy();
    expect(screen.getByText("Chain confirmed")).toBeTruthy();
    expect(screen.getByText("2026-09-18T00:00:00.000Z")).toBeTruthy();
    expect(screen.queryByLabelText("Network")).toBeNull();
    expect(screen.queryByRole("button", { name: "Testnet" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Provider settings" })).toBeNull();
    fireEvent.click(screen.getByText("Details"));
    expect(window.location.pathname).toBe(`/p2pkh/tx/${txid}`);
    expect(window.location.search).toBe("?network=main&page=1&source=transactions");
  });

  it("keeps identical transaction ids isolated by the network route", async () => {
    const testRecord: P2pkhHistoryRecord = { ...historyRecord, id: `p2pkh:test:${txid}`, resourceId: "p2pkh:test", network: "test", address: "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn" };
    const host = registerWallet(true, [historyRecord, testRecord]);
    render(<PluginHostProvider host={host}><P2pkhWalletPage network="test" /></PluginHostProvider>);
    await waitFor(() => expect(screen.getAllByText(txid)).toHaveLength(1));
    expect(screen.getByText("On-chain transactions · Testnet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Testnet" })).toBeTruthy();
  });

  it("never shows a local-only row on the chain transactions page", async () => {
    const localOnly = makeLocal("local-only", { txid: "dd".repeat(32), rawTxHex: "00" });
    const host = registerWallet(false, [historyRecord], {}, { locals: [localOnly] });
    render(<PluginHostProvider host={host}><P2pkhWalletPage network="main" view="transactions" /></PluginHostProvider>);
    await screen.findByText(txid);
    expect(screen.queryByText(localOnly.txid)).toBeNull();
  });

  it("hides chain-confirmed locals while retaining unresolved local rows", async () => {
    const promoted = makeLocal("promoted", { txid: "dd".repeat(32), rawTxHex: "00", chainResolution: "chain-confirmed", localState: "local-confirmed" });
    const pending = makeLocal("pending", { txid: "ee".repeat(32), rawTxHex: "00" });
    const host = registerWallet(false, [], {}, { locals: [promoted, pending] });
    render(<PluginHostProvider host={host}><P2pkhWalletPage network="main" view="local-transactions" /></PluginHostProvider>);
    await screen.findByText(pending.txid);
    expect(screen.queryByText(promoted.txid)).toBeNull();
  });

  it("renders local transactions with output amount, local state, chain resolution and time", async () => {
    const raw = localRawTx("bb".repeat(32), 600);
    const local = makeLocal("local-route", {
      txid: raw.txid,
      rawTxHex: raw.rawTxHex,
      localState: "local-confirmed",
      chainResolution: "unresolved",
      updatedAt: "2026-09-19T00:00:00.000Z",
    });
    window.history.replaceState({}, "", "/p2pkh/mainnet/local-transactions?page=1");
    const host = registerWallet(false, [], {}, { locals: [local] });
    render(<PluginHostProvider host={host}><P2pkhWalletPage network="main" view="local-transactions" /></PluginHostProvider>);
    await screen.findByText(local.txid);
    expect(screen.getByText("600 sats")).toBeTruthy();
    expect(screen.getByText("Local confirmed")).toBeTruthy();
    expect(screen.getByText("Unresolved")).toBeTruthy();
    expect(screen.getByText("2026-09-19T00:00:00.000Z")).toBeTruthy();
  });

  it("loads more history via listHistoryPage cursors on Next", async () => {
    window.history.replaceState({}, "", "/p2pkh/mainnet/transactions?page=1");
    const initial = Array.from({ length: 20 }, (_, index) => makeHistory(index));
    const extra: P2pkhHistoryRecord = {
      id: "p2pkh:main:" + "ff".repeat(32),
      resourceId: "p2pkh:main",
      publicKeyHex: owner,
      network: "main",
      address: "1abc",
      txid: "ff".repeat(32),
      height: 1,
      firstSeenAt: "2026-09-18T00:00:00.000Z",
    };
    let calls = 0;
    const host = registerWallet(false, initial, {
      listHistoryPage: async () => { calls += 1; return { items: [extra] }; },
    }, { historyCursors: { "p2pkh:main": "cursor-1" } });
    render(<PluginHostProvider host={host}><P2pkhWalletPage network="main" view="transactions" /></PluginHostProvider>);
    await screen.findByText(initial[0]!.txid);
    fireEvent.click(screen.getByText("Next"));
    expect(await screen.findByText(extra.txid)).toBeTruthy();
    expect(calls).toBe(1);
    expect(window.location.search).toBe("?page=2");
  });

  it("does not advance the page when history pagination fails", async () => {
    window.history.replaceState({}, "", "/p2pkh/mainnet/transactions?page=1");
    const host = registerWallet(false, [historyRecord], {
      listHistoryPage: async () => { throw new Error("page failed"); },
    }, { historyCursors: { "p2pkh:main": "next-history" } });
    render(<PluginHostProvider host={host}><P2pkhWalletPage network="main" /></PluginHostProvider>);
    await screen.findByText(txid);
    fireEvent.click(screen.getByText("Next"));
    expect(await screen.findByText("page failed")).toBeTruthy();
    expect(window.location.search).toBe("?page=1");
  });

  it("opens local details with the submission id", async () => {
    const local = makeLocal("local-detail-submission", { txid: "cd".repeat(32), rawTxHex: "00", localState: "isolated" });
    window.history.replaceState({}, "", "/p2pkh/mainnet/local-transactions?page=1");
    const host = registerWallet(false, [], {}, { locals: [local] });
    render(<PluginHostProvider host={host}><P2pkhWalletPage network="main" view="local-transactions" /></PluginHostProvider>);
    await screen.findByText(local.txid);
    fireEvent.click(screen.getByText("Details"));
    expect(window.location.search).toBe(`?network=main&page=1&source=local-transactions&submissionId=${local.id}`);
  });

  it("does not turn a disabled testnet into a zero balance", async () => {
    window.history.replaceState({}, "", "/p2pkh/testnet/transactions");
    const host = registerWallet(false);
    render(<PluginHostProvider host={host}><P2pkhWalletPage network="test" /></PluginHostProvider>);
    expect(await screen.findByText("Testnet is disabled")).toBeTruthy();
    expect(screen.queryByText("2,000 sats")).toBeNull();
  });

  it("shows unknown balance when unavailable and known balance with breakdown", async () => {
    const knownHost = registerWallet(false, [historyRecord], {}, {
      balances: { main: { total: 5000, available: true, breakdown } },
    });
    render(<PluginHostProvider host={knownHost}><P2pkhWalletPage network="main" /></PluginHostProvider>);
    await waitFor(() => expect(screen.getByText(/5,000/)).toBeTruthy());
    expect(screen.getByText("1,000 sats")).toBeTruthy();
    expect(screen.getByText("400 sats")).toBeTruthy();
    cleanup();

    const unknownHost = registerWallet(false, [historyRecord], {}, {
      balances: { main: { total: 0, available: false } },
    });
    render(<PluginHostProvider host={unknownHost}><P2pkhWalletPage network="main" /></PluginHostProvider>);
    await waitFor(() => expect(screen.getByText(/Unknown \(UTXO snapshot not available yet\)|未知（尚未取得 UTXO 快照）/u)).toBeTruthy());
    expect(screen.queryByText(/5,000/)).toBeNull();
  });

  it("chooses the view from the route prop and ignores tab query parameters", async () => {
    window.history.replaceState({}, "", "/p2pkh/mainnet/transactions?page=1&tab=coins");
    const host = registerWallet(false);
    render(<PluginHostProvider host={host}><P2pkhWalletPage network="main" view="transactions" /></PluginHostProvider>);
    await screen.findByText(txid);
    expect(screen.getByText("123")).toBeTruthy();
    expect(screen.queryByText("txid:vout")).toBeNull();
  });
});
