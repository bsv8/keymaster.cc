import type {
  BsvNetwork,
  ProtocolSpendPreview,
  ProtocolSpendResult,
  ProtocolSpendService
} from "@keymaster/contracts";
import { buildBsv21P2pkhScript } from "./bsv21Script.js";
import type { P2pkhServiceForBsv21, Bsv21ServiceHandle } from "./bsv21Service.js";

export const BSV21_TRANSFER_SERVICE_CAPABILITY = "token-bsv21.transfer.service";

export interface Bsv21TransferRequest {
  tokenId: string;
  recipientAddress: string;
  amount: string | bigint;
  outputs?: Array<{ recipientAddress: string; amount: string | bigint }>;
  network: BsvNetwork;
  feeRateSatoshisPerKb: number;
  changeAddress?: string;
}

export interface Bsv21TransferPreview {
  tokenId: string;
  spend: ProtocolSpendPreview;
  outputs: Array<{ address: string; amt: string }>;
}

export interface Bsv21TransferResult {
  tokenId: string;
  spend: ProtocolSpendResult;
}

export interface Bsv21TransferService {
  prepare(input: Bsv21TransferRequest): Promise<Bsv21TransferPreview>;
  submit(preview: Bsv21TransferPreview): Promise<Bsv21TransferResult>;
}

export function createBsv21TransferService(input: {
  service: Bsv21ServiceHandle;
  p2pkh: P2pkhServiceForBsv21;
  protocolSpend: ProtocolSpendService;
}): Bsv21TransferService {
  async function selectFunding(
    network: BsvNetwork,
    ownerPublicKeyHex: string,
    feeRateSatoshisPerKb: number,
    outputs: Array<{ value: number; scriptHex: string; label?: string }>,
    changeAddress: string,
    prefixInputs: Array<{ txid: string; vout: number; value: number; address: string }> = []
  ): Promise<Array<{ txid: string; vout: number; value: number; address: string }>> {
    if (!input.p2pkh.listUtxos) {
      throw new Error("BSV-21 transfer requires p2pkh listUtxos");
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
          requestingPluginId: "token-bsv21",
          network,
          inputs: [...prefixInputs, ...selected],
          outputs,
          feeRateSatoshisPerKb,
          changeAddress
        });
        return selected;
      } catch {
        // keep adding
      }
    }
    throw new Error("Unable to select funding inputs for BSV-21 transfer");
  }

  return {
    async prepare(req) {
      const allUnspent = await input.service.listActiveKeyUnspentTokens();
      const sourceUtxos = allUnspent.filter((u) => u.tokenId === req.tokenId && u.network === req.network);
      if (sourceUtxos.length === 0) {
        throw new Error("BSV-21 token UTXO not found");
      }

      const ownerResource = (await input.p2pkh.listResources(req.network === "main" ? "bsv" : "bsvtest")).find((r) => r.publicKeyHex);
      if (!ownerResource) {
        throw new Error("BSV-21 transfer requires an active P2PKH resource");
      }

      const requestedOutputs = req.outputs?.length
        ? req.outputs.map((output) => ({
            address: output.recipientAddress,
            amount: normalizeAmount(output.amount)
          }))
        : [{ address: req.recipientAddress, amount: normalizeAmount(req.amount) }];

      const tokenAmount = requestedOutputs.reduce((sum, output) => sum + output.amount, 0n);
      const selected = selectTokenInputs(sourceUtxos, tokenAmount);
      const selectedAmount = selected.reduce((sum, u) => sum + parseAmount(u.amount), 0n);
      const changeAmount = selectedAmount - tokenAmount;

      const outputs = requestedOutputs.map((output) => ({
        address: output.address,
        amt: output.amount.toString()
      }));
      const tokenOutputs = outputs.map((o) => ({
        value: 1,
        scriptHex: bytesToHex(buildBsv21P2pkhScript({
          address: o.address,
          payload: {
            p: "bsv-20",
            op: "transfer",
            amt: o.amt,
            id: req.tokenId
          }
        })),
        label: "bsv21-transfer"
      }));
      const changeOutputs = changeAmount > 0n ? [{
        value: 1,
        scriptHex: bytesToHex(buildBsv21P2pkhScript({
          address: req.changeAddress ?? ownerResource.address,
          payload: {
            p: "bsv-20",
            op: "transfer",
            amt: changeAmount.toString(),
            id: req.tokenId
          }
        })),
        label: "bsv21-change"
      }] : [];

      const sourceInputs = selected.map((u) => ({
        txid: u.current.txid,
        vout: u.current.txIndex,
        value: 1,
        address: u.ownerAddress
      }));
      const funding = await selectFunding(
        req.network,
        ownerResource.publicKeyHex,
        req.feeRateSatoshisPerKb,
        [...tokenOutputs, ...changeOutputs],
        req.changeAddress ?? ownerResource.address,
        sourceInputs
      );
      const spend = await input.protocolSpend.prepare({
        ownerPublicKeyHex: ownerResource.publicKeyHex,
        requestingPluginId: "token-bsv21",
        network: req.network,
        inputs: [...sourceInputs, ...funding],
        outputs: [...tokenOutputs, ...changeOutputs],
        feeRateSatoshisPerKb: req.feeRateSatoshisPerKb,
        changeAddress: req.changeAddress ?? ownerResource.address
      });
      return {
        tokenId: req.tokenId,
        spend,
        outputs
      };
    },
    async submit(preview) {
      const spend = await input.protocolSpend.submit(preview.spend);
      return { tokenId: preview.tokenId, spend };
    }
  };
}

function selectTokenInputs(
  sourceUtxos: Array<{ current: { txid: string; txIndex: number }; amount: string; ownerAddress: string; network: BsvNetwork }>,
  targetAmount: bigint
): Array<{ current: { txid: string; txIndex: number }; amount: string; ownerAddress: string; network: BsvNetwork }> {
  const sorted = [...sourceUtxos].sort((a, b) => parseAmount(a.amount) < parseAmount(b.amount) ? -1 : 1);
  const selected: typeof sorted = [];
  let total = 0n;
  for (const u of sorted) {
    selected.push(u);
    total += parseAmount(u.amount);
    if (total >= targetAmount) return selected;
  }
  throw new Error("Insufficient BSV-21 token amount");
}

function normalizeAmount(amount: string | bigint): bigint {
  if (typeof amount === "bigint") return amount;
  if (!/^[0-9]+$/.test(amount)) throw new Error("Amount must be a non-negative integer string");
  return BigInt(amount);
}

function parseAmount(amount: string): bigint {
  if (!/^[0-9]+$/.test(amount)) throw new Error("BSV-21 amount must be a decimal string");
  return BigInt(amount);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
