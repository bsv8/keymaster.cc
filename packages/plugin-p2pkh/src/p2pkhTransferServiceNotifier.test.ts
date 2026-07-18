// packages/plugin-p2pkh/src/p2pkhTransferServiceNotifier.test.ts
// 验证 p2pkhTransferService 在三条写库路径（accepted、unknown、rejected）
// 各发一次 assetDataNotifier.emit，且 payload 包含正确的 publicKeyHex 与 kinds。

import { describe, expect, it, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { sha256 } from "@noble/hashes/sha256";
import { calcTxidFromRawTxHex, deriveP2pkhAddress } from "./p2pkhSigner.js";
import { createP2pkhTransferService } from "./p2pkhTransferService.js";
import { makeResourceId, type P2pkhKeyResource, type P2pkhUtxo } from "./p2pkhContracts.js";
import type { AssetDataNotifier } from "@keymaster/contracts";

const ACTIVE_PRIV_HEX = "0000000000000000000000000000000000000000000000000000000000000001";
const ACTIVE = deriveP2pkhAddress(ACTIVE_PRIV_HEX, "main");
const ACTIVE_PUBLIC_KEY_HEX = ACTIVE.publicKeyHex;
const RECEIVER = deriveP2pkhAddress("0000000000000000000000000000000000000000000000000000000000000002", "main");

function makeUtxo(value: number): P2pkhUtxo {
  return {
    id: `u-${value}`,
    publicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
    resourceId: makeResourceId("main"),
    network: "main",
    address: ACTIVE.address,
    txid: "0000000000000000000000000000000000000000000000000000000000000009",
    vout: 0,
    value,
    height: 1,
    status: "confirmed",
    isSpentInMempoolTx: false,
    syncedAt: "2024-01-01T00:00:00.000Z"
  };
}

function makeDb(utxos: P2pkhUtxo[], resource: P2pkhKeyResource) {
  const submissions: unknown[] = [];
  const inputClaims: unknown[] = [];
  return {
    submissions,
    inputClaims,
    async getResource(resourceId: string) {
      return resource.resourceId === resourceId ? resource : undefined;
    },
    async listLocalInputClaimsByResource(resourceId: string) {
      return resource.resourceId === resourceId ? inputClaims : [];
    },
    async listUtxos() {
      return utxos;
    },
    async putLocalSubmission(value: unknown) {
      submissions.push(value);
    },
    async putLocalInputClaim(value: unknown) {
      inputClaims.push(value);
    },
    async tryClaimSubmissionWithInputs(input: { submission: unknown; inputs: P2pkhUtxo[] }) {
      submissions.push(input.submission);
      const claimIds: string[] = [];
      for (const u of input.inputs) {
        const id = `${(input.submission as { resourceId: string }).resourceId}:${u.txid}:${u.vout}`;
        inputClaims.push({
          id,
          submissionId: (input.submission as { id: string }).id,
          resourceId: (input.submission as { resourceId: string }).resourceId,
          publicKeyHex: (input.submission as { publicKeyHex: string }).publicKeyHex,
          network: u.network,
          txid: u.txid,
          vout: u.vout,
          state: "claimed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        claimIds.push(id);
      }
      return { claimIds };
    },
    async releaseLocalInputClaims(claimIds: string[]) {
      const set = new Set(claimIds);
      for (let i = inputClaims.length - 1; i >= 0; i--) {
        const c = inputClaims[i] as { id: string };
        if (set.has(c.id)) inputClaims.splice(i, 1);
      }
    }
  };
}

function makeVault() {
  return {
    status: () => "unlocked",
    createActiveKeyCrypto: async (_publicKeyHex: string) => ({
      async signDigest(input: { publicKeyHex: string; digest: ArrayBuffer }) {
        const sig = secp256k1.sign(new Uint8Array(input.digest), hexToBytes(ACTIVE_PRIV_HEX), {
          lowS: true, prehash: false, format: "compact"
        });
        return {
          publicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
          signature: sig.buffer.slice(sig.byteOffset, sig.byteOffset + sig.byteLength)
        };
      },
      async deriveP2pkhAddress(input: { publicKeyHex: string; network: "main" | "test" }) {
        const derived = deriveP2pkhAddress(ACTIVE_PRIV_HEX, input.network);
        return { publicKeyHex: derived.publicKeyHex, address: derived.address };
      }
    }),
  } as never;
}

function makeResource(): P2pkhKeyResource {
  return {
    resourceId: makeResourceId("main"),
    publicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
    label: "active",
    address: ACTIVE.address,
    network: "main",
    createdAt: "2024-01-01T00:00:00.000Z",
    generation: 0
  };
}

type BroadcastMock = (network: "main" | "test", rawTxHex: string) => Promise<unknown>;

function setupService(broadcastFn: BroadcastMock) {
  const resource = makeResource();
  const db = makeDb([makeUtxo(3000)], resource);
  const assetDataNotifier = {
    emit: vi.fn(),
    subscribe: vi.fn(),
  };
  const service = createP2pkhTransferService({
    vault: makeVault(),
    woc: { broadcast: broadcastFn } as never,
    messageBus: { publish: vi.fn(), subscribe: vi.fn() } as never,
    assetDataNotifier: assetDataNotifier as unknown as AssetDataNotifier,
    getDb: async () => db as never,
    getActiveKey: () => ({
      publicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
      label: "active",
      capabilities: [],
      createdAt: "2024-01-01T00:00:00.000Z"
    }),
    getKeyForOwner: vi.fn(async (pk: string) => ({
      publicKeyHex: pk, label: "test", capabilities: ["p2pkh"], createdAt: "2024-01-01T00:00:00.000Z"
    })),
  });
  return { service, assetDataNotifier, db };
}

async function prepareAndSubmit(service: ReturnType<typeof setupService>["service"]) {
  const preview = await service.prepare({
    ownerPublicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
    assetId: "bsv",
    recipientAddress: RECEIVER.address,
    amountSatoshis: 1000,
    feeRateSatoshisPerKb: 1
  });
  return service.submit(preview);
}

describe("p2pkhTransferService assetDataNotifier", () => {
  it("accepted 路径发 assetDataNotifier.emit", async () => {
    const { service, assetDataNotifier } = setupService(async (_n, rawTxHex) => ({
      accepted: true,
      canonicalTxid: calcTxidFromRawTxHex(rawTxHex),
      providerReturnedTxidRaw: calcTxidFromRawTxHex(rawTxHex),
      providerReturnedTxidNormalized: calcTxidFromRawTxHex(rawTxHex),
      txidIntegrity: "exact" as const,
    }));

    const result = await prepareAndSubmit(service);
    expect(result.status).toBe("broadcast");
    expect(assetDataNotifier.emit).toHaveBeenCalledTimes(1);
    expect(assetDataNotifier.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "p2pkh",
        publicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
        kinds: expect.arrayContaining(["utxo", "submission", "claim"]),
      })
    );
  });

  it("rejected 路径（definitive rejection）发 assetDataNotifier.emit", async () => {
    const { service, assetDataNotifier } = setupService(async () => {
      throw new Error("invalid transaction");
    });

    const result = await prepareAndSubmit(service);
    expect(result.status).toBe("rejected");
    expect(assetDataNotifier.emit).toHaveBeenCalledTimes(1);
    expect(assetDataNotifier.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "p2pkh",
        publicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
        kinds: expect.arrayContaining(["utxo", "submission", "claim"]),
      })
    );
  });

  it("unknown 路径（network error）发 assetDataNotifier.emit", async () => {
    const { service, assetDataNotifier } = setupService(async () => {
      throw new Error("network timeout");
    });

    const result = await prepareAndSubmit(service);
    expect(result.status).toBe("unknown");
    expect(assetDataNotifier.emit).toHaveBeenCalledTimes(1);
    expect(assetDataNotifier.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "p2pkh",
        publicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
        kinds: expect.arrayContaining(["utxo", "submission", "claim"]),
      })
    );
  });
});

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
