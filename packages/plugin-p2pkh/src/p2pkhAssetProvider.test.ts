import { describe, expect, it } from "vitest";
import type { KeyspaceService } from "@keymaster/contracts";
import type { MessageBus } from "webloom-framework";
import type { P2pkhHistoryRecord, P2pkhLocalTransaction, P2pkhService } from "./p2pkhContracts.js";
import { createP2pkhAssetProvider } from "./p2pkhAssetProvider.js";

const owner = "02" + "11".repeat(32);

function createDeps(history: P2pkhHistoryRecord[], locals: P2pkhLocalTransaction[]) {
  const service = {
    getGlobalSettings: () => ({ includeTestnet: false }),
    getAssetBalance: async () => ({ total: 1000, available: true }),
    syncStatus: () => "idle" as const,
    listHistory: async () => history,
    listLocalTransactions: async () => locals,
    onSyncStatusChange: () => () => undefined,
    onDataChanged: () => () => undefined,
    onGlobalSettingsChange: () => () => undefined,
  } as unknown as P2pkhService;
  const messageBus = { subscribe: () => () => undefined } as unknown as MessageBus;
  const keyspace = {
    isInitializing: () => false,
    active: () => ({ activePublicKeyHex: owner }),
    onActiveKeyChanged: () => () => undefined,
    onInitializationChange: () => () => undefined,
  } as unknown as KeyspaceService;
  return { service, messageBus, keyspace };
}

function local(id: string, txid: string, chainResolution: P2pkhLocalTransaction["chainResolution"]): P2pkhLocalTransaction {
  return { id, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid, rawTxHex: "00", localState: "submitting", chainResolution, inputOutpointKeys: [], ownOutputs: [], createdAt: "now", updatedAt: "now", attempts: [] };
}

function historyRecord(txid: string): P2pkhHistoryRecord {
  return { id: `p2pkh:main:${txid}`, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", address: "1abc", txid, height: 10, firstSeenAt: "now" };
}

describe("p2pkhAssetProvider", () => {
  it("maps unresolved locals to pending activity", async () => {
    const provider = createP2pkhAssetProvider(createDeps([], [local("pending-local", "aa".repeat(32), "unresolved")]));
    const activities = await provider.listActivity("bsv");
    expect(activities.find((row) => row.id === "pending-local")?.status).toBe("pending");
  });

  it("keeps chain-confirmed locals confirmed and excludes history duplicates", async () => {
    const txid = "bb".repeat(32);
    const provider = createP2pkhAssetProvider(
      createDeps([historyRecord(txid)], [local("promoted-local", txid, "chain-confirmed"), local("other-local", "cc".repeat(32), "unresolved")]),
    );
    const activities = await provider.listActivity("bsv");
    // 历史里的 txid 只展示一次（chain 来源）；本地重复被去重。
    expect(activities.filter((row) => row.txid === txid)).toHaveLength(1);
    expect(activities.find((row) => row.txid === txid)?.status).toBe("confirmed");
    expect(activities.find((row) => row.id === "other-local")?.status).toBe("pending");
  });

  it("lists chain history as confirmed activity", async () => {
    const txid = "dd".repeat(32);
    const provider = createP2pkhAssetProvider(createDeps([historyRecord(txid)], []));
    const activities = await provider.listActivity("bsv");
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ txid, status: "confirmed" });
  });
});
