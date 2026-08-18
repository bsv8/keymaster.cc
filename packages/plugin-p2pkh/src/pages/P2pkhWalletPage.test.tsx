// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PluginHostProvider, createPluginHost } from "@keymaster/runtime";
import { RESOURCE_REGISTRY_CAPABILITY, SESSION_COORDINATOR_CLIENT_CAPABILITY, type KeyspaceService, type ResourceRegistry, type SessionCoordinatorClient } from "@keymaster/contracts";
import type { P2pkhBalanceBreakdown, P2pkhGlobalSettings, P2pkhLocalOutpoint, P2pkhLocalTransaction, P2pkhOwnedOutpointProjection, P2pkhService, P2pkhTransactionFact } from "../p2pkhContracts.js";
import { p2pkhResources } from "../manifest.js";
import { P2pkhTransactionDetailPage } from "./P2pkhTransactionDetailPage.js";
import { P2pkhWalletPage, type WalletSnapshot } from "./P2pkhWalletPage.js";

const owner = "02" + "11".repeat(32);
const txid = "aa".repeat(32);
const breakdown: P2pkhBalanceBreakdown = { blockConfirmed: 1000, localSpendable: 1000, localConfirmedChange: 0, pendingInputClaims: 0, isolated: 0 };
const fact: P2pkhTransactionFact = { id: `p2pkh:main:${txid}`, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", address: "1abc", txid, rawTxHex: "00", blockHeight: 123, inputOutpointKeys: ["bb".repeat(32) + ":0"], inputs: [{ txid: "bb".repeat(32), vout: 0, outpointKey: "bb".repeat(32) + ":0" }], ownedOutpointKeys: [], ownedOutputs: [{ vout: 0, value: 1000, scriptHex: "" }], firstConfirmedAt: "now", lastConfirmedAt: "now" };

function registerWallet(includeTestnet: boolean, facts: P2pkhTransactionFact[] = [fact], serviceOverrides: Partial<P2pkhService> = {}, walletOverrides: Partial<WalletSnapshot> = {}) {
  const host = createPluginHost({ disableConfigPersistence: true, initialI18nResources: [p2pkhResources] });
  const registry = host.capabilities.get<ResourceRegistry>(RESOURCE_REGISTRY_CAPABILITY)!;
  const testResource = { resourceId: "p2pkh:test", publicKeyHex: owner, label: "test", address: "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn", network: "test" as const, createdAt: "now", generation: 0 };
  registry.register({ id: "p2pkh.settings", scope: "global", key: () => ["p2pkh.settings"], load: async () => ({ includeTestnet } satisfies P2pkhGlobalSettings), subscribe: () => () => undefined, invalidation: "immediate" });
  registry.register({
    id: "p2pkh.wallet",
    scope: "active-key",
    key: (_args, context) => ["p2pkh.wallet", context.activePublicKeyHex ?? "none"],
    load: async () => ({ resources: [testResource, { resourceId: "p2pkh:main", publicKeyHex: owner, label: "main", address: "1abc", network: "main" as const, createdAt: "now", generation: 0 }], facts, owned: [], locals: [], localOutpoints: [], claims: [], protectedOutpoints: [], sync: [], syncStatus: "idle" as const, balances: { main: { total: 1000, breakdown }, test: { total: 2000 } }, providers: null, factCursors: {}, ownedCursors: {}, localCursors: {}, localOutpointCursors: {}, claimCursors: {}, inputValues: { [facts[0]?.inputOutpointKeys[0] ?? ""]: 1000 }, inputValuesByResource: { "p2pkh:main": { [facts[0]?.inputOutpointKeys[0] ?? ""]: 1000 } }, ...walletOverrides }),
    subscribe: () => () => undefined,
    invalidation: "immediate"
  });
  host.provide<KeyspaceService>("keyspace.service", { active: () => ({ activePublicKeyHex: owner }), onActiveKeyChanged: () => () => undefined } as unknown as KeyspaceService);
  host.provide<SessionCoordinatorClient>(SESSION_COORDINATOR_CLIENT_CAPABILITY, {} as SessionCoordinatorClient);
  host.provide<P2pkhService>("p2pkh.service", serviceOverrides as P2pkhService);
  return host;
}

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

describe("P2pkhWalletPage", () => {
  it("shows only the selected network and sends the current page to the detail route", async () => {
    window.history.replaceState({}, "", "/p2pkh/mainnet/transactions?page=1");
    const host = registerWallet(false);
    render(<PluginHostProvider host={host}><P2pkhWalletPage network="main" /></PluginHostProvider>);
    await waitFor(() => expect(screen.getByText(txid)).toBeTruthy());
    expect(screen.getByText("Input")).toBeTruthy();
    expect(screen.getByText("Output")).toBeTruthy();
    expect(screen.getByText("Balance at block")).toBeTruthy();
    expect(screen.queryByLabelText("Network")).toBeNull();
    expect(screen.queryByRole("button", { name: "Testnet" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Provider settings" })).toBeNull();
    fireEvent.click(screen.getByText("Details"));
    expect(window.location.pathname).toBe(`/p2pkh/tx/${txid}`);
    expect(window.location.search).toBe("?network=main&page=1&source=transactions");
  });

  it("keeps identical transaction ids isolated by the network route", async () => {
    const testFact: P2pkhTransactionFact = { ...fact, id: `p2pkh:test:${txid}`, resourceId: "p2pkh:test", network: "test", address: "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn" };
    const host = registerWallet(true, [fact, testFact]);
    render(<PluginHostProvider host={host}><P2pkhWalletPage network="test" /></PluginHostProvider>);
    await waitFor(() => expect(screen.getAllByText(txid)).toHaveLength(1));
    expect(screen.getByText("On-chain transactions · Testnet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Testnet" })).toBeTruthy();
  });

  it("chooses the view from the route prop and ignores tab query parameters", async () => {
    window.history.replaceState({}, "", "/p2pkh/mainnet/transactions?page=1&tab=coins");
    const host = registerWallet(false);
    render(<PluginHostProvider host={host}><P2pkhWalletPage network="main" view="transactions" /></PluginHostProvider>);
    await screen.findByText(txid);
    expect(screen.getByText("Input")).toBeTruthy();
    expect(screen.queryByText("txid:vout")).toBeNull();
  });

  it("renders the existing Coins table on the local-transactions route", async () => {
    const owned: P2pkhOwnedOutpointProjection = {
      id: "owned-local-route", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", address: "1abc",
      txid: "cc".repeat(32), vout: 0, outpointKey: `${"cc".repeat(32)}:0`, value: 100, scriptHex: "", chainState: "available", createdBlockHeight: 100, updatedAt: "now"
    };
    window.history.replaceState({}, "", "/p2pkh/mainnet/local-transactions?page=1");
    const host = registerWallet(false, [], {}, { owned: [owned] });
    render(<PluginHostProvider host={host}><P2pkhWalletPage network="main" view="local-transactions" /></PluginHostProvider>);
    await screen.findByText(`${"cc".repeat(32)}:0`);
    expect(screen.getByText("txid:vout")).toBeTruthy();
    expect(screen.getByText("Status")).toBeTruthy();
    expect(screen.queryByText("Input")).toBeNull();
  });

  it("does not turn a disabled testnet into a zero balance", async () => {
    window.history.replaceState({}, "", "/p2pkh/testnet/transactions");
    const host = registerWallet(false);
    render(<PluginHostProvider host={host}><P2pkhWalletPage network="test" /></PluginHostProvider>);
    expect(await screen.findByText("Testnet is disabled")).toBeTruthy();
    expect(screen.queryByText("2,000 sats")).toBeNull();
  });

  it("loads remaining owned pages before calculating the block balance", async () => {
    const owned: P2pkhOwnedOutpointProjection = { id: "owned-1", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", address: "1abc", txid: "cc".repeat(32), vout: 0, outpointKey: `${"cc".repeat(32)}:0`, value: 100, scriptHex: "", chainState: "available", createdBlockHeight: 100, updatedAt: "now" };
    const host = registerWallet(false, [fact], {
      listOwnedOutpointsPage: async () => ({ items: [owned] })
    }, { ownedCursors: { "p2pkh:main": "next-owned" } });
    render(<PluginHostProvider host={host}><P2pkhWalletPage network="main" /></PluginHostProvider>);
    expect(await screen.findByText("100 sats")).toBeTruthy();
  });

  it("does not advance the page when local pagination fails", async () => {
    window.history.replaceState({}, "", "/p2pkh/mainnet/transactions?page=1");
    const host = registerWallet(false, [fact], {
      listTransactionFactsPage: async () => { throw new Error("page failed"); }
    }, { factCursors: { "p2pkh:main": "next-fact" } });
    render(<PluginHostProvider host={host}><P2pkhWalletPage network="main" /></PluginHostProvider>);
    await screen.findByText(txid);
    fireEvent.click(screen.getByText("Next"));
    expect(await screen.findByText("page failed")).toBeTruthy();
    expect(window.location.search).toBe("?page=1");
  });

  it("uses local parent outputs for chained transaction input amounts and sorts them first", async () => {
    const parentTxid = "ee".repeat(32);
    const childTxid = "ff".repeat(32);
    const olderFact: P2pkhTransactionFact = { ...fact, lastConfirmedAt: "2026-08-17T00:00:00.000Z", firstConfirmedAt: "2026-08-17T00:00:00.000Z" };
    const local: P2pkhLocalTransaction = {
      id: `local-${childTxid}`, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: childTxid, rawTxHex: "00", state: "submitting",
      inputOutpointKeys: [`${parentTxid}:0`], ownOutputs: [{ vout: 0, value: 600, scriptHex: "" }], parentTxids: [parentTxid], createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z", attempts: []
    };
    const parentOutput: P2pkhLocalOutpoint = {
      id: `local-output-${parentTxid}:0`, resourceId: "p2pkh:main", txid: parentTxid, vout: 0, value: 700, scriptHex: "", submissionId: "parent-submission", state: "available", createdAt: "2026-08-17T23:00:00.000Z", updatedAt: "2026-08-17T23:00:00.000Z"
    };
    const host = registerWallet(false, [olderFact], {}, { locals: [local], localOutpoints: [parentOutput], inputValuesByResource: {} });
    render(<PluginHostProvider host={host}><P2pkhWalletPage network="main" /></PluginHostProvider>);
    await screen.findByText(childTxid);
    const rows = screen.getAllByRole("row");
    expect(rows[1]?.textContent).toContain(childTxid);
    expect(rows[1]?.textContent).toContain("700 sats");
  });
});

describe("P2pkhTransactionDetailPage", () => {
  it("renders the local record and returns to its original list page", async () => {
    window.history.replaceState({}, "", `/p2pkh/tx/${txid}?network=main&page=4`);
    const host = registerWallet(false);
    render(<PluginHostProvider host={host}><P2pkhTransactionDetailPage /></PluginHostProvider>);
    await waitFor(() => expect(screen.getByText("Transaction details")).toBeTruthy());
    expect(screen.getByText("Total input")).toBeTruthy();
    expect(screen.getByText("Only wallet-owned outputs are available in the stored record.")).toBeTruthy();
    fireEvent.click(screen.getByText("Back to transactions"));
    expect(window.location.pathname).toBe("/p2pkh/mainnet/transactions");
    expect(window.location.search).toBe("?page=4");
  });

  it("returns a detail opened from local transactions to that list and page", async () => {
    window.history.replaceState({}, "", `/p2pkh/tx/${txid}?network=main&page=7&source=local-transactions`);
    const host = registerWallet(false);
    render(<PluginHostProvider host={host}><P2pkhTransactionDetailPage /></PluginHostProvider>);
    await screen.findByText("Transaction details");
    fireEvent.click(screen.getByText("Back to transactions"));
    expect(window.location.pathname).toBe("/p2pkh/mainnet/local-transactions");
    expect(window.location.search).toBe("?page=7");
  });

  it("reads a deep-page transaction from the local service", async () => {
    const deepTxid = "dd".repeat(32);
    const deepFact: P2pkhTransactionFact = { ...fact, id: `p2pkh:main:${deepTxid}`, txid: deepTxid };
    window.history.replaceState({}, "", `/p2pkh/tx/${deepTxid}?network=main&page=11`);
    const host = registerWallet(false, [], {
      listTransactionFacts: async () => [deepFact],
      listLocalTransactions: async () => [],
      listOwnedOutpointValues: async () => ({ [deepFact.inputOutpointKeys[0]!]: 1000 })
    });
    render(<PluginHostProvider host={host}><P2pkhTransactionDetailPage /></PluginHostProvider>);
    expect(await screen.findByText(deepTxid)).toBeTruthy();
    expect(screen.getByText("Total input")).toBeTruthy();
    expect(screen.queryByText("Transaction is not available locally")).toBeNull();
  });

  it("does not deep-scan when the transaction is already in the snapshot", async () => {
    const host = registerWallet(false, [fact], {
      listTransactionFacts: async () => { throw new Error("must not scan facts"); },
      listLocalTransactions: async () => { throw new Error("must not scan locals"); }
    });
    window.history.replaceState({}, "", `/p2pkh/tx/${txid}?network=main&page=1`);
    render(<PluginHostProvider host={host}><P2pkhTransactionDetailPage /></PluginHostProvider>);
    expect(await screen.findByText(txid)).toBeTruthy();
    expect(screen.queryByText("must not scan facts")).toBeNull();
  });
});
