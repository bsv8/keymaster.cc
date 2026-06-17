import { describe, expect, it, vi } from "vitest";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { sha256 } from "@noble/hashes/sha256";
import { calcTxidFromRawTxHex, deriveP2pkhAddress } from "./p2pkhSigner.js";
import { createP2pkhTransferService } from "./p2pkhTransferService.js";
import { makeResourceId, type P2pkhKeyResource, type P2pkhUtxo } from "./p2pkhContracts.js";

const ACTIVE_PRIV_HEX = "0000000000000000000000000000000000000000000000000000000000000001";
const ACTIVE = deriveP2pkhAddress(ACTIVE_PRIV_HEX, "main");
const RECEIVER = deriveP2pkhAddress("0000000000000000000000000000000000000000000000000000000000000002", "main");
const ACTIVE_PUBLIC_KEY_HASH = hash160(ACTIVE.publicKeyHex);

function makeUtxo(value: number): P2pkhUtxo {
  return {
    id: `u-${value}`,
    resourceId: makeResourceId("ignored", "main"),
    keyId: "k1",
    publicKeyHash: ACTIVE_PUBLIC_KEY_HASH,
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
  const pending: unknown[] = [];
  const reservations: unknown[] = [];
  return {
    pending,
    reservations,
    async getResource(resourceId: string) {
      return resource.resourceId === resourceId ? resource : undefined;
    },
    async listReservationsByResource(resourceId: string) {
      return resource.resourceId === resourceId ? reservations : [];
    },
    async listUtxos() {
      return utxos;
    },
    async putPendingTransfer(value: unknown) {
      pending.push(value);
    },
    async putReservation(value: unknown) {
      reservations.push(value);
    }
  };
}

describe("createP2pkhTransferService", () => {
  it("prepares a final signed preview and submit only broadcasts the preview hex", async () => {
    const resource: P2pkhKeyResource = {
      resourceId: makeResourceId("ignored", "main"),
      keyId: "k1",
      publicKeyHash: ACTIVE_PUBLIC_KEY_HASH,
      label: "active",
      address: ACTIVE.address,
      network: "main",
      createdAt: "2024-01-01T00:00:00.000Z",
      generation: 0
    };
    const db = makeDb([makeUtxo(3000)], resource);
    let vaultCalls = 0;
    const broadcast = vi.fn(async (_network: "main" | "test", rawTxHex: string) => ({
      txid: calcTxidFromRawTxHex(rawTxHex)
    }));
    const service = createP2pkhTransferService({
      vault: {
        status: () => "unlocked",
        withPrivateKey: async (_keyId: string, fn: (m: { hex: string }) => Promise<string> | string) => {
          vaultCalls += 1;
          return fn({ hex: ACTIVE_PRIV_HEX });
        }
      } as never,
      woc: { broadcast } as never,
      messageBus: { publish: vi.fn(), subscribe: vi.fn() } as never,
      getDb: async () => db as never,
      getActiveKey: () => ({
        keyId: "k1",
        publicKeyHex: ACTIVE.publicKeyHex,
        publicKeyHash: ACTIVE_PUBLIC_KEY_HASH,
        label: "active",
        capabilities: [],
        createdAt: "2024-01-01T00:00:00.000Z"
      })
    });

    const preview = await service.prepare({
      assetId: "bsv",
      keyId: "k1",
      recipientAddress: RECEIVER.address,
      amountSatoshis: 1000,
      feeRateSatoshisPerKb: 1
    });

    expect(preview.rawTxHex).toMatch(/^[0-9a-f]+$/);
    expect(preview.txid).toBe(calcTxidFromRawTxHex(preview.rawTxHex));
    expect(preview.serializedSizeBytes).toBe(preview.rawTxHex.length / 2);
    expect(preview.outputs).toHaveLength(preview.allocation.changeSatoshis > 0 ? 2 : 1);
    expect(db.reservations).toHaveLength(0);

    const vaultCallsAfterPrepare = vaultCalls;
    const result = await service.submit(preview);

    expect(vaultCalls).toBe(vaultCallsAfterPrepare);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith("main", preview.rawTxHex, { timeoutMs: 30_000 });
    expect(result.status).toBe("broadcast");
    expect(result.rawTxHex).toBe(preview.rawTxHex);
    expect(result.txid).toBe(preview.txid);
    expect(db.reservations).toHaveLength(preview.allocation.selected.length);
    expect(db.pending).toHaveLength(2);
    expect((db.pending.at(-1) as { status?: string } | undefined)?.status).toBe("broadcast");
    expect((db.pending.at(-1) as { txid?: string } | undefined)?.txid).toBe(preview.txid);
  });

  it("does not re-sign when broadcast is rejected", async () => {
    const resource: P2pkhKeyResource = {
      resourceId: makeResourceId("ignored", "main"),
      keyId: "k1",
      publicKeyHash: ACTIVE_PUBLIC_KEY_HASH,
      label: "active",
      address: ACTIVE.address,
      network: "main",
      createdAt: "2024-01-01T00:00:00.000Z",
      generation: 0
    };
    const db = makeDb([makeUtxo(3000)], resource);
    let vaultCalls = 0;
    const broadcast = vi.fn(async () => {
      throw new Error("invalid transaction");
    });
    const service = createP2pkhTransferService({
      vault: {
        status: () => "unlocked",
        withPrivateKey: async (_keyId: string, fn: (m: { hex: string }) => Promise<string> | string) => {
          vaultCalls += 1;
          return fn({ hex: ACTIVE_PRIV_HEX });
        }
      } as never,
      woc: { broadcast } as never,
      messageBus: { publish: vi.fn(), subscribe: vi.fn() } as never,
      getDb: async () => db as never,
      getActiveKey: () => ({
        keyId: "k1",
        publicKeyHex: ACTIVE.publicKeyHex,
        publicKeyHash: ACTIVE_PUBLIC_KEY_HASH,
        label: "active",
        capabilities: [],
        createdAt: "2024-01-01T00:00:00.000Z"
      })
    });

    const preview = await service.prepare({
      assetId: "bsv",
      keyId: "k1",
      recipientAddress: RECEIVER.address,
      amountSatoshis: 1000,
      feeRateSatoshisPerKb: 1
    });
    const vaultCallsAfterPrepare = vaultCalls;
    const result = await service.submit(preview);

    expect(vaultCalls).toBe(vaultCallsAfterPrepare);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("rejected");
    expect(result.rawTxHex).toBe(preview.rawTxHex);
    expect(db.reservations).toHaveLength(0);
    expect(db.pending).toHaveLength(2);
    expect((db.pending.at(-1) as { status?: string } | undefined)?.status).toBe("failed");
    expect((db.pending.at(-1) as { txid?: string } | undefined)?.txid).toBe(preview.txid);
  });
});

function hash160(publicKeyHex: string): string {
  const pub = hexToBytes(publicKeyHex);
  return bytesToHex(ripemd160(sha256(pub)));
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
