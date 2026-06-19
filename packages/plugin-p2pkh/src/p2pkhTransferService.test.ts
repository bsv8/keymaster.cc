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
    const broadcast = vi.fn(async (_network: "main" | "test", rawTxHex: string) => {
      const txid = calcTxidFromRawTxHex(rawTxHex);
      return {
        accepted: true,
        canonicalTxid: txid,
        providerReturnedTxidRaw: txid,
        providerReturnedTxidNormalized: txid,
        txidIntegrity: "exact" as const
      };
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

    expect(preview.rawTxHex).toMatch(/^[0-9a-f]+$/);
    expect(preview.txid).toBe(calcTxidFromRawTxHex(preview.rawTxHex));
    expect(preview.serializedSizeBytes).toBe(preview.rawTxHex.length / 2);
    expect(preview.outputs).toHaveLength(preview.allocation.changeSatoshis > 0 ? 2 : 1);
    expect(db.inputClaims).toHaveLength(0);

    const vaultCallsAfterPrepare = vaultCalls;
    const result = await service.submit(preview);

    expect(vaultCalls).toBe(vaultCallsAfterPrepare);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith("main", preview.rawTxHex, { timeoutMs: 30_000 });
    expect(result.status).toBe("broadcast");
    expect(result.rawTxHex).toBe(preview.rawTxHex);
    expect(result.txid).toBe(preview.txid);
    expect(result.submissionId).toBeTypeOf("string");
    expect(result.localInputClaimIds).toHaveLength(preview.allocation.selected.length);
    expect(db.inputClaims).toHaveLength(preview.allocation.selected.length);
    expect(db.submissions).toHaveLength(2);
    expect((db.submissions.at(-1) as { status?: string } | undefined)?.status).toBe("broadcast");
    expect((db.submissions.at(-1) as { canonicalTxid?: string } | undefined)?.canonicalTxid).toBe(preview.txid);
  });

  it("accepts reversed provider txid as broadcast", async () => {
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
    const broadcast = vi.fn(async (_network: "main" | "test", rawTxHex: string) => {
      const txid = calcTxidFromRawTxHex(rawTxHex);
      const reversed = txid.match(/../g)?.reverse().join("") ?? txid;
      return {
        accepted: true,
        canonicalTxid: txid,
        providerReturnedTxidRaw: reversed,
        providerReturnedTxidNormalized: reversed,
        txidIntegrity: "reversed" as const
      };
    });
    const service = createP2pkhTransferService({
      vault: {
        status: () => "unlocked",
        withPrivateKey: async (_keyId: string, fn: (m: { hex: string }) => Promise<string> | string) =>
          fn({ hex: ACTIVE_PRIV_HEX })
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
    const result = await service.submit(preview);

    expect(result.status).toBe("broadcast");
    expect(result.localInputClaimIds).toHaveLength(preview.allocation.selected.length);
  });

  it("marks provider-inconsistent when broadcast txid does not match canonical txid", async () => {
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
    const previewTxid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const providerTxid = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const reversedProviderTxid = providerTxid.match(/../g)?.reverse().join("") ?? providerTxid;
    const broadcast = vi.fn(async () => ({
      accepted: true,
      canonicalTxid: previewTxid,
      providerReturnedTxidRaw: reversedProviderTxid,
      providerReturnedTxidNormalized: reversedProviderTxid,
      txidIntegrity: "mismatch" as const
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
    const vaultCallsAfterPrepare = vaultCalls;
    const result = await service.submit(preview);

    expect(vaultCalls).toBe(vaultCallsAfterPrepare);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("provider-inconsistent");
    expect(result.rawTxHex).toBe(preview.rawTxHex);
    expect(result.localInputClaimIds).toHaveLength(preview.allocation.selected.length);
    expect(db.inputClaims).toHaveLength(preview.allocation.selected.length);
    expect(db.submissions).toHaveLength(2);
    expect((db.submissions.at(-1) as { status?: string } | undefined)?.status).toBe("provider-inconsistent");
    expect((db.submissions.at(-1) as { txidIntegrity?: string } | undefined)?.txidIntegrity).toBe("mismatch");
  });

  it("does not create local input claims when broadcast is rejected", async () => {
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
    expect(db.inputClaims).toHaveLength(0);
    expect(db.submissions).toHaveLength(2);
    expect((db.submissions.at(-1) as { status?: string } | undefined)?.status).toBe("failed");
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
