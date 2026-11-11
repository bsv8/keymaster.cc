// Trusted wallet construction helpers. Recipient validation belongs to the
// external Connect/address ingress, not to the UTXO allocation component.
export type PaymentOutputRole = "business" | "change";
export function buildPaymentTemplate(plan: {
  businessOutputs: Array<{ scriptHex: string; valueSats: string }>;
  changeScriptHex: string | null; changeAmountSats: string;
}): Array<{vout: number; scriptHex: string; valueSats: string; role: PaymentOutputRole}> {
  const outputs: Array<{vout: number; scriptHex: string; valueSats: string; role: PaymentOutputRole}> = plan.businessOutputs.map((row, index) => ({
    vout: index, scriptHex: row.scriptHex.toLowerCase(), valueSats: row.valueSats, role: "business" as const,
  }));
  if (BigInt(plan.changeAmountSats) > 0n) outputs.push({vout: outputs.length, scriptHex: plan.changeScriptHex!, valueSats: plan.changeAmountSats, role: "change"});
  return outputs;
}
