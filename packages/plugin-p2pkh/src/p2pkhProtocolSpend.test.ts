import "fake-indexeddb/auto";

import { afterEach, describe, expect, it, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { KeyScopedStorageHandle, KeyspaceService, ProtectedOutpointRegistry } from "@keymaster/contracts";
import { createP2pkhProtocolSpendService } from "./p2pkhProtocolSpend.js";
import { createP2pkhDb, disposeP2pkhDb, openP2pkhDb, resourceIdFor } from "./p2pkhDb.js";
import type { P2pkhLocalSubmission } from "./p2pkhContracts.js";
import { calcTxidFromRawTxHex, deriveP2pkhAddress } from "./p2pkhSigner.js";

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function makeClaimStore() {
  type ClaimState = "claimed" | "observed-consumed";
  const claims = new Map<string, {
    id: string;
    submissionId: string;
    resourceId: string;
    publicKeyHex: string;
    network: "main" | "test";
    txid: string;
    vout: number;
    state: ClaimState;
    observation?: "unconfirmed" | "confirmed";
  }>();

  return {
    claims,
    async tryClaimInputs(input: {
      submissionId: string;
      resourceId: string;
      publicKeyHex: string;
      network: "main" | "test";
      inputs: Array<{ txid: string; vout: number }>;
    }) {
      const claimIds: string[] = [];
      for (const u of input.inputs) {
        const id = `${input.resourceId}:${u.txid}:${u.vout}`;
        const existing = claims.get(id);
        if (existing && existing.state === "claimed" && existing.submissionId !== input.submissionId) {
          throw new Error(`P2PKH input already claimed by another submission: ${u.txid}:${u.vout} (submissionId=${existing.submissionId})`);
        }
        claims.set(id, {
          id,
          submissionId: input.submissionId,
          resourceId: input.resourceId,
          publicKeyHex: input.publicKeyHex,
          network: input.network,
          txid: u.txid,
          vout: u.vout,
          state: "claimed"
        });
        claimIds.push(id);
      }
      return { claimIds };
    },
    async releaseLocalInputClaims(input: { publicKeyHex: string; claimIds: string[] }) {
      for (const id of input.claimIds) {
        const existing = claims.get(id);
        if (existing && existing.publicKeyHex !== input.publicKeyHex) {
          throw new Error(`claim owner mismatch for ${id}`);
        }
        claims.delete(id);
      }
    },
    markObservedConsumed(claimIds: string[]) {
      for (const id of claimIds) {
        const existing = claims.get(id);
        if (existing) {
          claims.set(id, { ...existing, state: "observed-consumed" });
        }
      }
    },
    list() {
      return [...claims.values()];
    },
    get(id: string) {
      return claims.get(id);
    }
  };
}

function makeService(options?: {
  claimStore?: ReturnType<typeof makeClaimStore>;
  broadcast?: (network: "main" | "test", rawTxHex: string) => Promise<unknown>;
  protectedOutpoints?: ProtectedOutpointRegistry;
}) {
  const privHex = options?.claimStore ? "00000000000000000000000000000000000000000000000000000000000000a1" : "00000000000000000000000000000000000000000000000000000000000000aa";
  const owner = deriveP2pkhAddress(privHex, "main");
  const claimStore = options?.claimStore ?? makeClaimStore();
  const service = createP2pkhProtocolSpendService({
    vault: {
      status: () => "unlocked",
      createActiveKeyCrypto: async () => ({
        signDigest: async (input: { publicKeyHex: string; digest: ArrayBuffer; format: "der" | "compact" }) => {
          expect(input.publicKeyHex).toBe(owner.publicKeyHex);
          const sig = secp256k1.sign(new Uint8Array(input.digest), hexToBytes(privHex), {
            lowS: true,
            prehash: false,
            format: input.format
          });
          return {
            publicKeyHex: owner.publicKeyHex,
            format: input.format,
            signature: sig.buffer.slice(sig.byteOffset, sig.byteOffset + sig.byteLength)
          };
        }
      })
    } as never,
    woc: {
      broadcast: options?.broadcast ?? vi.fn(async (_network: "main" | "test", rawTxHex: string) => ({
        accepted: true as const,
        canonicalTxid: calcTxidFromRawTxHex(rawTxHex),
        providerReturnedTxidRaw: calcTxidFromRawTxHex(rawTxHex),
        providerReturnedTxidNormalized: calcTxidFromRawTxHex(rawTxHex),
        txidIntegrity: "exact" as const
      }))
    } as never,
    claimStore,
    protectedOutpoints: options?.protectedOutpoints,
    getKeyForOwner: async (ownerPublicKeyHex: string) => {
      expect(ownerPublicKeyHex).toBe(owner.publicKeyHex);
      return { publicKeyHex: owner.publicKeyHex };
    }
  });
  return { service, owner, claimStore };
}

const INTEGRATION_PRIV = "00000000000000000000000000000000000000000000000000000000000000c1";
const INTEGRATION_OWNER = deriveP2pkhAddress(INTEGRATION_PRIV, "main");
const INTEGRATION_DB_NAME = `keymaster.key.${INTEGRATION_OWNER.publicKeyHex}.plugin.p2pkh.state`;

function makeIntegrationKeyspace(publicKeyHex: string): KeyspaceService {
  return {
    listKeys: async () => [],
    getKey: async () => undefined,
    active: () => ({ activePublicKeyHex: publicKeyHex }),
    setActive: async () => undefined,
    requireActiveKey: () => ({
      publicKeyHex,
      label: "integration",
      capabilities: ["p2pkh"],
      createdAt: "2024-01-01T00:00:00.000Z"
    }),
    onActiveKeyChanged: () => () => undefined,
    openKeyStorage: async (input) => {
      if (input.publicKeyHex !== publicKeyHex) {
        throw new Error("Key storage is not ready");
      }
      const name = `keymaster.key.${input.publicKeyHex}.plugin.${input.pluginId}.${input.storageId}`;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open(name, input.version);
        r.onupgradeneeded = () => {
          input.upgrade(r.result, 0, input.version);
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const handle: KeyScopedStorageHandle = {
        db,
        name,
        close: () => db.close()
      };
      return handle;
    },
    registerPluginStorage: () => undefined,
    listPluginStorages: () => [],
    prepareDeleteKey: async () => undefined,
    deleteKey: async () => undefined,
    isInitializing: () => false,
    onInitializationChange: () => () => undefined,
    attachBackgroundService: () => undefined
  };
}

async function openIntegrationDb(): Promise<{
  close(): void;
  db: ReturnType<typeof createP2pkhDb>;
}> {
  const bundle = await openP2pkhDb({ keyspace: makeIntegrationKeyspace(INTEGRATION_OWNER.publicKeyHex), publicKeyHex: INTEGRATION_OWNER.publicKeyHex });
  return {
    close: () => bundle.close(),
    db: createP2pkhDb(bundle)
  };
}

async function resetIntegrationDb(): Promise<void> {
  disposeP2pkhDb(INTEGRATION_OWNER.publicKeyHex);
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(INTEGRATION_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

afterEach(async () => {
  await resetIntegrationDb();
});

describe("createP2pkhProtocolSpendService", () => {
  it("prepares and submits arbitrary output plans", async () => {
    const { service, owner, claimStore } = makeService();
    const preview = await service.prepare({
      ownerPublicKeyHex: owner.publicKeyHex,
      network: "main",
      inputs: [{ txid: "11".repeat(32), vout: 0, value: 10_000, address: owner.address }],
      outputs: [{ value: 1_000, scriptHex: "6a", label: "op-return" }],
      feeRateSatoshisPerKb: 1,
      changeAddress: owner.address
    });

    expect(preview.ownerPublicKeyHex).toBe(owner.publicKeyHex);
    expect(preview.changeSatoshis).toBeGreaterThanOrEqual(0);
    expect(preview.txid).toBe(calcTxidFromRawTxHex(preview.rawTxHex));
    expect(preview.outputs[0]!.scriptHex).toBe("6a");
    expect(preview.inputClaimIds).toHaveLength(1);
    expect(preview.submissionId).toMatch(/[0-9a-f-]{36}/);
    expect(claimStore.list()).toHaveLength(1);
    expect(claimStore.list()[0]?.state).toBe("claimed");
    expect(claimStore.list()[0]?.observation).toBeUndefined();

    const result = await service.submit(preview);
    expect(result.status).toBe("broadcast-pending-woc");
    expect(result.txid).toBe(preview.txid);
    expect(result.inputClaimIds).toEqual(preview.inputClaimIds);
    expect(result.submissionId).toBe(preview.submissionId);
    expect(result.observation).toBeUndefined();
  });

  it("claims inputs under resourceIdFor(network)", async () => {
    const { service, owner, claimStore } = makeService();
    const preview = await service.prepare({
      ownerPublicKeyHex: owner.publicKeyHex,
      network: "main",
      inputs: [{ txid: "ab".repeat(32), vout: 1, value: 10_000, address: owner.address }],
      outputs: [{ value: 1_000, scriptHex: "6a", label: "op-return" }],
      feeRateSatoshisPerKb: 1,
      changeAddress: owner.address
    });

    expect(claimStore.list()[0]?.resourceId).toBe(resourceIdFor("main"));
    expect(preview.inputClaimIds).toHaveLength(1);
    expect(preview.inputClaimIds?.[0]).toContain(resourceIdFor("main"));
  });

  it("rejects protocol spend when transfer has already claimed the same outpoint, and vice versa", async () => {
    const { db } = await openIntegrationDb();
    const resourceId = resourceIdFor("main");
    const txid = "cd".repeat(32);
    const vout = 0;
    const transferSubmission: P2pkhLocalSubmission = {
      id: "transfer-submission-1",
      resourceId,
      publicKeyHex: INTEGRATION_OWNER.publicKeyHex,
      network: "main",
      assetId: "bsv",
      canonicalTxid: txid,
      rawTxHex: "0100000000",
      txidIntegrity: "exact",
      recipientAddress: INTEGRATION_OWNER.address,
      amountSatoshis: 1_000,
      status: "submitting",
      inputOutpoints: [{ txid, vout, value: 10_000 }],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z"
    };

    await db.tryClaimSubmissionWithInputs({
      submission: transferSubmission,
      inputs: [{ txid, vout, value: 10_000, address: INTEGRATION_OWNER.address, id: "utxo-1", resourceId, publicKeyHex: INTEGRATION_OWNER.publicKeyHex, network: "main", status: "confirmed", isSpentInMempoolTx: false, syncedAt: "2024-01-01T00:00:00.000Z" }]
    });

    const protocolSpendAfterTransfer = createP2pkhProtocolSpendService({
      vault: {
        status: () => "unlocked",
        createActiveKeyCrypto: async () => ({
          signDigest: async () => ({
            publicKeyHex: INTEGRATION_OWNER.publicKeyHex,
            format: "der" as const,
            signature: new Uint8Array(64).buffer
          })
        })
      } as never,
      woc: { broadcast: vi.fn(async () => ({ accepted: true as const, canonicalTxid: txid, providerReturnedTxidRaw: txid, providerReturnedTxidNormalized: txid, txidIntegrity: "exact" as const })) } as never,
      claimStore: {
        tryClaimInputs: async (input) => db.tryClaimInputs(input),
        releaseLocalInputClaims: async (input) => db.releaseLocalInputClaims(input.claimIds)
      },
      getKeyForOwner: async () => ({ publicKeyHex: INTEGRATION_OWNER.publicKeyHex })
    });

    await expect(protocolSpendAfterTransfer.prepare({
      ownerPublicKeyHex: INTEGRATION_OWNER.publicKeyHex,
      network: "main",
      inputs: [{ txid, vout, value: 10_000, address: INTEGRATION_OWNER.address }],
      outputs: [{ value: 1_000, scriptHex: "6a", label: "op-return" }],
      feeRateSatoshisPerKb: 1,
      changeAddress: INTEGRATION_OWNER.address
    })).rejects.toThrow(/already claimed/);

    const protocolFirst = createP2pkhProtocolSpendService({
      vault: {
        status: () => "unlocked",
        createActiveKeyCrypto: async () => ({
          signDigest: async () => ({
            publicKeyHex: INTEGRATION_OWNER.publicKeyHex,
            format: "der" as const,
            signature: new Uint8Array(64).buffer
          })
        })
      } as never,
      woc: { broadcast: vi.fn(async () => ({ accepted: true as const, canonicalTxid: txid, providerReturnedTxidRaw: txid, providerReturnedTxidNormalized: txid, txidIntegrity: "exact" as const })) } as never,
      claimStore: {
        tryClaimInputs: async (input) => db.tryClaimInputs(input),
        releaseLocalInputClaims: async (input) => db.releaseLocalInputClaims(input.claimIds)
      },
      getKeyForOwner: async () => ({ publicKeyHex: INTEGRATION_OWNER.publicKeyHex })
    });

    await protocolFirst.prepare({
      ownerPublicKeyHex: INTEGRATION_OWNER.publicKeyHex,
      network: "main",
      inputs: [{ txid: `${"ef".repeat(32)}`, vout: 0, value: 10_000, address: INTEGRATION_OWNER.address }],
      outputs: [{ value: 1_000, scriptHex: "6a", label: "op-return" }],
      feeRateSatoshisPerKb: 1,
      changeAddress: INTEGRATION_OWNER.address
    });

    await expect(db.tryClaimSubmissionWithInputs({
      submission: {
        ...transferSubmission,
        id: "transfer-submission-2",
        canonicalTxid: `${"ef".repeat(32)}`,
        inputOutpoints: [{ txid: `${"ef".repeat(32)}`, vout: 0, value: 10_000 }],
        updatedAt: "2024-01-01T00:00:00.000Z"
      },
      inputs: [{ txid: `${"ef".repeat(32)}`, vout: 0, value: 10_000, address: INTEGRATION_OWNER.address, id: "utxo-2", resourceId, publicKeyHex: INTEGRATION_OWNER.publicKeyHex, network: "main", status: "confirmed", isSpentInMempoolTx: false, syncedAt: "2024-01-01T00:00:00.000Z" }]
    })).rejects.toThrow(/already claimed/);
  });

  it("rejects the second concurrent prepare for the same funding UTXO", async () => {
    const { service, owner } = makeService();
    const input = {
      ownerPublicKeyHex: owner.publicKeyHex,
      network: "main" as const,
      inputs: [{ txid: "22".repeat(32), vout: 0, value: 10_000, address: owner.address }],
      outputs: [{ value: 1_000, scriptHex: "6a", label: "op-return" }],
      feeRateSatoshisPerKb: 1,
      changeAddress: owner.address
    };

    const [first, second] = await Promise.allSettled([service.prepare(input), service.prepare(input)]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") {
      expect(String(second.reason)).toMatch(/already claimed/);
    }
  });

  it("releases claims after rejected broadcast and allows re-preview", async () => {
    const { service, owner, claimStore } = makeService({
      broadcast: vi.fn(async () => {
        throw new Error("bad-txns-inputs-spent");
      })
    });

    const preview = await service.prepare({
      ownerPublicKeyHex: owner.publicKeyHex,
      network: "main",
      inputs: [{ txid: "33".repeat(32), vout: 0, value: 10_000, address: owner.address }],
      outputs: [{ value: 1_000, scriptHex: "6a", label: "op-return" }],
      feeRateSatoshisPerKb: 1,
      changeAddress: owner.address
    });
    const result = await service.submit(preview);
    expect(result.status).toBe("rejected");
    expect(claimStore.list()).toHaveLength(0);

    const retry = await service.prepare({
      ownerPublicKeyHex: owner.publicKeyHex,
      network: "main",
      inputs: [{ txid: "33".repeat(32), vout: 0, value: 10_000, address: owner.address }],
      outputs: [{ value: 1_000, scriptHex: "6a", label: "op-return" }],
      feeRateSatoshisPerKb: 1,
      changeAddress: owner.address
    });
    expect(retry.inputClaimIds).toHaveLength(1);
  });

  it("keeps claims after unknown broadcast and blocks re-preview", async () => {
    const { service, owner, claimStore } = makeService({
      broadcast: vi.fn(async () => {
        throw new Error("network timeout");
      })
    });

    const preview = await service.prepare({
      ownerPublicKeyHex: owner.publicKeyHex,
      network: "main",
      inputs: [{ txid: "44".repeat(32), vout: 0, value: 10_000, address: owner.address }],
      outputs: [{ value: 1_000, scriptHex: "6a", label: "op-return" }],
      feeRateSatoshisPerKb: 1,
      changeAddress: owner.address
    });
    const result = await service.submit(preview);
    expect(result.status).toBe("unknown");
    expect(claimStore.list()).toHaveLength(1);

    await expect(service.prepare({
      ownerPublicKeyHex: owner.publicKeyHex,
      network: "main",
      inputs: [{ txid: "44".repeat(32), vout: 0, value: 10_000, address: owner.address }],
      outputs: [{ value: 1_000, scriptHex: "6a", label: "op-return" }],
      feeRateSatoshisPerKb: 1,
      changeAddress: owner.address
    })).rejects.toThrow(/already claimed/);
  });

  it("claims both protected token inputs and plain funding inputs", async () => {
    const releaseClaims = vi.fn(async () => {});
    const claimProtectedInputs = vi.fn(async () => ({ claimIds: ["protected-claim-1"] }));
    const protectedOutpoints: ProtectedOutpointRegistry = {
      register: vi.fn(),
      unregister: vi.fn(),
      list: vi.fn(() => [{
        txid: "55".repeat(32),
        vout: 0,
        network: "main" as const,
        ownerPluginId: "token-bsv21"
      }]),
      isProtected: vi.fn((input) => input.txid === "55".repeat(32) && input.vout === 0 && input.network === "main"),
      onChange: vi.fn(() => () => {}),
      claimProtectedInputs,
      releaseClaims,
      unregisterByOwner: vi.fn(),
      _ids: vi.fn(() => ["token-bsv21"])
    };
    const { service, owner, claimStore } = makeService({ protectedOutpoints });

    const preview = await service.prepare({
      ownerPublicKeyHex: owner.publicKeyHex,
      requestingPluginId: "token-bsv21",
      network: "main",
      inputs: [
        { txid: "55".repeat(32), vout: 0, value: 10_000, address: owner.address },
        { txid: "66".repeat(32), vout: 1, value: 5_000, address: owner.address }
      ],
      outputs: [{ value: 1_000, scriptHex: "6a", label: "op-return" }],
      feeRateSatoshisPerKb: 1,
      changeAddress: owner.address
    });

    expect(claimProtectedInputs).toHaveBeenCalledTimes(1);
    expect(preview.inputClaimIds).toHaveLength(2);
    expect(claimStore.list()).toHaveLength(2);
  });

  it("can mark claims observed-consumed during WOC reconcile", async () => {
    const { service, owner, claimStore } = makeService();
    const preview = await service.prepare({
      ownerPublicKeyHex: owner.publicKeyHex,
      network: "main",
      inputs: [{ txid: "77".repeat(32), vout: 0, value: 10_000, address: owner.address }],
      outputs: [{ value: 1_000, scriptHex: "6a", label: "op-return" }],
      feeRateSatoshisPerKb: 1,
      changeAddress: owner.address
    });

    claimStore.markObservedConsumed(preview.inputClaimIds ?? []);
    const claimId = preview.inputClaimIds?.[0];
    expect(claimId).toBeTypeOf("string");
    expect(claimId ? claimStore.get(claimId)?.state : undefined).toBe("observed-consumed");

    await claimStore.releaseLocalInputClaims({
      publicKeyHex: owner.publicKeyHex,
      claimIds: preview.inputClaimIds ?? []
    });
    expect(claimStore.list()).toHaveLength(0);
  });
});
