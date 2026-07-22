import type {
  BsvNetwork,
  ProtocolSpendPreview,
  ProtocolSpendResult,
  ProtocolSpendService
} from "@keymaster/contracts";
import { replaceOrdinalP2pkhRecipient } from "./ordinalScript.js";
import type { OrdinalsOutpointHit, OrdinalsServiceHandle, P2pkhServiceFor1Sat } from "./ordinalsService.js";

export const ORDINAL_TRANSFER_SERVICE_CAPABILITY = "collectible-1satordinals.transfer.service";

export interface OrdinalTransferRequest {
  collectibleId: string;
  recipientAddress: string;
  network: BsvNetwork;
  feeRateSatoshisPerKb: number;
}

export interface OrdinalTransferPreview {
  collectible: OrdinalsOutpointHit;
  spend: ProtocolSpendPreview;
  outputScriptHex: string;
}

export interface OrdinalTransferResult {
  collectibleId: string;
  spend: ProtocolSpendResult;
  observedReference: string;
}

export interface OrdinalTransferService {
  prepare(input: OrdinalTransferRequest): Promise<OrdinalTransferPreview>;
  submit(preview: OrdinalTransferPreview): Promise<OrdinalTransferResult>;
}

export function createOrdinalTransferService(input: {
  ordinals: OrdinalsServiceHandle;
  p2pkh: P2pkhServiceFor1Sat;
  protocolSpend: ProtocolSpendService;
  getActiveOwnerPublicKeyHex: () => string | undefined;
}): OrdinalTransferService {
  async function selectFunding(
    network: BsvNetwork,
    ownerPublicKeyHex: string,
    feeRateSatoshisPerKb: number,
    prefixInputs: Array<{ txid: string; vout: number; value: number; address: string }> = []
  ): Promise<Array<{ txid: string; vout: number; value: number; address: string }>> {
    const assetId = network === "main" ? "bsv" : "bsvtest";
    const utxos = await input.p2pkh.listUtxos({ assetId, ownerPublicKeyHex });
    const sorted = [...utxos].sort((a, b) => a.value - b.value);
    const selected: Array<{ txid: string; vout: number; value: number; address: string }> = [];
    for (const u of sorted) {
      selected.push(u);
      try {
        await input.protocolSpend.prepare({
          ownerPublicKeyHex,
          requestingPluginId: "collectible-1satordinals",
          network,
          inputs: [...prefixInputs, ...selected],
          outputs: [{ value: 1, scriptHex: "6a" }],
          feeRateSatoshisPerKb,
          changeAddress: selected[0]?.address
        });
        return selected;
      } catch {
        // add more inputs
      }
    }
    throw new Error("Unable to select funding inputs for ordinal transfer");
  }

  return {
    async prepare(req) {
      const collectible = await input.ordinals.getOutpoint(req.collectibleId);
      if (!collectible) {
        throw new Error("Ordinal collectible not found");
      }
      const [sourceTxid, sourceVoutStr] = collectible.outpoint.split(":");
      const sourceVout = Number(sourceVoutStr);
      if (!sourceTxid || !Number.isFinite(sourceVout)) {
        throw new Error("Ordinal collectible outpoint is invalid");
      }
      const ownerPublicKeyHex = input.getActiveOwnerPublicKeyHex();
      if (!ownerPublicKeyHex) {
        throw new Error("Ordinal collectible owner is not available");
      }
      const sourceScript = await input.ordinals.getTransactionOutputScript(collectible.outpoint);
      const outputScript = replaceOrdinalP2pkhRecipient(sourceScript, req.recipientAddress);
      const sourceInput = {
        txid: sourceTxid,
        vout: sourceVout,
        value: 1,
        address: collectible.address
      };
      const funding = await selectFunding(req.network, ownerPublicKeyHex, req.feeRateSatoshisPerKb, [sourceInput]);
      const spend = await input.protocolSpend.prepare({
        ownerPublicKeyHex,
        requestingPluginId: "collectible-1satordinals",
        network: req.network,
        inputs: [sourceInput, ...funding],
        outputs: [{ value: 1, scriptHex: bytesToHex(outputScript), label: "ordinal-transfer" }],
        feeRateSatoshisPerKb: req.feeRateSatoshisPerKb,
        changeAddress: funding[0]?.address
      });
      return {
        collectible,
        spend,
        outputScriptHex: bytesToHex(outputScript)
      };
    },
    async submit(preview) {
      const spend = await input.protocolSpend.submit(preview.spend);
      return {
        collectibleId: preview.collectible.outpoint,
        spend,
        observedReference: preview.collectible.outpoint
      };
    }
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
