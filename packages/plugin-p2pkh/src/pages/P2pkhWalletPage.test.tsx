// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { sha256 } from "@noble/hashes/sha256";
import { PluginHostProvider, createPluginHost } from "@keymaster/runtime";
import { P2PKH_COORDINATOR_CONTROL_CAPABILITY, RESOURCE_REGISTRY_CAPABILITY, type KeyspaceService, type P2pkhCoordinatorControl, type ResourceRegistry, type SessionCoordinatorClient } from "@keymaster/contracts";
import type { P2pkhBalanceBreakdown, P2pkhGlobalSettings, P2pkhLocalOutpoint, P2pkhLocalTransaction, P2pkhOwnedOutpointProjection, P2pkhService, P2pkhTransactionFact } from "../p2pkhContracts.js";
import { p2pkhResources } from "../manifest.js";
import { P2pkhTransactionDetailPage } from "./P2pkhTransactionDetailPage.js";
import { P2pkhWalletPage, type WalletSnapshot } from "./P2pkhWalletPage.js";

const owner = "02" + "11".repeat(32);
const txid = "aa".repeat(32);
const breakdown: P2pkhBalanceBreakdown = { blockConfirmed: 1000, localSpendable: 1000, localConfirmedChange: 0, pendingInputClaims: 0, isolated: 0 };
const fact: P2pkhTransactionFact = { id: `p2pkh:main:${txid}`, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", address: "1abc", txid, rawTxHex: "00", blockHeight: 123, inputOutpointKeys: ["bb".repeat(32) + ":0"], inputs: [{ txid: "bb".repeat(32), vout: 0, outpointKey: "bb".repeat(32) + ":0" }], ownedOutpointKeys: [], ownedOutputs: [{ vout: 0, value: 1000, scriptHex: "" }], firstConfirmedAt: "now", lastConfirmedAt: "now" };

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

function registerWallet(includeTestnet: boolean, facts: P2pkhTransactionFact[] = [fact], serviceOverrides: Partial<P2pkhService> = {}, walletOverrides: Partial<WalletSnapshot> = {}, coordinatorOverrides: Partial<SessionCoordinatorClient> = {}) {
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
  host.provide<P2pkhCoordinatorControl>(P2PKH_COORDINATOR_CONTROL_CAPABILITY, coordinatorOverrides as unknown as P2pkhCoordinatorControl);
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

  it("never shows a local-only row on the chain transactions page", async () => {
    const localOnly: P2pkhLocalTransaction = { id: "local-only", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: "dd".repeat(32), rawTxHex: "00", localState: "local-confirmed", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [] };
    const host = registerWallet(false, [fact], {}, { locals: [localOnly] });
    render(<PluginHostProvider host={host}><P2pkhWalletPage network="main" view="transactions" /></PluginHostProvider>);
    await screen.findByText(txid);
    expect(screen.queryByText(localOnly.txid)).toBeNull();
  });

  it("keeps the fact row authoritative when the same txid also has a local audit row", async () => {
    const localAudit: P2pkhLocalTransaction = { id: "local-audit", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid, rawTxHex: "00", localState: "local-confirmed", chainResolution: "chain-confirmed", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [] };
    const host = registerWallet(false, [fact], {}, { locals: [localAudit] });
    render(<PluginHostProvider host={host}><P2pkhWalletPage network="main" view="transactions" /></PluginHostProvider>);
    await screen.findByText(txid);
    expect(screen.getByText("123")).toBeTruthy();
    expect(screen.getByText("Chain confirmed")).toBeTruthy();
    expect(screen.queryByText("Local confirmed")).toBeNull();
  });

  it("hides promoted local audit rows while retaining unresolved local rows", async () => {
    const promoted: P2pkhLocalTransaction = { id: "promoted", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: "dd".repeat(32), rawTxHex: "00", localState: "local-confirmed", chainResolution: "chain-confirmed", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [] };
    const pending: P2pkhLocalTransaction = { ...promoted, id: "pending", txid: "ee".repeat(32), chainResolution: "unresolved" };
    const host = registerWallet(false, [], {}, { locals: [promoted, pending] });
    render(<PluginHostProvider host={host}><P2pkhWalletPage network="main" view="local-transactions" /></PluginHostProvider>);
    await screen.findByText(pending.txid);
    expect(screen.queryByText(promoted.txid)).toBeNull();
  });

  it("skips pages containing only promoted local audits in one load action", async () => {
    const pending: P2pkhLocalTransaction = { id: "pending-page", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: "ff".repeat(32), rawTxHex: "00", localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [] };
    let calls = 0;
    const host = registerWallet(false, [], { listLocalTransactionsPage: async () => { calls += 1; return calls === 1 ? { items: [], nextCursor: "page-2" } : { items: [pending] }; } }, { localCursors: { "p2pkh:main": "page-1" } });
    render(<PluginHostProvider host={host}><P2pkhWalletPage network="main" view="local-transactions" /></PluginHostProvider>);
    await screen.findByText(pending.txid);
    expect(calls).toBe(2);
  });

  it("fills a deep-linked local page based on visible rows, not promoted audit rows", async () => {
    window.history.replaceState({}, "", "/p2pkh/mainnet/local-transactions?page=2");
    const firstPageRows: P2pkhLocalTransaction[] = Array.from({ length: 20 }, (_, index) => ({
      id: `deep-local-${index}`, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: `${index.toString(16).padStart(2, "0")}`.repeat(32), rawTxHex: "00", localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: []
    }));
    const promoted: P2pkhLocalTransaction = { ...firstPageRows[0]!, id: "deep-promoted", txid: "ab".repeat(32), chainResolution: "chain-confirmed" };
    const pending: P2pkhLocalTransaction = { ...firstPageRows[0]!, id: "deep-pending", txid: "ac".repeat(32) };
    let calls = 0;
    const host = registerWallet(false, [], { listLocalTransactionsPage: async () => { calls += 1; return calls === 1 ? { items: [promoted], nextCursor: "page-2" } : { items: [pending] }; } }, { locals: firstPageRows, localCursors: { "p2pkh:main": "page-1" } });
    render(<PluginHostProvider host={host}><P2pkhWalletPage network="main" view="local-transactions" /></PluginHostProvider>);
    expect(await screen.findByText(pending.txid)).toBeTruthy();
    expect(calls).toBe(2);
  });

  it("circuit-breaks automatic local pagination failures and retries only on explicit next", async () => {
    window.history.replaceState({}, "", "/p2pkh/mainnet/local-transactions?page=2");
    const firstPageRows: P2pkhLocalTransaction[] = Array.from({ length: 20 }, (_, index) => ({
      id: `failed-local-${index}`, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: `${index.toString(16).padStart(2, "0")}`.repeat(32), rawTxHex: "00", localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: []
    }));
    let calls = 0;
    const host = registerWallet(false, [], { listLocalTransactionsPage: async () => { calls += 1; throw new Error("local page failed"); } }, { locals: firstPageRows, localCursors: { "p2pkh:main": "page-1" } });
    render(<PluginHostProvider host={host}><P2pkhWalletPage network="main" view="local-transactions" /></PluginHostProvider>);
    expect(await screen.findByText("local page failed")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);
    fireEvent.click(screen.getByText("Next"));
    await waitFor(() => expect(calls).toBe(2));
    expect(window.location.search).toBe("?page=2");
  });

  it("chooses the view from the route prop and ignores tab query parameters", async () => {
    window.history.replaceState({}, "", "/p2pkh/mainnet/transactions?page=1&tab=coins");
    const host = registerWallet(false);
    render(<PluginHostProvider host={host}><P2pkhWalletPage network="main" view="transactions" /></PluginHostProvider>);
    await screen.findByText(txid);
    expect(screen.getByText("Input")).toBeTruthy();
    expect(screen.queryByText("txid:vout")).toBeNull();
  });

  it("renders local transactions, not the Coins table, on the local-transactions route", async () => {
    const local: P2pkhLocalTransaction = { id: "local-route", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: "cc".repeat(32), rawTxHex: "00", localState: "local-confirmed", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [] };
    window.history.replaceState({}, "", "/p2pkh/mainnet/local-transactions?page=1");
    const host = registerWallet(false, [], {}, { locals: [local] });
    render(<PluginHostProvider host={host}><P2pkhWalletPage network="main" view="local-transactions" /></PluginHostProvider>);
    await screen.findByText(`${"cc".repeat(32)}`);
    expect(screen.getByText("Input")).toBeTruthy();
    expect(screen.getByText("Local state")).toBeTruthy();
    expect(screen.queryByText("txid:vout")).toBeNull();
  });

  it("does not offer rebroadcast for a chain-conflicted local terminal row", async () => {
    const conflicted: P2pkhLocalTransaction = { id: "conflicted-terminal", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: "ce".repeat(32), rawTxHex: "00", localState: "isolated", chainResolution: "conflicted", conflictSourceTxids: ["remote"], inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [] };
    const host = registerWallet(false, [], {}, { locals: [conflicted] });
    render(<PluginHostProvider host={host}><P2pkhWalletPage network="main" view="local-transactions" /></PluginHostProvider>);
    await screen.findByText(conflicted.txid);
    expect(screen.queryByRole("button", { name: "Rebroadcast ancestors" })).toBeNull();
  });

  it("keeps the isolated unresolved rebroadcast action and sends the exact submission id", async () => {
    const isolated: P2pkhLocalTransaction = { id: "isolated-retry-target", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: "cf".repeat(32), rawTxHex: "00", localState: "isolated", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [{ id: "attempt", submissionId: "isolated-retry-target", providerId: "woc", startedAt: "now", status: "isolated" }] };
    const p2pkhRebroadcastAncestors = vi.fn(async () => ({ status: "ok" as const, value: { status: "local-confirmed" }, sessionEpoch: "test-epoch" }));
    const host = registerWallet(false, [], {}, {
      locals: [isolated],
      providers: { syncProviders: [], broadcastProviders: [{ id: "woc", label: "WOC", supportedNetworks: ["main"] }], selection: { main: { syncProviderId: null, broadcastProviderId: "woc" }, test: { syncProviderId: null, broadcastProviderId: null }, generation: 42 } }
    }, { p2pkhRebroadcastAncestors } as unknown as Partial<SessionCoordinatorClient>);
    render(<PluginHostProvider host={host}><P2pkhWalletPage network="main" view="local-transactions" /></PluginHostProvider>);
    await screen.findByText(isolated.txid);
    fireEvent.click(screen.getByRole("button", { name: "Rebroadcast ancestors" }));
    await waitFor(() => expect(p2pkhRebroadcastAncestors).toHaveBeenCalledWith({ ownerPublicKeyHex: owner, network: "main", submissionId: isolated.id, expectedProviderGeneration: 42 }));
  });

  it("opens local details with the submission id", async () => {
    const local: P2pkhLocalTransaction = { id: "local-detail-submission", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: "cd".repeat(32), rawTxHex: "00", localState: "isolated", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [] };
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

  it("does not advance to an empty page when loaded visible records do not fill it", async () => {
    window.history.replaceState({}, "", "/p2pkh/mainnet/local-transactions?page=1");
    const partialRows: P2pkhLocalTransaction[] = Array.from({ length: 10 }, (_, index) => ({
      id: `partial-${index}`, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: `${index.toString(16).padStart(2, "0")}`.repeat(32), rawTxHex: "00", localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: []
    }));
    const extra: P2pkhLocalTransaction = { ...partialRows[0]!, id: "partial-extra", txid: "b0".repeat(32) };
    let calls = 0;
    const host = registerWallet(false, [], { listLocalTransactionsPage: async () => { calls += 1; return calls === 1 ? { items: [extra], nextCursor: undefined } : { items: [], nextCursor: undefined }; } }, { locals: partialRows, localCursors: { "p2pkh:main": "page-1" } });
    render(<PluginHostProvider host={host}><P2pkhWalletPage network="main" view="local-transactions" /></PluginHostProvider>);
    await screen.findByText(partialRows[0]!.txid);
    fireEvent.click(screen.getByText("Next"));
    await screen.findByText(extra.txid);
    expect(window.location.search).toBe("?page=1");
  });

  it("prefers chain outpoint values over stale local projections in the local list", async () => {
    const inputKey = `${"77".repeat(32)}:0`;
    const local: P2pkhLocalTransaction = { id: "chain-first-local", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: "78".repeat(32), rawTxHex: "00", localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [inputKey], ownOutputs: [{ vout: 0, value: 300, scriptHex: "" }], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [] };
    const staleOutpoint: P2pkhLocalOutpoint = { id: "stale-outpoint", resourceId: "p2pkh:main", txid: "77".repeat(32), vout: 0, value: 900, scriptHex: "", submissionId: "stale-submission", state: "available", createdAt: "now", updatedAt: "now" };
    const chainOwned: P2pkhOwnedOutpointProjection = { id: "chain-owned-overlap", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", address: "1abc", txid: "77".repeat(32), vout: 0, outpointKey: inputKey, value: 500, scriptHex: "", chainState: "available", createdBlockHeight: 100, updatedAt: "now" };
    const host = registerWallet(false, [], {}, { locals: [local], localOutpoints: [staleOutpoint], owned: [chainOwned], inputValuesByResource: {} });
    render(<PluginHostProvider host={host}><P2pkhWalletPage network="main" view="local-transactions" /></PluginHostProvider>);
    await screen.findByText(local.txid);
    expect(screen.getByText("500 sats")).toBeTruthy();
    expect(screen.queryByText("900 sats")).toBeNull();
  });

  it("uses local parent outputs for chained transaction input amounts and sorts them first", async () => {
    const parentTxid = "ee".repeat(32);
    const childTxid = "ff".repeat(32);
    const olderFact: P2pkhTransactionFact = { ...fact, lastConfirmedAt: "2026-08-17T00:00:00.000Z", firstConfirmedAt: "2026-08-17T00:00:00.000Z" };
    const local: P2pkhLocalTransaction = {
      id: `local-${childTxid}`, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: childTxid, rawTxHex: "00", localState: "submitting", chainResolution: "unresolved",
      inputOutpointKeys: [`${parentTxid}:0`], ownOutputs: [{ vout: 0, value: 600, scriptHex: "" }], parentTxids: [parentTxid], createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z", attempts: []
    };
    const parentOutput: P2pkhLocalOutpoint = {
      id: `local-output-${parentTxid}:0`, resourceId: "p2pkh:main", txid: parentTxid, vout: 0, value: 700, scriptHex: "", submissionId: "parent-submission", state: "available", createdAt: "2026-08-17T23:00:00.000Z", updatedAt: "2026-08-17T23:00:00.000Z"
    };
    const host = registerWallet(false, [olderFact], {}, { locals: [local], localOutpoints: [parentOutput], inputValuesByResource: {} });
    render(<PluginHostProvider host={host}><P2pkhWalletPage network="main" view="local-transactions" /></PluginHostProvider>);
    await screen.findByText(childTxid);
    const rows = screen.getAllByRole("row");
    expect(rows[1]?.textContent).toContain(childTxid);
    expect(rows[1]?.textContent).toContain("700 sats");
  });
});

describe("P2pkhTransactionDetailPage", () => {
  it("selects duplicate local audits by submission id and keeps deterministic old-link fallback", async () => {
    const first: P2pkhLocalTransaction = { id: "submission-a", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid, rawTxHex: "00", localState: "isolated", chainResolution: "conflicted", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [{ id: "attempt-a", submissionId: "submission-a", providerId: "woc", startedAt: "now", status: "isolated" }] };
    const second: P2pkhLocalTransaction = { ...first, id: "submission-b", localState: "local-confirmed", chainResolution: "unresolved", attempts: [{ id: "attempt-b", submissionId: "submission-b", providerId: "woc", startedAt: "now", status: "accepted" }] };
    window.history.replaceState({}, "", `/p2pkh/tx/${txid}?network=main&page=1&source=local-transactions&submissionId=submission-b`);
    const preciseHost = registerWallet(false, [fact], {}, { locals: [first, second] });
    render(<PluginHostProvider host={preciseHost}><P2pkhTransactionDetailPage /></PluginHostProvider>);
    await screen.findByText("attempt-b");
    expect(screen.queryByText("attempt-a")).toBeNull();
    expect(screen.getByText("Local confirmed")).toBeTruthy();
    cleanup();
    window.history.replaceState({}, "", `/p2pkh/tx/${txid}?network=main&page=1&source=local-transactions`);
    const legacyHost = registerWallet(false, [fact], {}, { locals: [second, first] });
    render(<PluginHostProvider host={legacyHost}><P2pkhTransactionDetailPage /></PluginHostProvider>);
    await screen.findByText("attempt-a");
    expect(screen.queryByText("attempt-b")).toBeNull();
  });

  it("deep-reads an explicit submission id instead of falling back to a first-page sibling", async () => {
    const sibling: P2pkhLocalTransaction = { id: "first-page-sibling", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid, rawTxHex: "00", localState: "isolated", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [{ id: "sibling-attempt", submissionId: "first-page-sibling", providerId: "woc", startedAt: "now", status: "isolated" }] };
    const target: P2pkhLocalTransaction = { ...sibling, id: "deep-target", attempts: [{ id: "target-attempt", submissionId: "deep-target", providerId: "woc", startedAt: "now", status: "accepted" }] };
    window.history.replaceState({}, "", `/p2pkh/tx/${txid}?network=main&page=1&source=local-transactions&submissionId=${target.id}`);
    const host = registerWallet(false, [fact], { listLocalTransactions: async () => [sibling, target] }, { locals: [sibling] });
    render(<PluginHostProvider host={host}><P2pkhTransactionDetailPage /></PluginHostProvider>);
    await screen.findByText("target-attempt");
    expect(screen.queryByText("sibling-attempt")).toBeNull();
  });

  it("opts into resolved local audits and constrains the deep read to the route resource", async () => {
    const promoted: P2pkhLocalTransaction = { id: "promoted-deep", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid, rawTxHex: "00", localState: "local-confirmed", chainResolution: "chain-confirmed", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [{ id: "promoted-attempt", submissionId: "promoted-deep", providerId: "woc", startedAt: "now", status: "accepted" }] };
    window.history.replaceState({}, "", `/p2pkh/tx/${txid}?network=main&page=1&source=local-transactions&submissionId=${promoted.id}`);
    let filter: unknown;
    const host = registerWallet(false, [], { listLocalTransactions: async (nextFilter) => { filter = nextFilter; return [promoted]; } });
    render(<PluginHostProvider host={host}><P2pkhTransactionDetailPage /></PluginHostProvider>);
    await screen.findByText("promoted-attempt");
    expect(filter).toEqual(expect.objectContaining({ resourceId: "p2pkh:main", includeResolvedLocalTransactions: true }));
  });

  it("deep-reads a local parent output when it is outside the bounded snapshot", async () => {
    const parentTxid = "d2".repeat(32);
    const childRaw = localRawTx(parentTxid, 600);
    const childTxid = childRaw.txid;
    const child: P2pkhLocalTransaction = { id: "deep-child", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: childTxid, rawTxHex: childRaw.rawTxHex, localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [`${parentTxid}:0`], ownOutputs: [{ vout: 0, value: 600, scriptHex: "" }], parentTxids: [parentTxid], createdAt: "now", updatedAt: "now", attempts: [] };
    const parent: P2pkhLocalOutpoint = { id: "deep-parent-output", resourceId: "p2pkh:main", txid: parentTxid, vout: 0, value: 700, scriptHex: "", submissionId: "deep-parent", state: "available", createdAt: "now", updatedAt: "now" };
    window.history.replaceState({}, "", `/p2pkh/tx/${childTxid}?network=main&page=1&source=local-transactions&submissionId=${child.id}`);
    const host = registerWallet(false, [], { listLocalTransactions: async () => [child], listLocalOutpoints: async (filter) => filter?.resourceId === "p2pkh:main" ? [parent] : [] });
    render(<PluginHostProvider host={host}><P2pkhTransactionDetailPage /></PluginHostProvider>);
    await screen.findByText(childTxid);
    expect(screen.getAllByText("700 sats")).toHaveLength(2);
    expect(screen.getByText("100 sats")).toBeTruthy();
  });

  it("uses bounded snapshot local parent outputs when the target is already visible", async () => {
    const parentTxid = "d3".repeat(32);
    const childRaw = localRawTx(parentTxid, 600);
    const child: P2pkhLocalTransaction = { id: "snapshot-child", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: childRaw.txid, rawTxHex: childRaw.rawTxHex, localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [`${parentTxid}:0`], ownOutputs: [{ vout: 0, value: 600, scriptHex: "" }], parentTxids: [parentTxid], createdAt: "now", updatedAt: "now", attempts: [] };
    const parent: P2pkhLocalOutpoint = { id: "snapshot-parent", resourceId: "p2pkh:main", txid: parentTxid, vout: 0, value: 700, scriptHex: "", submissionId: "parent", state: "available", createdAt: "now", updatedAt: "now" };
    window.history.replaceState({}, "", `/p2pkh/tx/${childRaw.txid}?network=main&page=1&source=local-transactions&submissionId=${child.id}`);
    const host = registerWallet(false, [], {}, { locals: [child], localOutpoints: [parent] });
    render(<PluginHostProvider host={host}><P2pkhTransactionDetailPage /></PluginHostProvider>);
    await screen.findByText(childRaw.txid);
    expect(screen.getAllByText("700 sats")).toHaveLength(2);
    expect(screen.getByText("100 sats")).toBeTruthy();
  });

  it("prefers chain outpoint values over stale local projections in detail", async () => {
    const inputKey = `${"79".repeat(32)}:0`;
    const childRaw = localRawTxFromParents(["79".repeat(32)], 300);
    const child: P2pkhLocalTransaction = { id: "chain-first-detail", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: childRaw.txid, rawTxHex: childRaw.rawTxHex, localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [inputKey], ownOutputs: [{ vout: 0, value: 300, scriptHex: "" }], parentTxids: ["79".repeat(32)], createdAt: "now", updatedAt: "now", attempts: [] };
    const staleOutpoint: P2pkhLocalOutpoint = { id: "stale-detail-outpoint", resourceId: "p2pkh:main", txid: "79".repeat(32), vout: 0, value: 900, scriptHex: "", submissionId: "stale-detail-submission", state: "available", createdAt: "now", updatedAt: "now" };
    const chainOwned: P2pkhOwnedOutpointProjection = { id: "chain-owned-detail", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", address: "1abc", txid: "79".repeat(32), vout: 0, outpointKey: inputKey, value: 500, scriptHex: "", chainState: "available", createdBlockHeight: 100, updatedAt: "now" };
    window.history.replaceState({}, "", `/p2pkh/tx/${childRaw.txid}?network=main&page=1&source=local-transactions&submissionId=${child.id}`);
    const host = registerWallet(false, [], {}, { locals: [child], localOutpoints: [staleOutpoint], owned: [chainOwned], inputValuesByResource: {} });
    render(<PluginHostProvider host={host}><P2pkhTransactionDetailPage /></PluginHostProvider>);
    await screen.findByText(childRaw.txid);
    expect(screen.getAllByText("500 sats")).toHaveLength(2);
    expect(screen.getByText("200 sats")).toBeTruthy();
    expect(screen.queryByText("900 sats")).toBeNull();
  });

  it("keeps input total and fee unknown when one of multiple input values is missing", async () => {
    const firstParentTxid = "d4".repeat(32);
    const missingParentTxid = "d5".repeat(32);
    const childRaw = localRawTxFromParents([firstParentTxid, missingParentTxid], 600);
    const child: P2pkhLocalTransaction = { id: "missing-input-child", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: childRaw.txid, rawTxHex: childRaw.rawTxHex, localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [`${firstParentTxid}:0`, `${missingParentTxid}:0`], ownOutputs: [{ vout: 0, value: 600, scriptHex: "" }], parentTxids: [firstParentTxid, missingParentTxid], createdAt: "now", updatedAt: "now", attempts: [] };
    const firstParent: P2pkhLocalOutpoint = { id: "first-parent", resourceId: "p2pkh:main", txid: firstParentTxid, vout: 0, value: 700, scriptHex: "", submissionId: "first-parent", state: "available", createdAt: "now", updatedAt: "now" };
    window.history.replaceState({}, "", `/p2pkh/tx/${childRaw.txid}?network=main&page=1&source=local-transactions&submissionId=${child.id}`);
    const host = registerWallet(false, [], {}, { locals: [child], localOutpoints: [firstParent] });
    render(<PluginHostProvider host={host}><P2pkhTransactionDetailPage /></PluginHostProvider>);
    await screen.findByText(childRaw.txid);
    expect(screen.getByText("Some input values are not stored locally.")).toBeTruthy();
    expect(screen.getByText("Total input").parentElement?.textContent).toContain("—");
    expect(screen.getByText("Fee paid").parentElement?.textContent).toContain("—");
  });

  it("shows unavailable when an explicit submission id is absent from the deep read", async () => {
    const sibling: P2pkhLocalTransaction = { id: "only-sibling", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid, rawTxHex: "00", localState: "isolated", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [{ id: "only-sibling-attempt", submissionId: "only-sibling", providerId: "woc", startedAt: "now", status: "isolated" }] };
    window.history.replaceState({}, "", `/p2pkh/tx/${txid}?network=main&page=1&source=local-transactions&submissionId=missing-submission`);
    const host = registerWallet(false, [fact], { listLocalTransactions: async () => [sibling] }, { locals: [sibling] });
    render(<PluginHostProvider host={host}><P2pkhTransactionDetailPage /></PluginHostProvider>);
    expect(await screen.findByText("Transaction is not available locally")).toBeTruthy();
    expect(screen.queryByText("only-sibling-attempt")).toBeNull();
  });

  it("shows local broadcast attempts even when the local transaction has no parents", async () => {
    const local: P2pkhLocalTransaction = { id: "local-attempt", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid, rawTxHex: "00", localState: "isolated", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [{ id: "attempt-no-parent", submissionId: "local-attempt", providerId: "woc", startedAt: "now", status: "isolated" }] };
    window.history.replaceState({}, "", `/p2pkh/tx/${txid}?network=main&page=1&source=local-transactions`);
    const host = registerWallet(false, [fact], {}, { locals: [local] });
    render(<PluginHostProvider host={host}><P2pkhTransactionDetailPage /></PluginHostProvider>);
    await screen.findByText("attempt-no-parent");
    expect(screen.getByText("Isolated")).toBeTruthy();
    expect(screen.queryByText("Parent transactions")).toBeNull();
  });

  it("shows local terminal resolution metadata in detail", async () => {
    const local: P2pkhLocalTransaction = { id: "metadata-local", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid, rawTxHex: "00", localState: "isolated", chainResolution: "conflicted", isolationReason: "provider-timeout", conflictSourceTxids: ["remote-source"], confirmedFactId: "p2pkh:main:confirmed", resolvedAt: "2026-08-21T00:00:00.000Z", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [] };
    window.history.replaceState({}, "", `/p2pkh/tx/${txid}?network=main&page=1&source=local-transactions&submissionId=${local.id}`);
    const host = registerWallet(false, [], {}, { locals: [local] });
    render(<PluginHostProvider host={host}><P2pkhTransactionDetailPage /></PluginHostProvider>);
    await screen.findByText("provider-timeout");
    expect(screen.getByText("remote-source")).toBeTruthy();
    expect(screen.getByText("p2pkh:main:confirmed")).toBeTruthy();
    expect(screen.getByText("2026-08-21T00:00:00.000Z")).toBeTruthy();
  });

  it("keeps same-tx fact and local detail source isolated", async () => {
    const local: P2pkhLocalTransaction = { id: "local-same-tx", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid, rawTxHex: "00", localState: "local-confirmed", chainResolution: "chain-confirmed", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [{ id: "local-audit", submissionId: "local-same-tx", providerId: "woc", startedAt: "now", status: "accepted" }] };
    window.history.replaceState({}, "", `/p2pkh/tx/${txid}?network=main&page=1&source=transactions`);
    const chainHost = registerWallet(false, [fact], {}, { locals: [local] });
    render(<PluginHostProvider host={chainHost}><P2pkhTransactionDetailPage /></PluginHostProvider>);
    await screen.findByText("Block");
    expect(screen.queryByText("local-audit")).toBeNull();
    cleanup();
    window.history.replaceState({}, "", `/p2pkh/tx/${txid}?network=main&page=1&source=local-transactions`);
    const localHost = registerWallet(false, [fact], {}, { locals: [local] });
    render(<PluginHostProvider host={localHost}><P2pkhTransactionDetailPage /></PluginHostProvider>);
    await screen.findByText("local-audit");
    expect(screen.queryByText("Block")).toBeNull();
  });

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
