import { describe, expect, it, vi } from "vitest";
import type { KeyspaceService, ProtocolSpendPreview, ProtocolSpendService } from "@keymaster/contracts";
import type { OrdinalMintHistoryDb } from "./ordinalMintHistoryDb.js";
import { createOrdinalMintService } from "./ordinalMintService.js";
import type { P2pkhServiceFor1Sat } from "./ordinalsService.js";

const ACTIVE_PK = "pk-active";

function fakeKeyspace(): KeyspaceService {
  return { active: () => ({ activePublicKeyHex: ACTIVE_PK }) } as unknown as KeyspaceService;
}

function fakeP2pkh(): P2pkhServiceFor1Sat {
  return {
    listUtxos: async () => [
      { txid: "funding", vout: 0, value: 500, address: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT" }
    ],
    getGlobalSettings: () => ({ includeTestnet: false })
  };
}

function fakeProtocolSpend(): ProtocolSpendService & { prepare: ReturnType<typeof vi.fn> } {
  return {
    prepare: vi.fn(async (input) => {
      const totalInput = input.inputs.reduce((sum: number, u: { value: number }) => sum + u.value, 0);
      const totalOutput = input.outputs.reduce((sum: number, o: { value: number }) => sum + o.value, 0);
      const requiredFee = 100;
      if (totalInput < totalOutput + requiredFee) {
        throw new Error(`Protocol spend failed: insufficient inputs (${totalInput}) for outputs (${totalOutput}) and fee (${requiredFee})`);
      }
      const changeSatoshis = totalInput - totalOutput - requiredFee;
      const preview: ProtocolSpendPreview = {
        ownerPublicKeyHex: input.ownerPublicKeyHex,
        network: input.network,
        inputs: input.inputs,
        outputs: input.outputs,
        changeAddress: input.changeAddress,
        changeSatoshis,
        estimatedFeeSatoshis: requiredFee,
        serializedSizeBytes: 200,
        txid: "txid-preview",
        rawTxHex: "00"
      };
      return preview;
    }),
    submit: vi.fn(async (preview) => ({
      status: "broadcast-pending-woc" as const,
      txid: preview.txid,
      rawTxHex: preview.rawTxHex,
      canonicalTxid: "canonical-txid",
      txidIntegrity: "exact" as const
    }))
  };
}

function fakeHistoryDb(): OrdinalMintHistoryDb {
  const store = new Map<string, Awaited<ReturnType<OrdinalMintHistoryDb["get"]>>>();
  return {
    async get(id) {
      return store.get(id);
    },
    async put(record) {
      store.set(record.id, record);
    },
    async list() {
      return [...store.values()].filter((value): value is NonNullable<typeof value> => Boolean(value));
    },
    close() {}
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  const buffer = (globalThis as typeof globalThis & {
    Buffer?: { from(value: Uint8Array): { toString(encoding: "base64"): string } };
  }).Buffer;
  if (buffer) {
    return buffer.from(bytes).toString("base64");
  }
  throw new Error("Base64 encoding is not available in this environment");
}

describe("createOrdinalMintService", () => {
  it("persists prepare/submit history in the same record", async () => {
    const historyDb = fakeHistoryDb();
    const service = createOrdinalMintService({
      historyDb,
      p2pkh: fakeP2pkh(),
      protocolSpend: fakeProtocolSpend(),
      getActiveOwnerPublicKeyHex: () => ACTIVE_PK
    });

    const data = new TextEncoder().encode("hello");
    const preview = await service.prepare({
      network: "main",
      contentType: "text/plain",
      data,
      metadata: [{ key: "name", value: "hello.txt" }],
      feeRateSatoshisPerKb: 1000,
      changeAddress: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT"
    });
    const prepared = (await historyDb.list())[0]!;
    expect(prepared.status).toBe("prepared");
    expect(prepared.request.contentType).toBe("text/plain");
    expect(prepared.request.dataBase64).toBe(bytesToBase64(data));
    expect(prepared.request.dataSize).toBe(5);
    expect(prepared.preview.inscriptionId).toBe(preview.inscriptionId);

    const result = await service.submit(preview);
    const submitted = (await historyDb.list())[0]!;
    expect(result.inscriptionId).toBe("canonical-txid_0");
    expect(submitted.status).toBe("broadcast-pending-woc");
    expect(submitted.submit?.inscriptionId).toBe("canonical-txid_0");
    expect(submitted.submit?.spend.canonicalTxid).toBe("canonical-txid");
    expect(submitted.request.contentType).toBe("text/plain");
    expect(submitted.request.dataBase64).toBe(bytesToBase64(data));
  });
});
