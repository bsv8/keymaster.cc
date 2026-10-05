import { defineCapability } from "webloom-framework";
import type { BsvNetwork } from "./vault.js";
export interface P2pkhAssetReader {
  listResources(assetId: "bsv" | "bsvtest"): Promise<Array<{ publicKeyHex: string; address: string; network: BsvNetwork }>>;
  listUtxos(filter?: { assetId?: "bsv" | "bsvtest"; ownerPublicKeyHex?: string }): Promise<Array<{ txid: string; vout: number; value: number; address: string }>>;
  getGlobalSettings(): { includeTestnet: boolean };
}
/** Public address/UTXO observations; no spend or signing operations. */
export const P2PKH_ASSET_READER_CAPABILITY = defineCapability<P2pkhAssetReader>({ kind: "local", id: "p2pkh.asset-reader", version: "1" });
