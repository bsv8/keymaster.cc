import { describe, expect, it, vi } from "vitest";
import type { ProtectedOutpointRegistry } from "@keymaster/contracts";
import { createP2pkhRecentSync } from "./p2pkhRecentSync.js";
import type {
  P2pkhKeyResource,
  P2pkhLocalInputClaim,
  P2pkhLocalSubmission,
  P2pkhProtocolSubmission,
  P2pkhRecentCommit,
  P2pkhRecentSyncState
} from "./p2pkhContracts.js";
import type { P2pkhDbHandle } from "./p2pkhDb.js";
import type { SyncCoordinator } from "./p2pkhSyncCoordinator.js";

function makeResource(): P2pkhKeyResource {
  return {
    resourceId: "p2pkh:main",
    publicKeyHex: "02".repeat(33),
    label: "main",
    address: "1MainAddress",
    network: "main",
    createdAt: "2024-01-01T00:00:00.000Z",
    generation: 1
  };
}

function makeDb(initial?: {
  claims?: P2pkhLocalInputClaim[];
  localSubmissions?: P2pkhLocalSubmission[];
  protocolSubmissions?: P2pkhProtocolSubmission[];
  recentSyncState?: P2pkhRecentSyncState;
}) {
  const state = {
    claims: [...(initial?.claims ?? [])],
    localSubmissions: [...(initial?.localSubmissions ?? [])],
    protocolSubmissions: [...(initial?.protocolSubmissions ?? [])],
    recentSyncState: initial?.recentSyncState
  };
  const commits: P2pkhRecentCommit[] = [];
  const db: P2pkhDbHandle & {
    commits: P2pkhRecentCommit[];
  } = {
    commits,
    async getRecentSyncState(resourceId: string) {
      return state.recentSyncState?.resourceId === resourceId ? state.recentSyncState : undefined;
    },
    async listLocalInputClaimsByResource(resourceId: string) {
      return state.claims.filter((claim) => claim.resourceId === resourceId);
    },
    async listLocalSubmissionsByResource(resourceId: string) {
      return state.localSubmissions.filter((submission) => submission.resourceId === resourceId);
    },
    async listProtocolSubmissionsByResource(resourceId: string) {
      return state.protocolSubmissions.filter((submission) => submission.resourceId === resourceId);
    },
    async putRecentSyncState(next: P2pkhRecentSyncState) {
      state.recentSyncState = next;
    },
    async commitRecentSnapshot(commit: P2pkhRecentCommit) {
      commits.push(commit);
      if (commit.localInputClaims) {
        state.claims = commit.localInputClaims.filter((claim) => claim.state !== "released");
      }
      if (commit.localSubmissions) state.localSubmissions = [...commit.localSubmissions];
      if (commit.protocolSubmissions) state.protocolSubmissions = [...commit.protocolSubmissions];
      if (commit.recentConfirmedTxids) {
        state.recentSyncState = {
          resourceId: commit.resourceId,
          recentConfirmedTxids: commit.recentConfirmedTxids,
          lastCheckedAt: commit.lastSyncedAt,
          lastSuccessAt: commit.lastSyncedAt
        };
      }
    }
  } as never;
  return { db, state, commits };
}

function makeSync(options: {
  resource: P2pkhKeyResource;
  db: ReturnType<typeof makeDb>["db"];
  confirmedUtxos?: Array<{ txid: string; vout: number; value: number; height: number }>;
  unconfirmedUtxos?: Array<{ txid: string; vout: number; value: number; height: number }>;
  confirmedHistory?: Array<{ txid: string; height: number }>;
  unconfirmedHistory?: Array<{ txid: string; fee?: number }>;
  observations?: Record<string, "unconfirmed" | "confirmed" | undefined>;
  protectedOutpoints?: ProtectedOutpointRegistry;
}) {
  const confirmedUtxos = options.confirmedUtxos ?? [];
  const unconfirmedUtxos = options.unconfirmedUtxos ?? [];
  const confirmedHistory = options.confirmedHistory ?? [];
  const unconfirmedHistory = options.unconfirmedHistory ?? [];
  const observations = options.observations ?? {};
  const coordinator: SyncCoordinator = {
    async runRecent(resourceId, expectedGeneration, build) {
      const commit = await build();
      await options.db.commitRecentSnapshot({ ...commit, resourceId, expectedGeneration });
    },
    runBackfillPage: vi.fn(async () => undefined),
    requestBackfillYield: vi.fn(),
    removeResource: vi.fn(),
    hasRecentPending: vi.fn(() => false),
    getGeneration: vi.fn(() => options.resource.generation),
    refreshGeneration: vi.fn()
  };
  return createP2pkhRecentSync({
    woc: {
      getAddressConfirmedUtxos: vi.fn(async () => confirmedUtxos),
      getAddressUnconfirmedUtxos: vi.fn(async () => unconfirmedUtxos),
      listAddressConfirmedHistory: vi.fn(async () => ({ items: confirmedHistory, nextPageToken: undefined })),
      listAddressUnconfirmedHistory: vi.fn(async () => ({ items: unconfirmedHistory })),
      getTransactionObservation: vi.fn(async (_network, canonicalTxid) => ({
        canonicalTxid,
        observation: observations[canonicalTxid]
      }))
    } as never,
    messageBus: { publish: vi.fn(), subscribe: vi.fn() } as never,
    coordinator,
    getResources: async () => [options.resource],
    getDb: async () => options.db,
    protectedOutpoints: options.protectedOutpoints,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never
  });
}

describe("p2pkh recent sync", () => {
  it("reconciles protocol spend claims by canonicalTxid without a submission", async () => {
    const resource = makeResource();
    const { db, state } = makeDb({
      claims: [
        {
          id: "claim-1",
          submissionId: "protocol-spend-1",
          resourceId: resource.resourceId,
          publicKeyHex: resource.publicKeyHex,
          network: "main",
          txid: "input-tx",
          vout: 0,
          canonicalTxid: "proto-tx",
          state: "claimed",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z"
        }
      ]
    });
    const sync = makeSync({
      resource,
      db,
      confirmedHistory: [],
      unconfirmedHistory: [{ txid: "proto-tx" }],
      observations: { "proto-tx": "unconfirmed" }
    });

    const result = await sync.runOnce(new AbortController().signal);

    expect(result.cancelled).toBe(false);
    expect(db.commits).toHaveLength(1);
    expect(db.commits[0]?.localInputClaims?.[0]?.state).toBe("observed-consumed");
    expect(db.commits[0]?.localInputClaims?.[0]?.observation).toBe("unconfirmed");
    expect(db.commits[0]?.localInputClaims?.[0]?.canonicalTxid).toBe("proto-tx");
    expect(db.commits[0]?.localSubmissions).toHaveLength(0);
  });

  it("keeps broadcast-pending-woc and claimed inputs when WOC has not observed the transaction even if old inputs remain confirmed", async () => {
    const resource = makeResource();
    const { db, state } = makeDb({
      claims: [
        {
          id: "claim-2",
          submissionId: "submission-1",
          resourceId: resource.resourceId,
          publicKeyHex: resource.publicKeyHex,
          network: "main",
          txid: "prev-tx",
          vout: 0,
          canonicalTxid: "submit-tx",
          state: "claimed",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z"
        }
      ],
      localSubmissions: [
        {
          id: "submission-1",
          resourceId: resource.resourceId,
          publicKeyHex: resource.publicKeyHex,
          network: "main",
          assetId: "bsv",
          canonicalTxid: "submit-tx",
          rawTxHex: "0100000000",
          txidIntegrity: "exact",
          recipientAddress: "1Recipient",
          amountSatoshis: 1_000,
          status: "broadcast-pending-woc",
          inputOutpoints: [{ txid: "prev-tx", vout: 0, value: 10_000 }],
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z"
        }
      ]
    });
    const sync = makeSync({
      resource,
      db,
      confirmedUtxos: [{ txid: "prev-tx", vout: 0, value: 10_000, height: 1 }],
      unconfirmedUtxos: [],
      confirmedHistory: [],
      unconfirmedHistory: []
    });

    const result = await sync.runOnce(new AbortController().signal);

    expect(result.cancelled).toBe(false);
    expect(db.commits).toHaveLength(1);
    expect(db.commits[0]?.localSubmissions?.[0]?.status).toBe("broadcast-pending-woc");
    expect(db.commits[0]?.localSubmissions?.[0]?.observation).toBeUndefined();
    expect(db.commits[0]?.localInputClaims?.[0]?.state).toBe("claimed");
  });

  it("keeps unknown submissions and claimed inputs when WOC has not observed the transaction even if old inputs remain confirmed", async () => {
    const resource = makeResource();
    const { db } = makeDb({
      claims: [
        {
          id: "claim-unk",
          submissionId: "submission-unk",
          resourceId: resource.resourceId,
          publicKeyHex: resource.publicKeyHex,
          network: "main",
          txid: "prev-unk",
          vout: 0,
          canonicalTxid: "submit-unk",
          state: "claimed",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z"
        }
      ],
      localSubmissions: [
        {
          id: "submission-unk",
          resourceId: resource.resourceId,
          publicKeyHex: resource.publicKeyHex,
          network: "main",
          assetId: "bsv",
          canonicalTxid: "submit-unk",
          rawTxHex: "0100000000",
          txidIntegrity: "exact",
          recipientAddress: "1Recipient",
          amountSatoshis: 1_000,
          status: "unknown",
          inputOutpoints: [{ txid: "prev-unk", vout: 0, value: 10_000 }],
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z"
        }
      ]
    });
    const sync = makeSync({
      resource,
      db,
      confirmedUtxos: [{ txid: "prev-unk", vout: 0, value: 10_000, height: 1 }],
      unconfirmedUtxos: [],
      confirmedHistory: [],
      unconfirmedHistory: []
    });

    const result = await sync.runOnce(new AbortController().signal);

    expect(result.cancelled).toBe(false);
    expect(db.commits).toHaveLength(1);
    expect(db.commits[0]?.localSubmissions?.[0]?.status).toBe("unknown");
    expect(db.commits[0]?.localInputClaims?.[0]?.state).toBe("claimed");
  });

  it("releases claims only after woc-observed-unconfirmed has cleared and the old inputs return to confirmed", async () => {
    const resource = makeResource();
    const { db, state } = makeDb({
      claims: [
        {
          id: "claim-3",
          submissionId: "submission-2",
          resourceId: resource.resourceId,
          publicKeyHex: resource.publicKeyHex,
          network: "main",
          txid: "drop-tx",
          vout: 0,
          canonicalTxid: "drop-tx",
          state: "observed-consumed",
          observation: "unconfirmed",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z"
        }
      ],
      localSubmissions: [
        {
          id: "submission-2",
          resourceId: resource.resourceId,
          publicKeyHex: resource.publicKeyHex,
          network: "main",
          assetId: "bsv",
          canonicalTxid: "drop-tx",
          rawTxHex: "0100000000",
          txidIntegrity: "exact",
          recipientAddress: "1Recipient",
          amountSatoshis: 1_000,
          status: "woc-observed-unconfirmed",
          observation: "unconfirmed",
          inputOutpoints: [{ txid: "drop-tx", vout: 0, value: 10_000 }],
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z"
        }
      ]
    });
    const sync = makeSync({
      resource,
      db,
      confirmedUtxos: [{ txid: "drop-tx", vout: 0, value: 10_000, height: 1 }],
      unconfirmedUtxos: [],
      confirmedHistory: [],
      unconfirmedHistory: []
    });

    const result = await sync.runOnce(new AbortController().signal);

    expect(result.cancelled).toBe(false);
    expect(db.commits).toHaveLength(1);
    expect(db.commits[0]?.localSubmissions?.[0]?.status).toBe("woc-dropped");
    expect(db.commits[0]?.localInputClaims?.filter((claim) => claim.state === "released")).toHaveLength(1);
    expect(state.claims).toHaveLength(0);
  });

  it("does not release observed claims when the old inputs only appear in WOC unconfirmed snapshot", async () => {
    const resource = makeResource();
    const { db } = makeDb({
      claims: [
        {
          id: "claim-unconfirmed-only",
          submissionId: "submission-unconfirmed-only",
          resourceId: resource.resourceId,
          publicKeyHex: resource.publicKeyHex,
          network: "main",
          txid: "unconfirmed-input",
          vout: 0,
          canonicalTxid: "unconfirmed-tx",
          state: "observed-consumed",
          observation: "unconfirmed",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z"
        }
      ],
      localSubmissions: [
        {
          id: "submission-unconfirmed-only",
          resourceId: resource.resourceId,
          publicKeyHex: resource.publicKeyHex,
          network: "main",
          assetId: "bsv",
          canonicalTxid: "unconfirmed-tx",
          rawTxHex: "0100000000",
          txidIntegrity: "exact",
          recipientAddress: "1Recipient",
          amountSatoshis: 1_000,
          status: "woc-observed-unconfirmed",
          observation: "unconfirmed",
          inputOutpoints: [{ txid: "unconfirmed-input", vout: 0, value: 10_000 }],
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z"
        }
      ]
    });
    const sync = makeSync({
      resource,
      db,
      confirmedUtxos: [],
      unconfirmedUtxos: [{ txid: "unconfirmed-input", vout: 0, value: 10_000, height: 0 }],
      confirmedHistory: [],
      unconfirmedHistory: [],
      observations: { "proto-tx": "unconfirmed" }
    });

    const result = await sync.runOnce(new AbortController().signal);

    expect(result.cancelled).toBe(false);
    expect(db.commits).toHaveLength(1);
    expect(db.commits[0]?.localSubmissions?.[0]?.status).toBe("woc-observed-unconfirmed");
    expect(db.commits[0]?.localInputClaims?.[0]?.state).toBe("observed-consumed");
  });

  it("restores a dropped submission when WOC later confirms the canonical txid again", async () => {
    const resource = makeResource();
    const { db } = makeDb({
      localSubmissions: [
        {
          id: "submission-restore",
          resourceId: resource.resourceId,
          publicKeyHex: resource.publicKeyHex,
          network: "main",
          assetId: "bsv",
          canonicalTxid: "restore-tx",
          rawTxHex: "0100000000",
          txidIntegrity: "exact",
          recipientAddress: "1Recipient",
          amountSatoshis: 1_000,
          status: "woc-dropped",
          inputOutpoints: [{ txid: "restore-input", vout: 0, value: 10_000 }],
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z"
        }
      ]
    });
    const sync = makeSync({
      resource,
      db,
      confirmedUtxos: [{ txid: "restore-input", vout: 0, value: 10_000, height: 1 }],
      unconfirmedUtxos: [],
      confirmedHistory: [{ txid: "restore-tx", height: 2 }],
      unconfirmedHistory: [],
      observations: { "restore-tx": "confirmed" }
    });

    const result = await sync.runOnce(new AbortController().signal);

    expect(result.cancelled).toBe(false);
    expect(db.commits).toHaveLength(1);
    expect(db.commits[0]?.localSubmissions?.[0]?.status).toBe("woc-confirmed");
    expect(db.commits[0]?.localSubmissions?.[0]?.observation).toBe("confirmed");
  });

  it("releases protected claims when a protocol submission becomes woc-dropped", async () => {
    const resource = makeResource();
    const releaseClaims = vi.fn(async () => {});
    const protectedOutpoints: ProtectedOutpointRegistry = {
      register: vi.fn(),
      unregister: vi.fn(),
      unregisterByOwner: vi.fn(),
      list: vi.fn(() => []),
      isProtected: vi.fn(() => false),
      onChange: vi.fn(() => () => {}),
      claimProtectedInputs: vi.fn(async () => ({ claimIds: ["claim-a", "claim-b"] })),
      releaseClaims,
      _ids: vi.fn(() => [])
    };
    const { db } = makeDb({
      protocolSubmissions: [
        {
          id: "submission-proto",
          resourceId: resource.resourceId,
          publicKeyHex: resource.publicKeyHex,
          network: "main",
          submissionId: "submission-proto",
          canonicalTxid: "proto-dropped",
          inputs: [{ txid: "proto-input", vout: 0 }],
          protectedClaimIds: ["claim-a", "claim-b"],
          localInputClaimIds: [],
          status: "woc-observed-unconfirmed",
          observation: "unconfirmed",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z"
        }
      ]
    });
    const sync = makeSync({
      resource,
      db,
      confirmedUtxos: [{ txid: "proto-input", vout: 0, value: 10_000, height: 1 }],
      unconfirmedUtxos: [],
      confirmedHistory: [],
      unconfirmedHistory: [],
      observations: {},
      protectedOutpoints
    });

    const result = await sync.runOnce(new AbortController().signal);

    expect(result.cancelled).toBe(false);
    expect(db.commits).toHaveLength(1);
    expect(db.commits[0]?.protocolSubmissions?.[0]?.status).toBe("woc-dropped");
    expect(db.commits[0]?.protocolSubmissions?.[0]?.droppedReason).toBe("woc-dropped");
    expect(releaseClaims).toHaveBeenCalledTimes(1);
    expect(releaseClaims).toHaveBeenCalledWith(["claim-a", "claim-b"]);
  });
});
