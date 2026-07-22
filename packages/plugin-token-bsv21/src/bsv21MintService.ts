import type {
  BsvNetwork,
  ProtocolSpendPreview,
  ProtocolSpendResult,
  ProtocolSpendService
} from "@keymaster/contracts";
import { buildBsv21P2pkhScript, type Bsv21Payload } from "./bsv21Script.js";
import type { Bsv21Db } from "./bsv21Db.js";
import type { Bsv21MintHistoryDb, Bsv21MintHistoryRecord } from "./bsv21MintHistoryDb.js";
import type { P2pkhServiceForBsv21 } from "./bsv21Service.js";

export const BSV21_MINT_SERVICE_CAPABILITY = "token-bsv21.mint.service";

export interface Bsv21MintRequest {
  network: BsvNetwork;
  amount: string | bigint;
  sym?: string;
  dec?: number;
  feeRateSatoshisPerKb: number;
  changeAddress?: string;
}

export interface Bsv21MintPreview {
  tokenId: string;
  payload: Bsv21Payload;
  spend: ProtocolSpendPreview;
}

export interface Bsv21MintResult {
  tokenId: string;
  spend: ProtocolSpendResult;
}

export interface Bsv21MintService {
  prepare(input: Bsv21MintRequest): Promise<Bsv21MintPreview>;
  submit(preview: Bsv21MintPreview): Promise<Bsv21MintResult>;
  listHistory(): Promise<Bsv21MintHistoryRecord[]>;
}

export function createBsv21MintService(input: {
  db?: Bsv21Db;
  historyDb?: Bsv21MintHistoryDb;
  p2pkh: P2pkhServiceForBsv21;
  protocolSpend: ProtocolSpendService;
}): Bsv21MintService {
  async function selectFunding(
    network: BsvNetwork,
    ownerPublicKeyHex: string,
    feeRateSatoshisPerKb: number,
    outputs: Array<{ value: number; scriptHex: string; label?: string }>,
    changeAddress: string
  ): Promise<Array<{ txid: string; vout: number; value: number; address: string }>> {
    if (!input.p2pkh.listUtxos) {
      throw new Error("BSV-21 mint requires p2pkh listUtxos");
    }
    const assetId = network === "main" ? "bsv" : "bsvtest";
    const utxos = await input.p2pkh.listUtxos({ assetId, ownerPublicKeyHex });
    const sorted = [...utxos].sort((a, b) => a.value - b.value);
    const selected: Array<{ txid: string; vout: number; value: number; address: string }> = [];
    for (const u of sorted) {
      selected.push(u);
      try {
        await input.protocolSpend.prepare({
          ownerPublicKeyHex,
          network,
          inputs: selected,
          outputs,
          feeRateSatoshisPerKb,
          changeAddress
        });
        return selected;
      } catch {
        // keep adding inputs
      }
    }
    throw new Error("Unable to select funding inputs for BSV-21 mint");
  }

  async function persistDraft(request: Bsv21MintRequest, payload: Bsv21Payload, spend: ProtocolSpendPreview, tokenId: string): Promise<void> {
    if (!input.historyDb) return;
    const now = new Date().toISOString();
    await input.historyDb.put({
      id: spend.txid,
      createdAt: now,
      updatedAt: now,
      status: "prepared",
      request: {
        network: request.network,
        amount: typeof request.amount === "bigint" ? request.amount.toString() : request.amount,
        sym: request.sym,
        dec: request.dec,
        feeRateSatoshisPerKb: request.feeRateSatoshisPerKb,
        changeAddress: request.changeAddress,
        ownerPublicKeyHex: spend.ownerPublicKeyHex
      },
      payload,
      preview: {
        tokenId,
        spend
      }
    });
  }

  async function persistFinal(preview: Bsv21MintPreview, result: ProtocolSpendResult, finalTokenId: string): Promise<void> {
    if (!input.historyDb) return;
    const now = new Date().toISOString();
    const existing = await input.historyDb.get(preview.spend.txid).catch(() => undefined);
    if (existing) {
      await input.historyDb.put({
        ...existing,
        updatedAt: now,
        status: result.status,
        submit: {
          tokenId: finalTokenId,
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
        amount: preview.payload.amt,
        sym: preview.payload.sym,
        dec: preview.payload.dec,
        feeRateSatoshisPerKb: preview.spend.estimatedFeeSatoshis,
        changeAddress: preview.spend.changeAddress,
        ownerPublicKeyHex: preview.spend.ownerPublicKeyHex
      },
      payload: preview.payload,
      preview: {
        tokenId: preview.tokenId,
        spend: preview.spend
      },
      submit: {
        tokenId: finalTokenId,
        spend: result,
        submittedAt: now
      }
    });
  }

  return {
    async prepare(req) {
      const amount = normalizeTokenAmount(req.amount);
      const dec = normalizeDecimals(req.dec);
      const sym = normalizeSymbol(req.sym);
      const payload: Bsv21Payload = {
        p: "bsv-20",
        op: "deploy+mint",
        amt: amount.toString(),
        ...(sym ? { sym } : {}),
        ...(typeof dec === "number" ? { dec } : {})
      };
      const resources = await input.p2pkh.listResources(req.network === "main" ? "bsv" : "bsvtest");
      const resource = resources[0];
      if (!resource) {
        throw new Error("BSV-21 mint requires an active P2PKH resource");
      }
      const changeAddress = req.changeAddress ?? resource.address;
      const outputScript = buildBsv21P2pkhScript({
        address: changeAddress,
        payload
      });
      const outputScriptHex = bytesToHex(outputScript);
      const funding = await selectFunding(req.network, resource.publicKeyHex, req.feeRateSatoshisPerKb, [{ value: 1, scriptHex: outputScriptHex, label: "bsv21-mint" }], changeAddress);
      const spend = await input.protocolSpend.prepare({
        ownerPublicKeyHex: resource.publicKeyHex,
        network: req.network,
        inputs: funding,
        outputs: [{ value: 1, scriptHex: outputScriptHex, label: "bsv21-mint" }],
        feeRateSatoshisPerKb: req.feeRateSatoshisPerKb,
        changeAddress
      });
      await persistDraft(req, payload, spend, `${spend.txid}_0`);
      return {
        tokenId: `${spend.txid}_0`,
        payload,
        spend
      };
    },
    async submit(preview) {
      const spend = await input.protocolSpend.submit(preview.spend);
      const effectiveTxid = spend.canonicalTxid ?? spend.txid;
      await persistFinal(preview, spend, `${effectiveTxid}_0`);
      return { tokenId: `${effectiveTxid}_0`, spend };
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

function normalizeTokenAmount(amount: string | bigint): bigint {
  const value = typeof amount === "bigint" ? amount : parseBigint(amount, "Amount");
  if (value < 1n || value > 18_446_744_073_709_551_615n) {
    throw new Error("Amount must be within uint64 range");
  }
  return value;
}

function normalizeDecimals(dec?: number): number | undefined {
  if (dec === undefined) return undefined;
  if (!Number.isInteger(dec) || dec < 0 || dec > 18) {
    throw new Error("Decimals must be an integer between 0 and 18");
  }
  return dec;
}

function normalizeSymbol(sym?: string): string | undefined {
  if (sym === undefined) return undefined;
  const value = sym.trim();
  if (!value) throw new Error("Symbol must not be empty");
  if (value.length > 32) throw new Error("Symbol is too long");
  return value;
}

function parseBigint(value: string, label: string): bigint {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${label} must be a non-negative integer string`);
  }
  return BigInt(value);
}
