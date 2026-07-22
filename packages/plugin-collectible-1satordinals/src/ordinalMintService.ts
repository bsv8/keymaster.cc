import type {
  BsvNetwork,
  ProtocolSpendPreview,
  ProtocolSpendResult,
  ProtocolSpendService
} from "@keymaster/contracts";
import { buildOrdinalP2pkhScript, type OrdinalEnvelopeEntry } from "./ordinalScript.js";
import type { P2pkhServiceFor1Sat } from "./ordinalsService.js";
import type { OrdinalMintHistoryDb, OrdinalMintHistoryRecord } from "./ordinalMintHistoryDb.js";

export const ORDINAL_MINT_SERVICE_CAPABILITY = "collectible-1satordinals.mint.service";

export interface OrdinalMintRequest {
  ownerPublicKeyHex?: string;
  network: BsvNetwork;
  contentType: string;
  data: Uint8Array;
  metadata?: OrdinalEnvelopeEntry[];
  feeRateSatoshisPerKb: number;
  changeAddress?: string;
}

export interface OrdinalMintPreview {
  outputScriptHex: string;
  spend: ProtocolSpendPreview;
  inscriptionId: string;
}

export interface OrdinalMintResult {
  spend: ProtocolSpendResult;
  inscriptionId: string;
}

export interface OrdinalMintService {
  prepare(input: OrdinalMintRequest): Promise<OrdinalMintPreview>;
  submit(preview: OrdinalMintPreview): Promise<OrdinalMintResult>;
  listHistory(): Promise<OrdinalMintHistoryRecord[]>;
}

export function createOrdinalMintService(input: {
  p2pkh: P2pkhServiceFor1Sat;
  protocolSpend: ProtocolSpendService;
  getActiveOwnerPublicKeyHex: () => string | undefined;
  historyDb?: OrdinalMintHistoryDb;
}): OrdinalMintService {
  async function selectFunding(network: BsvNetwork, ownerPublicKeyHex: string, amount: number, feeRateSatoshisPerKb: number): Promise<Array<{ txid: string; vout: number; value: number; address: string }>> {
    const assetId = network === "main" ? "bsv" : "bsvtest";
    const utxos = await input.p2pkh.listUtxos({ assetId, ownerPublicKeyHex });
    const sorted = [...utxos].sort((a, b) => a.value - b.value);
    const selected: Array<{ txid: string; vout: number; value: number; address: string }> = [];
    let total = 0;
    for (const u of sorted) {
      selected.push(u);
      total += u.value;
      try {
        await input.protocolSpend.prepare({
          ownerPublicKeyHex,
          network,
          inputs: selected,
          outputs: [{ value: 1, scriptHex: "6a" }],
          feeRateSatoshisPerKb,
          changeAddress: selected[0]?.address
        });
        if (total >= amount) return selected;
      } catch {
        // keep adding inputs
      }
    }
    throw new Error("Unable to select funding inputs for ordinal mint");
  }

  async function persistDraft(request: OrdinalMintRequest, preview: OrdinalMintPreview, ownerPublicKeyHex: string): Promise<void> {
    if (!input.historyDb) return;
    const now = new Date().toISOString();
    await input.historyDb.put({
      id: preview.spend.txid,
      createdAt: now,
      updatedAt: now,
      status: "prepared",
      request: {
        network: request.network,
        contentType: request.contentType,
        dataBase64: bytesToBase64(request.data),
        dataSize: request.data.byteLength,
        metadata: request.metadata,
        feeRateSatoshisPerKb: request.feeRateSatoshisPerKb,
        changeAddress: request.changeAddress,
        ownerPublicKeyHex
      },
      preview: {
        inscriptionId: preview.inscriptionId,
        outputScriptHex: preview.outputScriptHex,
        spend: preview.spend
      }
    });
  }

  async function persistFinal(preview: OrdinalMintPreview, result: ProtocolSpendResult, finalInscriptionId: string): Promise<void> {
    if (!input.historyDb) return;
    const now = new Date().toISOString();
    const existing = await input.historyDb.get(preview.spend.txid).catch(() => undefined);
    if (existing) {
      await input.historyDb.put({
        ...existing,
        updatedAt: now,
        status: result.status,
        preview: {
          inscriptionId: preview.inscriptionId,
          outputScriptHex: preview.outputScriptHex,
          spend: preview.spend
        },
        submit: {
          inscriptionId: finalInscriptionId,
          spend: result,
          submittedAt: now
        }
      });
      return;
    }
    await input.historyDb.put({
      id: preview.spend.txid,
      createdAt: now,
      updatedAt: now,
      status: result.status,
      request: {
        network: preview.spend.network,
        contentType: "application/octet-stream",
        dataBase64: "",
        dataSize: 0,
        feeRateSatoshisPerKb: preview.spend.estimatedFeeSatoshis,
        changeAddress: preview.spend.changeAddress,
        ownerPublicKeyHex: preview.spend.ownerPublicKeyHex
      },
      preview: {
        inscriptionId: preview.inscriptionId,
        outputScriptHex: preview.outputScriptHex,
        spend: preview.spend
      },
      submit: {
        inscriptionId: finalInscriptionId,
        spend: result,
        submittedAt: now
      }
    });
  }

  return {
    async prepare(req) {
      const ownerPublicKeyHex = req.ownerPublicKeyHex ?? input.getActiveOwnerPublicKeyHex();
      if (!ownerPublicKeyHex) {
        throw new Error("Ordinal mint requires an active owner");
      }
      validateContentType(req.contentType);
      validateData(req.data);
      const funding = await selectFunding(req.network, ownerPublicKeyHex, 1, req.feeRateSatoshisPerKb);
      const changeAddress = req.changeAddress ?? funding[0]?.address;
      const outputScript = buildOrdinalP2pkhScript({
        address: changeAddress ?? funding[0]!.address,
        contentType: req.contentType,
        data: req.data,
        metadata: req.metadata
      });
      const spend = await input.protocolSpend.prepare({
        ownerPublicKeyHex,
        network: req.network,
        inputs: funding,
        outputs: [{ value: 1, scriptHex: bytesToHex(outputScript), label: "ordinal" }],
        feeRateSatoshisPerKb: req.feeRateSatoshisPerKb,
        changeAddress
      });
      const preview = {
        outputScriptHex: bytesToHex(outputScript),
        spend,
        inscriptionId: `${spend.txid}_0`
      };
      await persistDraft(req, preview, ownerPublicKeyHex);
      return preview;
    },
    async submit(preview) {
      const spend = await input.protocolSpend.submit(preview.spend);
      const finalInscriptionId = `${spend.canonicalTxid ?? spend.txid}_0`;
      await persistFinal(preview, spend, finalInscriptionId);
      return { spend, inscriptionId: finalInscriptionId };
    },
    async listHistory() {
      if (!input.historyDb) return [];
      return input.historyDb.list();
    }
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const ALLOWED_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "text/plain",
  "application/json"
]);

function validateContentType(contentType: string): void {
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new Error(`Unsupported ordinal content type: ${contentType}`);
  }
}

function validateData(data: Uint8Array): void {
  if (data.byteLength === 0) {
    throw new Error("Ordinal mint data must not be empty");
  }
  if (data.byteLength > 1_048_576) {
    throw new Error("Ordinal mint data must be <= 1 MiB");
  }
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
