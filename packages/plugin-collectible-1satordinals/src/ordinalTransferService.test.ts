import { describe, expect, it, vi } from "vitest";
import type { ProtocolSpendPreview, ProtocolSpendService } from "@keymaster/contracts";
import { buildOrdinalP2pkhScript, replaceOrdinalP2pkhRecipient } from "./ordinalScript.js";
import { createOrdinalTransferService } from "./ordinalTransferService.js";
import type { OrdinalsServiceHandle } from "./ordinalsService.js";
import type { P2pkhServiceFor1Sat } from "./ordinalsService.js";

const ACTIVE_PK = "pk-active";
const SOURCE_ADDRESS = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
const RECIPIENT_ADDRESS = "1dice8EMZmqKvrGE4Qc9bUFf9PX3xaYDp";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fakeP2pkh(): P2pkhServiceFor1Sat {
  return {
    listUtxos: async () => [
      { txid: "fund1", vout: 0, value: 5000, address: SOURCE_ADDRESS }
    ],
    getGlobalSettings: () => ({ includeTestnet: false })
  };
}

function makeSourceScript(): Uint8Array {
  return buildOrdinalP2pkhScript({
    address: SOURCE_ADDRESS,
    contentType: "text/plain",
    data: new TextEncoder().encode("hello"),
    metadata: [
      { key: "owner", value: "owner" },
      { key: "unknown-field", value: "kept" }
    ]
  });
}

function fakeOrdinals(options?: {
  sourceScript?: Uint8Array;
  throwOnScript?: Error;
  invalidHit?: boolean;
}): OrdinalsServiceHandle {
  const sourceScript = options?.sourceScript ?? makeSourceScript();
  return {
    listActiveKeyCollectibles: async () => [],
    getOutpoint: async () => ({
      outpoint: "tx0:0",
      network: "main",
      address: SOURCE_ADDRESS,
      inscription: {
        inscriptionId: "insc-tx0_0",
        outpoint: "tx0_0",
        contentType: "text/plain",
        origin: "hello",
        preview: "hello",
        owner: "owner"
      }
    }),
    getOutpointContent: async () => null,
    getTransactionOutputScript: async () => {
      if (options?.throwOnScript) {
        throw options.throwOnScript;
      }
      if (options?.invalidHit) {
        return new Uint8Array([0x6a]);
      }
      return sourceScript;
    },
    sync: async () => {},
    onChange: () => () => {},
    dispose: () => {}
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
      const preview: ProtocolSpendPreview = {
        ownerPublicKeyHex: input.ownerPublicKeyHex,
        network: input.network,
        inputs: input.inputs,
        outputs: input.outputs,
        changeAddress: input.changeAddress,
        changeSatoshis: totalInput - totalOutput - requiredFee,
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
      rawTxHex: preview.rawTxHex
    }))
  };
}

describe("createOrdinalTransferService", () => {
  it("replaces only the P2PKH recipient prefix and preserves the ordinal envelope suffix", async () => {
    const sourceScript = makeSourceScript();
    const protocolSpend = fakeProtocolSpend();
    const service = createOrdinalTransferService({
      ordinals: fakeOrdinals({ sourceScript }),
      p2pkh: fakeP2pkh(),
      protocolSpend,
      getActiveOwnerPublicKeyHex: () => ACTIVE_PK
    });

    const preview = await service.prepare({
      collectibleId: "tx0:0",
      recipientAddress: RECIPIENT_ADDRESS,
      network: "main",
      feeRateSatoshisPerKb: 1000
    });

    const expected = replaceOrdinalP2pkhRecipient(sourceScript, RECIPIENT_ADDRESS);
    expect(preview.outputScriptHex).toBe(bytesToHex(expected));
    expect(preview.collectible.outpoint).toBe("tx0:0");
    expect(bytesToHex(expected.slice(25))).toBe(bytesToHex(sourceScript.slice(25)));
    const lastCall = protocolSpend.prepare.mock.calls[protocolSpend.prepare.mock.calls.length - 1];
    expect(lastCall?.[0].inputs[0]).toMatchObject({ txid: "tx0", vout: 0 });
  });

  it("rejects when the source script cannot be read", async () => {
    const service = createOrdinalTransferService({
      ordinals: fakeOrdinals({ throwOnScript: new Error("read failed") }),
      p2pkh: fakeP2pkh(),
      protocolSpend: fakeProtocolSpend(),
      getActiveOwnerPublicKeyHex: () => ACTIVE_PK
    });

    await expect(service.prepare({
      collectibleId: "tx0:0",
      recipientAddress: RECIPIENT_ADDRESS,
      network: "main",
      feeRateSatoshisPerKb: 1000
    })).rejects.toThrow(/read failed/);
  });

  it("rejects non-P2PKH or envelope-less source scripts", async () => {
    const baseService = () => createOrdinalTransferService({
      ordinals: fakeOrdinals({ invalidHit: true }),
      p2pkh: fakeP2pkh(),
      protocolSpend: fakeProtocolSpend(),
      getActiveOwnerPublicKeyHex: () => ACTIVE_PK
    });

    await expect(baseService().prepare({
      collectibleId: "tx0:0",
      recipientAddress: RECIPIENT_ADDRESS,
      network: "main",
      feeRateSatoshisPerKb: 1000
    })).rejects.toThrow(/P2PKH source script/);

    const noEnvelope = buildOrdinalP2pkhScript({
      address: SOURCE_ADDRESS,
      contentType: "text/plain",
      data: new TextEncoder().encode("hello")
    }).slice(0, 25);
    await expect(createOrdinalTransferService({
      ordinals: fakeOrdinals({ sourceScript: noEnvelope }),
      p2pkh: fakeP2pkh(),
      protocolSpend: fakeProtocolSpend(),
      getActiveOwnerPublicKeyHex: () => ACTIVE_PK
    }).prepare({
      collectibleId: "tx0:0",
      recipientAddress: RECIPIENT_ADDRESS,
      network: "main",
      feeRateSatoshisPerKb: 1000
    })).rejects.toThrow(/missing ord envelope/);
  });
});
