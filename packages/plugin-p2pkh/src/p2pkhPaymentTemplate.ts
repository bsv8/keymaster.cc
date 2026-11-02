// Trusted wallet construction helpers. Recipient validation belongs to the
// external Connect/address ingress, not to the UTXO allocation component.
import { pubKeyHash160Hex } from "./p2pkhSigner.js";
export type PaymentType = "p2pkh" | "p2pk";
export type PaymentOutputRole = "business" | "change";
export function p2pkScriptFromPublicKey(publicKeyHex: string): string { return `21${publicKeyHex.toLowerCase()}ac`; }
export function publisherMatchesPaymentScript(scriptHex: string, publicKeyHex: string): boolean {
 const script = scriptHex.toLowerCase();
 return script === p2pkScriptFromPublicKey(publicKeyHex) || script === `76a914${pubKeyHash160Hex(publicKeyHex)}88ac`;
}
export function buildPaymentTemplate(plan: {
 paymentType: PaymentType; businessAmountSats: string; businessScriptHex: string;
 changeScriptHex: string | null; changeAmountSats: string;
}): Array<{vout: number; scriptHex: string; valueSats: string; role: PaymentOutputRole}> {
 const outputs: Array<{vout: number; scriptHex: string; valueSats: string; role: PaymentOutputRole}> = [
  {vout: 0, scriptHex: plan.businessScriptHex, valueSats: plan.businessAmountSats, role: "business"},
 ];
 if (BigInt(plan.changeAmountSats) > 0n) outputs.push({vout: 1, scriptHex: plan.changeScriptHex!, valueSats: plan.changeAmountSats, role: "change"});
 return outputs;
}
