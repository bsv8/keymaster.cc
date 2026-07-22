import { describe, expect, it, vi } from "vitest";
import type { KeyspaceService, ProtocolSpendPreview, ProtocolSpendService } from "@keymaster/contracts";
import type { Bsv21MintHistoryDb } from "./bsv21MintHistoryDb.js";
import { createBsv21MintService } from "./bsv21MintService.js";
import type { P2pkhServiceForBsv21 } from "./bsv21Service.js";

const ACTIVE_PK = "pk-active";

function fakeKeyspace(): KeyspaceService {
  return { active: () => ({ activePublicKeyHex: ACTIVE_PK }) } as unknown as KeyspaceService;
}

function fakeP2pkh(): P2pkhServiceForBsv21 {
  return {
    listResources: async () => [{ publicKeyHex: ACTIVE_PK, address: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT", network: "main" }],
    getGlobalSettings: () => ({ includeTestnet: false }),
    listUtxos: async () => [
      { txid: "small", vout: 0, value: 103, address: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT" },
      { txid: "large", vout: 1, value: 200, address: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT" }
    ]
  };
}

function fakeProtocolSpend(): ProtocolSpendService & { prepare: ReturnType<typeof vi.fn> } {
  return {
    prepare: vi.fn(async (input) => {
      const totalInput = input.inputs.reduce((sum: number, u: { value: number }) => sum + u.value, 0);
      const totalOutput = input.outputs.reduce((sum: number, o: { value: number }) => sum + o.value, 0);
      const requiredFee = 100 + Math.ceil((input.outputs[0]?.scriptHex.length ?? 0) / 2);
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
      status: "broadcast" as const,
      txid: preview.txid,
      rawTxHex: preview.rawTxHex,
      canonicalTxid: "canonical-txid",
      txidIntegrity: "exact" as const
    }))
  };
}

function fakeHistoryDb(): Bsv21MintHistoryDb {
  const store = new Map<string, unknown>();
  return {
    async get(id) {
      return store.get(id) as never;
    },
    async put(record) {
      store.set(record.id, record);
    },
    async list() {
      return [...store.values()] as never;
    },
    async findByTokenId(tokenId) {
      for (const record of store.values()) {
        const typed = record as { preview?: { tokenId?: string }; submit?: { tokenId?: string } };
        if (typed.preview?.tokenId === tokenId || typed.submit?.tokenId === tokenId) {
          return record as never;
        }
      }
      return undefined;
    },
    close() {}
  };
}

describe("createBsv21MintService", () => {
  it("uses the real mint output script when selecting funding inputs", async () => {
    const service = createBsv21MintService({
      p2pkh: fakeP2pkh(),
      protocolSpend: fakeProtocolSpend()
    });

    const preview = await service.prepare({
      network: "main",
      amount: "1",
      sym: "TOK",
      dec: 0,
      feeRateSatoshisPerKb: 1000
    });

    expect(preview.spend.inputs.map((u) => u.value)).toEqual([103, 200]);
  });

  it("persists prepare/submit history in the same record", async () => {
    const historyDb = fakeHistoryDb();
    const service = createBsv21MintService({
      historyDb,
      p2pkh: fakeP2pkh(),
      protocolSpend: fakeProtocolSpend()
    });

    const preview = await service.prepare({
      network: "main",
      amount: "1",
      sym: "TOK",
      dec: 0,
      feeRateSatoshisPerKb: 1000,
      changeAddress: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT"
    });
    const prepared = (await historyDb.list())[0]!;
    expect(prepared.status).toBe("prepared");
    expect(prepared.request.amount).toBe("1");
    expect(prepared.request.sym).toBe("TOK");
    expect(prepared.preview.tokenId).toBe(preview.tokenId);

    const result = await service.submit(preview);
    const submitted = (await historyDb.list())[0]!;
    expect(result.tokenId).toBe("canonical-txid_0");
    expect(submitted.status).toBe("broadcast");
    expect(submitted.submit?.tokenId).toBe("canonical-txid_0");
    expect(submitted.submit?.spend.canonicalTxid).toBe("canonical-txid");
    expect(submitted.request.amount).toBe("1");
  });
});
