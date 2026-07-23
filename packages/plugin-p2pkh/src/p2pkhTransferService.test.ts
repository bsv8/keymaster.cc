import { describe, expect, it, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { sha256 } from "@noble/hashes/sha256";
import { calcTxidFromRawTxHex, deriveP2pkhAddress } from "./p2pkhSigner.js";
import { createP2pkhTransferService } from "./p2pkhTransferService.js";
import { makeResourceId, type P2pkhKeyResource, type P2pkhUtxo } from "./p2pkhContracts.js";

const ACTIVE_PRIV_HEX = "0000000000000000000000000000000000000000000000000000000000000001";
const ACTIVE = deriveP2pkhAddress(ACTIVE_PRIV_HEX, "main");
// 硬切换 002 收尾：测试里所有"当前 owner"必须落到同一把真实公钥；
// ACTIVE_PUBLIC_KEY_HEX 与 vault stub 借出的私钥严格对位。
const ACTIVE_PUBLIC_KEY_HEX = ACTIVE.publicKeyHex;
const RECEIVER = deriveP2pkhAddress("0000000000000000000000000000000000000000000000000000000000000002", "main");
/** 链上 HASH160(compressed public key),用于 P2PKH 锁脚本。 */
const ACTIVE_PUBKEY_HASH160_HEX = hash160(ACTIVE_PUBLIC_KEY_HEX);

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
    // 硬切换 002 收尾：mock 简化——直接 push submission 和 claims
    // （保留原 `putLocalSubmission` 行为用于 post-broadcast 状态
    // 更新）。真实实现走单 readwrite 事务 + 冲突检测；mock 不模
    // 拟冲突，并发防重测试由专门的 test 覆盖。
    async tryClaimSubmissionWithInputs(input: { submission: unknown; inputs: P2pkhUtxo[] }) {
      submissions.push(input.submission);
      const claimIds: string[] = [];
      for (const u of input.inputs) {
        const id = `${input.submission && (input.submission as { resourceId: string }).resourceId}:${u.txid}:${u.vout}`;
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
      async signDigest(input: { publicKeyHex: string; digest: ArrayBuffer; format: "der" | "compact" }) {
        if (input.publicKeyHex !== ACTIVE_PUBLIC_KEY_HEX) {
          throw new Error("session_key_mismatch");
        }
        const sig = secp256k1.sign(new Uint8Array(input.digest), hexToBytes(ACTIVE_PRIV_HEX), {
          lowS: true,
          prehash: false,
          format: input.format
        });
        return {
          publicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
          format: input.format,
          signature: sig.buffer.slice(sig.byteOffset, sig.byteOffset + sig.byteLength)
        };
      },
      async deriveP2pkhAddress(input: { publicKeyHex: string; network: "main" | "test" }) {
        if (input.publicKeyHex !== ACTIVE_PUBLIC_KEY_HEX) {
          throw new Error("session_key_mismatch");
        }
        const derived = deriveP2pkhAddress(ACTIVE_PRIV_HEX, input.network);
        return {
          publicKeyHex: derived.publicKeyHex,
          address: derived.address
        };
      }
    }),
    withPrivateKey: async (_publicKeyHex: string, fn: (m: { hex: string }) => Promise<string> | string) =>
      fn({ hex: ACTIVE_PRIV_HEX })
  } as never;
}

describe("createP2pkhTransferService", () => {
  it("sends all available inputs minus the final fee without creating a change output", async () => {
    const resource: P2pkhKeyResource = {
      resourceId: makeResourceId("main"), publicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
      label: "active", address: ACTIVE.address, network: "main", createdAt: "2024-01-01T00:00:00.000Z", generation: 0
    };
    const service = createP2pkhTransferService({
      vault: makeVault(),
      woc: { broadcast: vi.fn() } as never,
      messageBus: { publish: vi.fn(), subscribe: vi.fn() } as never,
      getDb: async () => makeDb([makeUtxo(3_000)], resource) as never,
      getActiveKey: () => ({ publicKeyHex: ACTIVE_PUBLIC_KEY_HEX, label: "active", capabilities: [], createdAt: "now" }),
      getKeyForOwner: async (publicKeyHex) => ({ publicKeyHex, label: "active", capabilities: [], createdAt: "now" })
    });

    const preview = await service.prepare({
      ownerPublicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
      assetId: "bsv",
      recipientAddress: RECEIVER.address,
      amountSatoshis: 0,
      sendAll: true,
      feeRateSatoshisPerKb: 1_000
    });

    expect(preview.allocation.selected).toHaveLength(1);
    expect(preview.allocation.changeSatoshis).toBe(0);
    expect(preview.outputs).toEqual([{ address: RECEIVER.address, value: preview.amountSatoshis }]);
    expect(preview.amountSatoshis + preview.estimatedFeeSatoshis).toBe(3_000);
    expect(preview.amountSatoshis).toBeGreaterThan(0);
  });

  it("deducts the fee from a fixed amount only when the available balance covers the amount but not amount plus fee", async () => {
    const resource: P2pkhKeyResource = {
      resourceId: makeResourceId("main"), publicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
      label: "active", address: ACTIVE.address, network: "main", createdAt: "2024-01-01T00:00:00.000Z", generation: 0
    };
    const service = createP2pkhTransferService({
      vault: makeVault(),
      woc: { broadcast: vi.fn() } as never,
      messageBus: { publish: vi.fn(), subscribe: vi.fn() } as never,
      getDb: async () => makeDb([makeUtxo(1_000)], resource) as never,
      getActiveKey: () => ({ publicKeyHex: ACTIVE_PUBLIC_KEY_HEX, label: "active", capabilities: [], createdAt: "now" }),
      getKeyForOwner: async (publicKeyHex) => ({ publicKeyHex, label: "active", capabilities: [], createdAt: "now" })
    });

    const preview = await service.prepare({
      ownerPublicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
      assetId: "bsv",
      recipientAddress: RECEIVER.address,
      amountSatoshis: 1_000,
      feeRateSatoshisPerKb: 1_000
    });

    expect(preview.allocation.changeSatoshis).toBe(0);
    expect(preview.amountSatoshis + preview.estimatedFeeSatoshis).toBe(1_000);
    expect(preview.amountSatoshis).toBeLessThan(1_000);
  });

  it("treats a fixed amount above the available balance as an all-output transfer", async () => {
    const resource: P2pkhKeyResource = {
      resourceId: makeResourceId("main"), publicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
      label: "active", address: ACTIVE.address, network: "main", createdAt: "2024-01-01T00:00:00.000Z", generation: 0
    };
    const service = createP2pkhTransferService({
      vault: makeVault(),
      woc: { broadcast: vi.fn() } as never,
      messageBus: { publish: vi.fn(), subscribe: vi.fn() } as never,
      getDb: async () => makeDb([makeUtxo(900)], resource) as never,
      getActiveKey: () => ({ publicKeyHex: ACTIVE_PUBLIC_KEY_HEX, label: "active", capabilities: [], createdAt: "now" }),
      getKeyForOwner: async (publicKeyHex) => ({ publicKeyHex, label: "active", capabilities: [], createdAt: "now" })
    });

    const preview = await service.prepare({
      ownerPublicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
      assetId: "bsv",
      recipientAddress: RECEIVER.address,
      amountSatoshis: 1_000,
      feeRateSatoshisPerKb: 1_000
    });

    expect(preview.allocation.totalInputSatoshis).toBe(900);
    expect(preview.allocation.changeSatoshis).toBe(0);
    expect(preview.amountSatoshis + preview.estimatedFeeSatoshis).toBe(900);
    expect(preview.amountSatoshis).toBeLessThan(900);
  });

  it("prepares a final signed preview and submit only broadcasts the preview hex", async () => {
    const resource: P2pkhKeyResource = {
      resourceId: makeResourceId("main"), publicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
      
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
      vault: makeVault(),
      woc: { broadcast } as never,
      messageBus: { publish: vi.fn(), subscribe: vi.fn() } as never,
      getDb: async (_publicKeyHex: string) => db as never,
      getActiveKey: () => ({
        
publicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
        label: "active",
        capabilities: [],
        createdAt: "2024-01-01T00:00:00.000Z"
      }),
      getKeyForOwner: vi.fn(async (publicKeyHex: string) => ({ publicKeyHex, label: "test", capabilities: ["p2pkh"], createdAt: "2024-01-01T00:00:00.000Z" })),
    });

    const preview = await service.prepare({
      ownerPublicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
      assetId: "bsv",
      
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
    expect(result.status).toBe("broadcast-pending-woc");
    expect(result.rawTxHex).toBe(preview.rawTxHex);
    expect(result.txid).toBe(preview.txid);
    expect(result.submissionId).toBeTypeOf("string");
    expect(result.localInputClaimIds).toHaveLength(preview.allocation.selected.length);
    expect(db.inputClaims).toHaveLength(preview.allocation.selected.length);
    expect(db.submissions).toHaveLength(2);
    expect((db.submissions.at(-1) as { status?: string } | undefined)?.status).toBe("broadcast-pending-woc");
    expect((db.submissions.at(-1) as { canonicalTxid?: string } | undefined)?.canonicalTxid).toBe(preview.txid);
    expect((db.submissions.at(-1) as { observation?: string } | undefined)?.observation).toBeUndefined();
  });

  it("accepts reversed provider txid as broadcast", async () => {
    const resource: P2pkhKeyResource = {
      resourceId: makeResourceId("main"), publicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
      
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
      vault: makeVault(),
      woc: { broadcast } as never,
      messageBus: { publish: vi.fn(), subscribe: vi.fn() } as never,
      getDb: async (_publicKeyHex: string) => db as never,
      getActiveKey: () => ({
        
publicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
        label: "active",
        capabilities: [],
        createdAt: "2024-01-01T00:00:00.000Z"
      }),
      getKeyForOwner: vi.fn(async (publicKeyHex: string) => ({ publicKeyHex, label: "test", capabilities: ["p2pkh"], createdAt: "2024-01-01T00:00:00.000Z" })),
    });

    const preview = await service.prepare({
      ownerPublicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
      assetId: "bsv",
      
      recipientAddress: RECEIVER.address,
      amountSatoshis: 1000,
      feeRateSatoshisPerKb: 1
    });
    const result = await service.submit(preview);

    expect(result.status).toBe("broadcast-pending-woc");
    expect(result.localInputClaimIds).toHaveLength(preview.allocation.selected.length);
  });

  it("marks provider-inconsistent when broadcast txid does not match canonical txid", async () => {
    const resource: P2pkhKeyResource = {
      resourceId: makeResourceId("main"), publicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
      
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
      vault: makeVault(),
      woc: { broadcast } as never,
      messageBus: { publish: vi.fn(), subscribe: vi.fn() } as never,
      getDb: async (_publicKeyHex: string) => db as never,
      getActiveKey: () => ({
        
publicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
        label: "active",
        capabilities: [],
        createdAt: "2024-01-01T00:00:00.000Z"
      }),
      getKeyForOwner: vi.fn(async (publicKeyHex: string) => ({ publicKeyHex, label: "test", capabilities: ["p2pkh"], createdAt: "2024-01-01T00:00:00.000Z" })),
    });

    const preview = await service.prepare({
      ownerPublicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
      assetId: "bsv",
      
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
      resourceId: makeResourceId("main"), publicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
      
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
      vault: makeVault(),
      woc: { broadcast } as never,
      messageBus: { publish: vi.fn(), subscribe: vi.fn() } as never,
      getDb: async (_publicKeyHex: string) => db as never,
      getActiveKey: () => ({
        
publicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
        label: "active",
        capabilities: [],
        createdAt: "2024-01-01T00:00:00.000Z"
      }),
      getKeyForOwner: vi.fn(async (publicKeyHex: string) => ({ publicKeyHex, label: "test", capabilities: ["p2pkh"], createdAt: "2024-01-01T00:00:00.000Z" })),
    });

    const preview = await service.prepare({
      ownerPublicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
      assetId: "bsv",
      
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
    expect((db.submissions.at(-1) as { status?: string } | undefined)?.status).toBe("rejected");
  });

  it("rejects signing when runtime returns mismatched format (requested der, got compact)", async () => {
    // 构造一个返回错误 format 的 vault mock
    const mismatchVault = {
      status: () => "unlocked",
      createActiveKeyCrypto: async (_publicKeyHex: string) => ({
        async signDigest(input: { publicKeyHex: string; digest: ArrayBuffer; format: "der" | "compact" }) {
          const wrongFormat = input.format === "der" ? "compact" as const : "der" as const;
          const sig = secp256k1.sign(new Uint8Array(input.digest), hexToBytes(ACTIVE_PRIV_HEX), {
            lowS: true, prehash: false, format: wrongFormat
          });
          return {
            publicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
            format: wrongFormat,
            signature: sig.buffer.slice(sig.byteOffset, sig.byteOffset + sig.byteLength)
          };
        },
        async deriveP2pkhAddress(input: { publicKeyHex: string; network: "main" | "test" }) {
          const derived = deriveP2pkhAddress(ACTIVE_PRIV_HEX, input.network);
          return { publicKeyHex: derived.publicKeyHex, address: derived.address };
        }
      }),
      withPrivateKey: async (_publicKeyHex: string, fn: (m: { hex: string }) => Promise<string> | string) =>
        fn({ hex: ACTIVE_PRIV_HEX })
    } as never;

    const resource: P2pkhKeyResource = {
      resourceId: makeResourceId("main"), publicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
      label: "active",
      address: ACTIVE.address,
      network: "main",
      createdAt: "2024-01-01T00:00:00.000Z",
      generation: 0
    };
    const db = makeDb([makeUtxo(3000)], resource);
    const service = createP2pkhTransferService({
      vault: mismatchVault,
      woc: { broadcast: vi.fn() } as never,
      messageBus: { publish: vi.fn(), subscribe: vi.fn() } as never,
      getDb: async (_publicKeyHex: string) => db as never,
      getActiveKey: () => ({
        publicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
        label: "active",
        capabilities: [],
        createdAt: "2024-01-01T00:00:00.000Z"
      }),
      getKeyForOwner: vi.fn(async (publicKeyHex: string) => ({ publicKeyHex, label: "test", capabilities: ["p2pkh"], createdAt: "2024-01-01T00:00:00.000Z" })),
    });

    await expect(
      service.prepare({
        ownerPublicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
        assetId: "bsv",
        recipientAddress: RECEIVER.address,
        amountSatoshis: 1000,
        feeRateSatoshisPerKb: 1
      })
    ).rejects.toThrow("signDigest (p2pkh) format mismatch");
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
