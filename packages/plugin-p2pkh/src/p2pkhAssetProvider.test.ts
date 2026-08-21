import { describe, expect, it } from "vitest";
import type { KeyspaceService, MessageBus } from "@keymaster/contracts";
import type { P2pkhLocalTransaction, P2pkhService } from "./p2pkhContracts.js";
import { createP2pkhAssetProvider } from "./p2pkhAssetProvider.js";

const owner = "02" + "11".repeat(32);

function createDeps(locals: P2pkhLocalTransaction[]) {
  const service = {
    getGlobalSettings: () => ({ includeTestnet: false }),
    getAssetBalance: async () => ({ total: 1000 }),
    syncStatus: () => "idle" as const,
    listTransactionFacts: async () => [],
    listLocalTransactions: async () => locals,
    onSyncStatusChange: () => () => undefined,
    onDataChanged: () => () => undefined,
    onGlobalSettingsChange: () => () => undefined
  } as unknown as P2pkhService;
  const messageBus = { subscribe: () => () => undefined } as unknown as MessageBus;
  const keyspace = {
    isInitializing: () => false,
    active: () => ({ activePublicKeyHex: owner }),
    onActiveKeyChanged: () => () => undefined,
    onInitializationChange: () => () => undefined
  } as unknown as KeyspaceService;
  return { service, messageBus, keyspace };
}

function local(id: string, chainResolution: P2pkhLocalTransaction["chainResolution"]): P2pkhLocalTransaction {
  return { id, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: id.repeat(8).slice(0, 64).padEnd(64, "0"), rawTxHex: "00", localState: chainResolution === "conflicted" ? "isolated" : "submitting", chainResolution, inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [] };
}

describe("p2pkhAssetProvider", () => {
  it("maps conflicted local records to failed activity status instead of pending", async () => {
    const provider = createP2pkhAssetProvider(createDeps([local("conflicted-local", "conflicted"), local("pending-local", "unresolved")]));
    const activities = await provider.listActivity("bsv");
    const conflicted = activities.find((row) => row.id === "conflicted-local");
    expect(conflicted?.status).toBe("failed");
    expect(typeof conflicted?.title === "object" && conflicted.title.key).toBe("p2pkh.activity.failed");
    expect(activities.find((row) => row.id === "pending-local")?.status).toBe("pending");
  });

  it("keeps chain-confirmed facts confirmed and excludes promoted duplicates", async () => {
    const provider = createP2pkhAssetProvider(createDeps([local("promoted-local", "chain-confirmed")]));
    const activities = await provider.listActivity("bsv");
    expect(activities).toHaveLength(1);
    expect(activities[0]?.status).toBe("confirmed");
  });
});
