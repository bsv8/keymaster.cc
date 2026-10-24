import { hex, unhex, parseTransaction, serializeTransaction, inspectStandard, inspectFeePool, standardUnlockKind } from "@vaultlink/sdk";
import type { WalletPaymentCommand } from "./wallet-payments.js";

/** Protocol spend 的最终整笔签名口；选币/费用求解不调用它。
 * 渠道按实际调用插件注册。费用池锁定用专用 Profile，不能重复计成普通付款。
 */
export async function signProtocolPayment(input: {
  rawTxHex: string; prevTransactionHexes: string[]; publicKeyHex: string;
  network: "main" | "test"; pluginId: string;
  requestPayment(command: Exclude<WalletPaymentCommand, {action: "list" | "pending" | "spend-notices" | "notice-dismiss" | "backend" | "signing-list"} | {action:"signing-configure"} | {action: "configure"} | {action: "answer"}>): Promise<unknown>;
}): Promise<string> {
  if (!/^[a-z][a-z0-9.-]{0,63}$/.test(input.pluginId)) throw Error("invalid-payment-owner");
  const raw = unhex(input.rawTxHex), previous = input.prevTransactionHexes.map(unhex), pub = unhex(input.publicKeyHex), tx = parseTransaction(raw);
  // BitFS FundingTx 的固定脚本；精确检查由 inspectFeePool 再完成，不按业务标签猜金额。
  const pool = tx.outputs[0]?.script;
  const isPool = pool?.length === 105 && pool[0] === 0x52 && pool[103] === 0x53 && pool[104] === 0xae;
  const review = isPool ? await inspectFeePool(raw, previous, pub, "bitfs", "fund") : await inspectStandard(raw, previous, pub);
  const paymentType = isPool ? "feepool.bitfs" : "bsv.standard", channelId = `${input.pluginId}.${paymentType}.${input.network}`;
  await input.requestPayment({action: "register", id: channelId, owner: input.pluginId, kind: "plugin", network: input.network, paymentType});
  const common = {channelId, paymentId: crypto.randomUUID(), sessionId: null, rawTxHex: input.rawTxHex, prevTransactionHexes: input.prevTransactionHexes};
  const result = await input.requestPayment(isPool ? {action: "sign-feepool", family: "bitfs", stage: "fund", ...common} : {action: "sign-standard", ...common});
  if (!result || typeof result !== "object" || !("signatures" in result) || !Array.isArray(result.signatures) || result.signatures.length !== tx.inputs.length) throw Error("invalid-wallet-signature");
  for (let i = 0; i < tx.inputs.length; i++) {
    const s = result.signatures[i];
    if (typeof s !== "string") throw Error("invalid-wallet-signature");
    const sig = unhex(s);
    if (sig.length < 9 || sig.length > 73 || sig.at(-1) !== 0x41) throw Error("invalid-wallet-signature");
    const kind = standardUnlockKind(parseTransaction(previous[i]!).outputs[tx.inputs[i]!.vout]!.script, pub);
    if (!kind) throw Error("unsupported-input");
    tx.inputs[i]!.script = kind === "p2pkh" ? Uint8Array.from([sig.length, ...sig, 33, ...pub]) : Uint8Array.from([sig.length, ...sig]);
  }
  void review;
  return hex(serializeTransaction(tx));
}
