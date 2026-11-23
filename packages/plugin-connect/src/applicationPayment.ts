import { Hash, LockingScript, P2PKH, Transaction, TransactionSignature, UnlockingScript } from "@bsv/sdk";
import { applicationPublicKey } from "keymaster-connect/signing";
import { assertP2pkhAddressForAsset } from "keymaster-connect/server";
import type { ApplicationPaymentParams } from "keymaster-connect/protocol";
import type { NetworkIdentity, WocService, WocRequestOptions } from "@keymaster/contracts";

export async function planApplicationPayment(params: ApplicationPaymentParams, owner: NetworkIdentity, woc: WocService, opts: WocRequestOptions) {
  assertP2pkhAddressForAsset(params.address, owner.bsvNetwork === "test" ? "bsv-testnet" : "bsv-mainnet");
  const tx = Transaction.fromHex(params.rawTxHex);
  if (tx.toHex() !== params.rawTxHex || tx.inputs.length !== params.inputs.length || tx.outputs.length !== 1) {
    throw new Error("Invalid recovery transaction layout");
  }
  const keys = new Set<string>();
  for (const [i, input] of tx.inputs.entries()) {
    const outpoint = params.inputs[i]!;
    const key = `${outpoint.txid}:${outpoint.vout}`;
    if (input.sourceTXID !== outpoint.txid || input.sourceOutputIndex !== outpoint.vout || input.unlockingScript?.toHex() || keys.has(key)) {
      throw new Error("Recovery inputs do not match the requested outpoints");
    }
    keys.add(key);
  }
  const output = tx.outputs[0]!;
  if (!Number.isSafeInteger(output.satoshis) || output.satoshis! <= 0 || output.lockingScript.toHex() !== new P2PKH().lock(params.address).toHex()) {
    throw new Error("Recovery destination or amount is invalid");
  }
  const sourceScriptHex = "21" + applicationPublicKey(params.purpose, owner.publicKeyHex) + "ac";
  const subscript = LockingScript.fromHex(sourceScriptHex);
  const { outputs: unspent } = await woc.listScriptUnspent(sourceScriptHex, opts);
  const values = new Map(unspent.map(row => [`${row.txid}:${row.vout}`, row.satoshis]));
  const sourceAmounts: number[] = [];
  const rawTransactions = new Map<string, Transaction>();
  for (const outpoint of params.inputs) {
    let source = rawTransactions.get(outpoint.txid);
    if (!source) {
      source = Transaction.fromHex(await woc.getRawTransaction(outpoint.txid, opts));
      if (source.id("hex") !== outpoint.txid) throw new Error("Recovery input transaction identifier mismatch");
      rawTransactions.set(outpoint.txid, source);
    }
    const prevout = source.outputs[outpoint.vout];
    if (prevout?.lockingScript.toHex() !== sourceScriptHex || !Number.isSafeInteger(prevout.satoshis) || prevout.satoshis! <= 0 ||
        values.get(`${outpoint.txid}:${outpoint.vout}`) !== prevout.satoshis) {
      throw new Error("Recovery input is not an available application-space output");
    }
    sourceAmounts.push(prevout.satoshis!);
  }
  const total = sourceAmounts.reduce((sum, amount) => sum + BigInt(amount), 0n);
  if (total - BigInt(output.satoshis!) !== BigInt(params.feeSatoshis)) throw new Error("Recovery fee does not match the transaction");

  const scope = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID;
  const digests = tx.inputs.map((input, inputIndex) => {
    const preimage = TransactionSignature.format({
      sourceTXID: input.sourceTXID!, sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: sourceAmounts[inputIndex]!, otherInputs: tx.inputs.filter((_, i) => i !== inputIndex),
      subscript, inputSequence: input.sequence!, transactionVersion: tx.version,
      outputs: tx.outputs, lockTime: tx.lockTime, inputIndex, scope,
    });
    return Uint8Array.from(Hash.hash256(preimage)).buffer;
  });
  return {
    amount: output.satoshis!,
    digests,
    finish(signatures: ArrayBuffer[]) {
      if (signatures.length !== tx.inputs.length) throw new Error("Recovery signature count mismatch");
      const inputs = tx.inputs.map((input, index) => {
        const unlockingScript = new UnlockingScript();
        unlockingScript.writeBin([...new Uint8Array(signatures[index]!), scope]);
        return { ...input, unlockingScript };
      });
      const signed = new Transaction(tx.version, inputs, tx.outputs, tx.lockTime);
      return { rawTxHex: signed.toHex() };
    },
  };
}
