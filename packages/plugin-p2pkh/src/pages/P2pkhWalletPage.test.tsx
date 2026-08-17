// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PluginHostProvider, createPluginHost } from "@keymaster/runtime";
import { RESOURCE_REGISTRY_CAPABILITY, SESSION_COORDINATOR_CLIENT_CAPABILITY, type KeyspaceService, type ResourceRegistry, type SessionCoordinatorClient } from "@keymaster/contracts";
import type { P2pkhBalanceBreakdown, P2pkhGlobalSettings, P2pkhService, P2pkhTransactionFact } from "../p2pkhContracts.js";
import { p2pkhResources } from "../manifest.js";
import { P2pkhWalletPage } from "./P2pkhWalletPage.js";

const owner = "02" + "11".repeat(32);
const txid = "aa".repeat(32);
const breakdown: P2pkhBalanceBreakdown = { blockConfirmed: 1000, localSpendable: 1000, localConfirmedChange: 0, pendingInputClaims: 0, isolated: 0 };
const fact: P2pkhTransactionFact = { id: `p2pkh:main:${txid}`, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", address: "1abc", txid, rawTxHex: "00", blockHeight: 123, inputOutpointKeys: ["bb".repeat(32) + ":0"], inputs: [{ txid: "bb".repeat(32), vout: 0, outpointKey: "bb".repeat(32) + ":0" }], ownedOutpointKeys: [], ownedOutputs: [{ vout: 0, value: 1000, scriptHex: "" }], firstConfirmedAt: "now", lastConfirmedAt: "now" };

describe("P2pkhWalletPage", () => {
  it("shows unified transaction details and filters by network", async () => {
    const host = createPluginHost({ disableConfigPersistence: true, initialI18nResources: [p2pkhResources] });
    const registry = host.capabilities.get<ResourceRegistry>(RESOURCE_REGISTRY_CAPABILITY)!;
    const settings: P2pkhGlobalSettings = { includeTestnet: true };
    registry.register({ id: "p2pkh.settings", scope: "global", key: () => ["p2pkh.settings"], load: async () => settings, subscribe: () => () => undefined, invalidation: "immediate" });
    registry.register({
      id: "p2pkh.wallet",
      scope: "active-key",
      key: (_args, context) => ["p2pkh.wallet", context.activePublicKeyHex ?? "none"],
      load: async () => ({ resources: [{ resourceId: "p2pkh:main", publicKeyHex: owner, label: "main", address: "1abc", network: "main", createdAt: "now", generation: 0 }], facts: [fact], owned: [], locals: [], localOutpoints: [], claims: [], protectedOutpoints: [], sync: [], syncStatus: "idle", balances: { main: { total: 1000, breakdown } }, providers: null, factCursors: {}, ownedCursors: {}, localCursors: {}, localOutpointCursors: {}, claimCursors: {}, inputValues: { [fact.inputOutpointKeys[0]!]: 1000 }, inputValuesByResource: { "p2pkh:main": { [fact.inputOutpointKeys[0]!]: 1000 } } }),
      subscribe: () => () => undefined,
      invalidation: "immediate"
    });
    host.provide<KeyspaceService>("keyspace.service", { active: () => ({ activePublicKeyHex: owner }), onActiveKeyChanged: () => () => undefined } as unknown as KeyspaceService);
    host.provide<SessionCoordinatorClient>(SESSION_COORDINATOR_CLIENT_CAPABILITY, {} as SessionCoordinatorClient);
    host.provide<P2pkhService>("p2pkh.service", {} as P2pkhService);
    render(<PluginHostProvider host={host}><P2pkhWalletPage /></PluginHostProvider>);
    await waitFor(() => expect(screen.getByText(txid)).toBeTruthy());
    expect(screen.getByText("Self transfer")).toBeTruthy();
    fireEvent.click(screen.getByText("Details"));
    expect(screen.getByText("Inputs")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Network"), { target: { value: "test" } });
    await waitFor(() => expect(screen.queryByText(txid)).toBeNull());
  });

  it("keeps identical txids separate across mainnet and testnet", async () => {
    const host = createPluginHost({ disableConfigPersistence: true, initialI18nResources: [p2pkhResources] });
    const registry = host.capabilities.get<ResourceRegistry>(RESOURCE_REGISTRY_CAPABILITY)!;
    const testResource = { resourceId: "p2pkh:test", publicKeyHex: owner, label: "test", address: "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn", network: "test" as const, createdAt: "now", generation: 0 };
    const testFact: P2pkhTransactionFact = { ...fact, id: `p2pkh:test:${txid}`, resourceId: testResource.resourceId, network: "test", address: testResource.address };
    registry.register({ id: "p2pkh.settings", scope: "global", key: () => ["p2pkh.settings"], load: async () => ({ includeTestnet: true } satisfies P2pkhGlobalSettings), subscribe: () => () => undefined, invalidation: "immediate" });
    registry.register({
      id: "p2pkh.wallet",
      scope: "active-key",
      key: (_args, context) => ["p2pkh.wallet", context.activePublicKeyHex ?? "none"],
      load: async () => ({ resources: [testResource, { resourceId: "p2pkh:main", publicKeyHex: owner, label: "main", address: "1abc", network: "main" as const, createdAt: "now", generation: 0 }], facts: [fact, testFact], owned: [], locals: [], localOutpoints: [], claims: [], protectedOutpoints: [], sync: [], syncStatus: "idle" as const, balances: { main: { total: 1000 }, test: { total: 1000 } }, providers: null, factCursors: {}, ownedCursors: {}, localCursors: {}, localOutpointCursors: {}, claimCursors: {}, inputValues: {}, inputValuesByResource: {} }),
      subscribe: () => () => undefined,
      invalidation: "immediate"
    });
    host.provide<KeyspaceService>("keyspace.service", { active: () => ({ activePublicKeyHex: owner }), onActiveKeyChanged: () => () => undefined } as unknown as KeyspaceService);
    host.provide<SessionCoordinatorClient>(SESSION_COORDINATOR_CLIENT_CAPABILITY, {} as SessionCoordinatorClient);
    host.provide<P2pkhService>("p2pkh.service", {} as P2pkhService);
    render(<PluginHostProvider host={host}><P2pkhWalletPage /></PluginHostProvider>);
    await waitFor(() => expect(screen.getAllByText(txid)).toHaveLength(2));
    fireEvent.change(screen.getAllByLabelText("Network").at(-1)!, { target: { value: "test" } });
    await waitFor(() => expect(screen.getAllByText(txid)).toHaveLength(1));
  });
});
