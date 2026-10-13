// packages/plugin-protocol/src/feepoolSdk.ts
// MultisigPool 适配层（capability 版）。
//
// 设计缘由：
//   - fee pool 不再接收 raw 私钥材料 / PrivateKey 对象；
//   - 整个交易及证据提交钱包核心，由钱包核算渠道额度；
//   - 交易编解码只保留本文件内最小实现，避免把私钥边界扩散到
//     protocol service。
//
// VLP 施工：不得退回盲签摘要，也不得为估算大小反复签名。

import { Hash } from "@bsv/sdk";
import {
  clientVerifyServerSpendSig,
  clientVerifyServerUpdateSig
} from "keymaster-multisig-pool";

/** `FINAL_LOCKTIME`：close_and_recreate 的 close 部分用。 */
export const FINAL_LOCKTIME = 0xffffffff;

/** 适配 tx 输入。 */
export interface FeepoolSdkUtxo {
  txid: string;
  vout: number;
  satoshis: number;
}

export interface FeepoolSdkBaseTxResponse {
  txHex: string;
  txid: string;
  outputIndex: number;
  amount: number;
}

export interface FeepoolSdkDraftTxResponse {
  txHex: string;
}

interface TxInput {
  prevTxid: string;
  prevVout: number;
  scriptSig: Uint8Array;
  sequence: number;
}

interface TxOutput {
  value: number;
  script: Uint8Array;
}

interface UnsignedTx {
  version: number;
  inputs: TxInput[];
  outputs: TxOutput[];
  lockTime: number;
}

const SIGHASH_ALL_FORKID = 0x41;

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "").trim();
  if (clean.length % 2 !== 0) throw new Error("Invalid hex length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += (b ?? 0).toString(16).padStart(2, "0");
  return out;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const len = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(len);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function u32LE(n: number): Uint8Array {
  const out = new Uint8Array(4);
  const view = new DataView(out.buffer);
  view.setUint32(0, n >>> 0, true);
  return out;
}

function u64LE(n: number): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, BigInt(n), true);
  return out;
}

function encodeVarInt(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) return concatBytes(new Uint8Array([0xfd]), u16LE(n));
  return concatBytes(new Uint8Array([0xfe]), u32LE(n));
}

function decodeVarInt(bytes: Uint8Array, offset: number): { value: number; next: number } {
  const tag = bytes[offset];
  if (tag == null) throw new Error("Unexpected EOF");
  if (tag < 0xfd) return { value: tag, next: offset + 1 };
  if (tag === 0xfd) {
    const v = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 2).getUint16(0, true);
    return { value: v, next: offset + 3 };
  }
  if (tag === 0xfe) {
    const v = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4).getUint32(0, true);
    return { value: v, next: offset + 5 };
  }
  throw new Error("VarInt > 32 bits not supported");
}

function u16LE(n: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, n & 0xffff, true);
  return out;
}

function dsha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(Hash.hash256(data));
}

function pubKeyHash160Hex(publicKeyHex: string): string {
  const pub = hexToBytes(publicKeyHex);
  if (pub.length !== 33) throw new Error("Public key must be 33 bytes (compressed)");
  return bytesToHex(new Uint8Array(Hash.hash160(pub)));
}

function p2pkhLockScript(publicKeyHex: string): Uint8Array {
  const h160 = hexToBytes(pubKeyHash160Hex(publicKeyHex));
  return concatBytes(new Uint8Array([0x76, 0xa9, 0x14]), h160, new Uint8Array([0x88, 0xac]));
}

function dualMultisigScript(serverPublicKeyHex: string, clientPublicKeyHex: string): Uint8Array {
  const server = hexToBytes(serverPublicKeyHex);
  const client = hexToBytes(clientPublicKeyHex);
  if (server.length !== 33 || client.length !== 33) {
    throw new Error("Compressed public key must be 33 bytes");
  }
  return concatBytes(
    new Uint8Array([0x52, 0x21]),
    server,
    new Uint8Array([0x21]),
    client,
    new Uint8Array([0x52, 0xae])
  );
}

function fakeDualMultisigUnlockScript(): Uint8Array {
  // 1 opcode + 2 pushed blobs；仅用于 size estimation。
  const fakeSig = new Uint8Array(73);
  return concatBytes(
    new Uint8Array([0x00, 0x49]),
    fakeSig,
    new Uint8Array([0x49]),
    fakeSig
  );
}

function serializeTx(tx: UnsignedTx): Uint8Array {
  const parts: Uint8Array[] = [u32LE(tx.version), encodeVarInt(tx.inputs.length)];
  for (const i of tx.inputs) {
    parts.push(hexToBytes(i.prevTxid).reverse());
    parts.push(u32LE(i.prevVout));
    parts.push(encodeVarInt(i.scriptSig.length));
    parts.push(i.scriptSig);
    parts.push(u32LE(i.sequence));
  }
  parts.push(encodeVarInt(tx.outputs.length));
  for (const o of tx.outputs) {
    parts.push(u64LE(o.value));
    parts.push(encodeVarInt(o.script.length));
    parts.push(o.script);
  }
  parts.push(u32LE(tx.lockTime));
  return concatBytes(...parts);
}

function deserializeTx(bytes: Uint8Array): UnsignedTx {
  let offset = 0;
  const read = (n: number): Uint8Array => {
    const slice = bytes.slice(offset, offset + n);
    if (slice.length !== n) throw new Error("Unexpected EOF");
    offset += n;
    return slice;
  };
  const version = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
  offset += 4;
  const inCount = decodeVarInt(bytes, offset);
  offset = inCount.next;
  const inputs: TxInput[] = [];
  for (let i = 0; i < inCount.value; i++) {
    const prevTxid = bytesToHex(read(32).reverse());
    const prevVout = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
    offset += 4;
    const scriptLen = decodeVarInt(bytes, offset);
    offset = scriptLen.next;
    const scriptSig = read(scriptLen.value);
    const sequence = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
    offset += 4;
    inputs.push({ prevTxid, prevVout, scriptSig, sequence });
  }
  const outCount = decodeVarInt(bytes, offset);
  offset = outCount.next;
  const outputs: TxOutput[] = [];
  for (let i = 0; i < outCount.value; i++) {
    const value = Number(new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0, true));
    offset += 8;
    const scriptLen = decodeVarInt(bytes, offset);
    offset = scriptLen.next;
    const script = read(scriptLen.value);
    outputs.push({ value, script });
  }
  const lockTime = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
  return { version, inputs, outputs, lockTime };
}

/** 从未签名原文取出证据编号；最终真实性仍由钱包按 txid 核验。 */
export function feePoolInputTxids(rawTxHex: string): string[] {
  return deserializeTx(hexToBytes(rawTxHex)).inputs.map(i=>i.prevTxid);
}
/** 接口只能接收整个未签名交易；钱包负责脚本/金额核验及一次额度预占。 */
export type FeePoolTransactionSigner = (rawTxHex: string) => Promise<string[]>;
async function signP2pkhInputs(unsigned: UnsignedTx, signTransaction: FeePoolTransactionSigner, publicKeyHex: string): Promise<string> {
  const signatures=await signTransaction(bytesToHex(serializeTx(unsigned)));
  if(signatures.length!==unsigned.inputs.length)throw new Error('Invalid wallet signature count');
  const pub=hexToBytes(publicKeyHex);
  const inputs=unsigned.inputs.map((input,i)=>{
    const signature=hexToBytes(signatures[i]!);
    if(signature.length<9 || signature[0]!==0x30 || signature.at(-1)!==SIGHASH_ALL_FORKID)throw new Error('Invalid wallet transaction signature');
    return {...input,scriptSig:concatBytes(encodeVarInt(signature.length),signature,Uint8Array.of(pub.length),pub)};
  });
  return bytesToHex(serializeTx({...unsigned,inputs}));
}

function buildUnsignedBaseTx(params: {
  clientUtxos: FeepoolSdkUtxo[];
  clientPublicKeyHex: string;
  serverPublicKeyHex: string;
  feepoolAmount: number;
  changeAmount: number;
}): UnsignedTx {
  const inputs = params.clientUtxos.map((u) => ({
    prevTxid: u.txid,
    prevVout: u.vout,
    scriptSig: new Uint8Array(0),
    sequence: 0xfffffffe
  }));
  return {
    version: 1,
    inputs,
    outputs: [
      { value: params.feepoolAmount, script: dualMultisigScript(params.serverPublicKeyHex, params.clientPublicKeyHex) },
      { value: params.changeAmount, script: p2pkhLockScript(params.clientPublicKeyHex) }
    ],
    lockTime: 0
  };
}

function buildUnsignedSpendTx(params: {
  prevTxId: string;
  totalAmount: number;
  serverAmount: number;
  endHeight: number;
  clientPublicKeyHex: string;
  serverPublicKeyHex: string;
}): UnsignedTx {
  return {
    version: 1,
    inputs: [
      {
        prevTxid: params.prevTxId,
        prevVout: 0,
        scriptSig: new Uint8Array(0),
        sequence: 1
      }
    ],
    outputs: [
      { value: params.serverAmount, script: p2pkhLockScript(params.serverPublicKeyHex) },
      { value: params.totalAmount - params.serverAmount, script: p2pkhLockScript(params.clientPublicKeyHex) }
    ],
    lockTime: params.endHeight
  };
}

export async function sdkBuildBaseTx(params: {
  clientUtxos: FeepoolSdkUtxo[];
  clientPublicKeyHex: string;
  signTransaction: FeePoolTransactionSigner;
  serverPublicKeyHex: string;
  feepoolAmount: number;
  feeRate: number;
}): Promise<FeepoolSdkBaseTxResponse> {
  const totalValue = params.clientUtxos.reduce((sum, u) => sum + u.satoshis, 0);
  if (params.feepoolAmount <= 0) throw new Error("feepoolAmount must be positive");
  if (totalValue < params.feepoolAmount) {
    throw new Error("Insufficient UTXO balance for fee pool base tx");
  }
  const initialChange = totalValue - params.feepoolAmount;
  let unsigned = buildUnsignedBaseTx({
    clientUtxos: params.clientUtxos,
    clientPublicKeyHex: params.clientPublicKeyHex,
    serverPublicKeyHex: params.serverPublicKeyHex,
    feepoolAmount: params.feepoolAmount,
    changeAmount: initialChange
  });
  // DER 长度变化不应导致多次签名、多次预占额度。108 是单个 P2PKH 解锁脚本的上界。
  const upperSize=serializeTx(unsigned).length+108*unsigned.inputs.length;
  const fee=Math.max(1,Math.ceil(upperSize*params.feeRate/1000));
  if(totalValue<params.feepoolAmount+fee)throw new Error('Insufficient balance for fee pool funding fee');
  unsigned.outputs[1]!.value=totalValue-params.feepoolAmount-fee;
  const signedHex=await signP2pkhInputs(unsigned,params.signTransaction,params.clientPublicKeyHex);
  return {
    txHex: signedHex,
    txid: calcTxidFromRawTxHex(signedHex),
    outputIndex: 0,
    amount: params.feepoolAmount
  };
}

export async function sdkBuildInitialDraftSpendTx(params: {
  prevTxId: string;
  totalAmount: number;
  serverAmount: number;
  endHeight: number;
  clientPublicKeyHex: string;
  serverPublicKeyHex: string;
  feeRate: number;
}): Promise<FeepoolSdkDraftTxResponse> {
  const tx = buildUnsignedSpendTx({
    prevTxId: params.prevTxId,
    totalAmount: params.totalAmount,
    serverAmount: params.serverAmount,
    endHeight: params.endHeight,
    clientPublicKeyHex: params.clientPublicKeyHex,
    serverPublicKeyHex: params.serverPublicKeyHex
  });
  tx.inputs[0]!.scriptSig = fakeDualMultisigUnlockScript();
  const size = serializeTx(tx).length;
  const fee = Math.max(1, Math.floor((size / 1000) * params.feeRate));
  if (params.totalAmount < params.serverAmount + fee) {
    throw new Error(`余额不足，需要 ${params.serverAmount + fee}，拥有 ${params.totalAmount}`);
  }
  tx.inputs[0]!.scriptSig = new Uint8Array(0);
  tx.outputs[1]!.value = params.totalAmount - params.serverAmount - fee;
  return { txHex: bytesToHex(serializeTx(tx)) };
}

export async function sdkLoadDraftSpendTx(params: {
  prevDraftHex: string;
  locktime: number | undefined;
  sequenceNumber: number;
  serverAmount: number;
  serverPublicKeyHex: string;
  clientPublicKeyHex: string;
  targetAmount: number;
}): Promise<FeepoolSdkDraftTxResponse> {
  const tx = deserializeTx(hexToBytes(params.prevDraftHex));
  if (params.locktime !== undefined) tx.lockTime = params.locktime;
  tx.inputs[0]!.sequence = params.sequenceNumber;
  tx.outputs[0]!.value = params.serverAmount;
  tx.outputs[1]!.value = params.targetAmount - params.serverAmount;
  // 确保脚本跟 caller 传入的公钥一致（防止旧 draft 被错 owner 复用）。
  tx.outputs[0]!.script = p2pkhLockScript(params.serverPublicKeyHex);
  tx.outputs[1]!.script = p2pkhLockScript(params.clientPublicKeyHex);
  return { txHex: bytesToHex(serializeTx(tx)) };
}

export async function sdkClientSignInitialSpendTx(params: {
  txHex: string; totalAmount: number; signTransaction: FeePoolTransactionSigner; clientPublicKeyHex: string; serverPublicKeyHex: string;
}): Promise<Uint8Array> {
  const signatures=await params.signTransaction(params.txHex);
  if(signatures.length!==1)throw new Error('Invalid fee pool signature count');
  const signature=hexToBytes(signatures[0]!);
  if(signature[0]!==0x30||signature.at(-1)!==SIGHASH_ALL_FORKID)throw new Error('Invalid fee pool signature');
  return signature;
}
export async function sdkClientSignUpdatedSpendTx(params: {
  txHex: string; sourceSatoshis: number; signTransaction: FeePoolTransactionSigner; clientPublicKeyHex: string; serverPublicKeyHex: string;
}): Promise<Uint8Array> {
  return sdkClientSignInitialSpendTx({...params,totalAmount:params.sourceSatoshis});
}

export async function sdkVerifyServerInitialSpendSig(params: {
  txHex: string;
  totalAmount: number;
  serverPublicKeyHex: string;
  clientPublicKeyHex: string;
  serverSignBytes: Uint8Array;
}): Promise<boolean> {
  const tx = deserializeTx(hexToBytes(params.txHex));
  const serverPub = publicKeyLike(params.serverPublicKeyHex);
  const clientPub = publicKeyLike(params.clientPublicKeyHex);
  return clientVerifyServerSpendSig(
    tx as any,
    params.totalAmount,
    serverPub as never,
    clientPub as never,
    Array.from(params.serverSignBytes)
  );
}

export async function sdkVerifyServerUpdateSig(params: {
  txHex: string;
  serverPublicKeyHex: string;
  clientPublicKeyHex: string;
  serverSignBytes: Uint8Array;
}): Promise<boolean> {
  const tx = deserializeTx(hexToBytes(params.txHex));
  return clientVerifyServerUpdateSig(
    tx as never,
    publicKeyLike(params.serverPublicKeyHex) as never,
    publicKeyLike(params.clientPublicKeyHex) as never,
    Array.from(params.serverSignBytes)
  );
}

export function calcTxidFromRawTxHex(rawTxHex: string): string {
  const bytes = hexToBytes(rawTxHex);
  const hash = dsha256(bytes);
  return bytesToHex(new Uint8Array([...hash].reverse()));
}

function publicKeyLike(hex: string): { toString(): string } {
  return {
    toString() {
      return hex;
    }
  };
}
