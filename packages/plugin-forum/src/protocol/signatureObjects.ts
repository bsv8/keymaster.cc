// Forum 四类业务签名对象：确定性 CBOR 定长数组 + 单次 SHA-256 + 严格 DER。
//
// 与服务端 `internal/protocol/messages.go` 逐条对齐。三点必须分清：
//   1. 数组里的 txid/hash 是**显示顺序**的原始 32 字节 byte string；
//   2. 业务 DER **不追加** sighash 字节；交易输入签名才追加 0x41；
//   3. 摘要只做**一次** SHA-256（双 SHA-256 是 txid 和 FORKID sighash 的事）。
//
// 页面不能提交任意 digest 让 Worker 签名：signer 只接受这里的结构化字段，
// 字节由本模块在受控边界内重建。

import { HASH_BYTES, PUBLIC_KEY_BYTES, ProtocolEncodingError, isCanonicalDer, validatePublicKey } from "./bytes.js";
import {
  MAX_CBOR_ITEM_BYTES,
  cborArray,
  cborBytes,
  cborText,
  cborUint,
  decodeCbor,
  encodeCborArray,
  requireArray,
  requireArrayAny,
  requireBytes,
  requireText,
  requireUint,
  type CborValue,
} from "./cbor.js";
import { KIND_CHANGETIP, KIND_FORUM, KIND_REPLY } from "./script.js";

export const MAX_FORUM_SIGNATURE_BYTES = 8 * 1024;
export const MAX_FORUM_INPUTS = 128;

export interface SigningPort {
  /** 对 32 字节摘要做严格 DER low-S 签名。 */
  signDigest(digest: Uint8Array): Promise<Uint8Array>;
  /** 校验 DER 签名；供客户端侧自检，不替代服务端索引器的判断。 */
  verifyDigest(publicKey: Uint8Array, digest: Uint8Array, signature: Uint8Array): Promise<boolean>;
}

export interface ForumInput {
  /** 显示顺序的 prevout txid。 */
  readonly txid: Uint8Array;
  readonly vout: number;
}

/* ============== 创世 forumSig（四项数组） ============== */

/**
 * `["bsv8.forum.1", forum_name, tip_price, [[prev_txid_0, prev_vout_0], ...]]`
 *
 * 最后一项是声明交易自己的全部 input outpoint，按交易顺序，既不排序也不截断。
 * 把 input 签进去，是为了让一份为某个出资来源做的签名不能被搬到别人付过钱的
 * 交易上：被复制的数据输出不等于被复制的声明。
 */
export interface ForumSignatureObject {
  readonly kind: typeof KIND_FORUM;
  readonly forumName: string;
  readonly tipPrice: bigint;
  readonly inputs: readonly ForumInput[];
}

export function encodeForumSignatureObject(object: ForumSignatureObject): Uint8Array {
  validateForumSignatureObject(object);
  const inputs = object.inputs.map((input) => cborArray([cborBytes(input.txid), cborUint(input.vout)]));
  const encoded = encodeCborArray([
    cborText(object.kind),
    cborText(object.forumName),
    cborUint(object.tipPrice),
    cborArray(inputs),
  ]);
  if (encoded.length > MAX_CBOR_SIGNATURE_ARRAY_BYTES) {
    throw new ProtocolEncodingError("forum_signature_size", `forumSig 编码后 ${encoded.length} 字节超过上限`);
  }
  return encoded;
}

/** 签名对象本身的上限；与 Go 的 MaxCBORItemBytes 保持一致。 */
export const MAX_CBOR_SIGNATURE_ARRAY_BYTES = MAX_CBOR_ITEM_BYTES;

export function validateForumSignatureObject(object: ForumSignatureObject): void {
  if (object.kind !== KIND_FORUM) throw new ProtocolEncodingError("forum_kind", `kind 必须是 ${KIND_FORUM}`);
  const nameBytes = new TextEncoder().encode(object.forumName);
  if (nameBytes.length === 0) throw new ProtocolEncodingError("forum_name_empty", "forum_name 不能为空");
  if (nameBytes.length > 256) throw new ProtocolEncodingError("forum_name_long", `forum_name 超过 256 字节`);
  if (object.tipPrice < 0n) throw new ProtocolEncodingError("forum_price_negative", "tip_price 不能为负");
  if (object.inputs.length === 0) throw new ProtocolEncodingError("forum_inputs_empty", "forumSig 必须覆盖全部 input outpoint");
  if (object.inputs.length > MAX_FORUM_INPUTS) throw new ProtocolEncodingError("forum_inputs_many", `forumSig 最多覆盖 ${MAX_FORUM_INPUTS} 个 input`);
  const seen = new Set<string>();
  for (const input of object.inputs) {
    if (input.txid.length !== HASH_BYTES) throw new ProtocolEncodingError("forum_input_txid", `input txid 必须是 ${HASH_BYTES} 字节`);
    if (!Number.isSafeInteger(input.vout) || input.vout < 0 || input.vout > 0xffffffff) {
      throw new ProtocolEncodingError("forum_input_vout", `input vout 必须在 0..0xffffffff，实际 ${input.vout}`);
    }
    const key = `${hexOf(input.txid)}:${input.vout}`;
    if (seen.has(key)) throw new ProtocolEncodingError("forum_input_duplicate", `重复的 input outpoint ${key}`);
    seen.add(key);
  }
}

export function decodeForumSignatureObject(data: Uint8Array): ForumSignatureObject {
  const items = requireArray(decodeCbor(data), 4, "forum 签名数组");
  const kind = requireText(items[0] as CborValue, "kind");
  const forumName = requireText(items[1] as CborValue, "forum_name");
  const tipPrice = requireUint(items[2] as CborValue, "tip_price");
  const rawInputs = requireArrayAny(items[3] as CborValue, "inputs");
  const inputs = rawInputs.map((raw) => {
    const pair = requireArray(raw, 2, "input");
    return {
      txid: requireBytes(pair[0] as CborValue, "prev_txid", HASH_BYTES),
      vout: Number(requireUint(pair[1] as CborValue, "prev_vout")),
    };
  });
  const object: ForumSignatureObject = { kind: kind as typeof KIND_FORUM, forumName, tipPrice, inputs };
  validateForumSignatureObject(object);
  return object;
}

/* ============== reply operatorSig / indexSig ============== */

export interface ReplyOperatorObject {
  readonly kind: typeof KIND_REPLY;
  readonly parentTxid: Uint8Array;
  readonly parentPublicKey: Uint8Array;
  readonly replyMasterSeedHash: Uint8Array;
  readonly tipPrice: bigint;
}

export function encodeReplyOperatorObject(object: ReplyOperatorObject): Uint8Array {
  validateHash32(object.parentTxid, "parent_txid");
  validatePublicKey(object.parentPublicKey);
  validateHash32(object.replyMasterSeedHash, "reply_masterseedhash");
  if (object.tipPrice < 0n) throw new ProtocolEncodingError("tip_price_negative", "tip_price 不能为负");
  return encodeCborArray([
    cborText(object.kind),
    cborBytes(object.parentTxid),
    cborBytes(object.parentPublicKey),
    cborBytes(object.replyMasterSeedHash),
    cborUint(object.tipPrice),
  ]);
}

export interface ReplyIndexObject {
  readonly kind: typeof KIND_REPLY;
  readonly parentTxid: Uint8Array;
  readonly parentPublicKey: Uint8Array;
  readonly replyMasterSeedHash: Uint8Array;
  readonly tipPrice: bigint;
  readonly operatorSig: Uint8Array;
  readonly payToPublicKey: Uint8Array;
  readonly indexPrice: bigint;
  readonly lastBlockHeight: bigint;
}

export function encodeReplyIndexObject(object: ReplyIndexObject): Uint8Array {
  validateHash32(object.parentTxid, "parent_txid");
  validatePublicKey(object.parentPublicKey);
  validateHash32(object.replyMasterSeedHash, "reply_masterseedhash");
  if (!isCanonicalDer(object.operatorSig)) throw new ProtocolEncodingError("operator_sig_format", "operatorSig 不是严格 DER low-S 签名");
  validatePublicKey(object.payToPublicKey);
  return encodeCborArray([
    cborText(object.kind),
    cborBytes(object.parentTxid),
    cborBytes(object.parentPublicKey),
    cborBytes(object.replyMasterSeedHash),
    cborUint(object.tipPrice),
    cborBytes(object.operatorSig),
    cborBytes(object.payToPublicKey),
    cborUint(object.indexPrice),
    cborUint(object.lastBlockHeight),
  ]);
}

/* ============== changetip operatorSig / indexSig ============== */

export interface ChangeTipOperatorObject {
  readonly kind: typeof KIND_CHANGETIP;
  readonly parentTxid: Uint8Array;
  readonly tipPrice: bigint;
}

export function encodeChangeTipOperatorObject(object: ChangeTipOperatorObject): Uint8Array {
  validateHash32(object.parentTxid, "parent_txid");
  if (object.tipPrice < 0n) throw new ProtocolEncodingError("tip_price_negative", "tip_price 不能为负");
  return encodeCborArray([cborText(object.kind), cborBytes(object.parentTxid), cborUint(object.tipPrice)]);
}

export interface ChangeTipIndexObject {
  readonly kind: typeof KIND_CHANGETIP;
  readonly parentTxid: Uint8Array;
  readonly tipPrice: bigint;
  readonly payToPublicKey: Uint8Array;
  readonly indexPrice: bigint;
  readonly lastBlockHeight: bigint;
}

export function encodeChangeTipIndexObject(object: ChangeTipIndexObject): Uint8Array {
  validateHash32(object.parentTxid, "parent_txid");
  validatePublicKey(object.payToPublicKey);
  return encodeCborArray([
    cborText(object.kind),
    cborBytes(object.parentTxid),
    cborUint(object.tipPrice),
    cborBytes(object.payToPublicKey),
    cborUint(object.indexPrice),
    cborUint(object.lastBlockHeight),
  ]);
}

/* ============== 摘要与签名 ============== */

export function sha256Once(data: Uint8Array, sha256: (input: Uint8Array) => Uint8Array): Uint8Array {
  return sha256(data);
}

export async function signObjectBytes(bytes: Uint8Array, port: SigningPort, sha256: (input: Uint8Array) => Uint8Array): Promise<Uint8Array> {
  const digest = sha256Once(bytes, sha256);
  const signature = await port.signDigest(digest);
  if (!isCanonicalDer(signature)) {
    throw new ProtocolEncodingError("signature_format", "签名端口返回的不是严格 DER low-S 签名");
  }
  return signature;
}

export async function signReplyOperatorObject(
  object: ReplyOperatorObject,
  port: SigningPort,
  sha256: (input: Uint8Array) => Uint8Array,
): Promise<Uint8Array> {
  return signObjectBytes(encodeReplyOperatorObject(object), port, sha256);
}

export async function signChangeTipOperatorObject(
  object: ChangeTipOperatorObject,
  port: SigningPort,
  sha256: (input: Uint8Array) => Uint8Array,
): Promise<Uint8Array> {
  return signObjectBytes(encodeChangeTipOperatorObject(object), port, sha256);
}

export async function signForumSignatureObject(
  object: ForumSignatureObject,
  port: SigningPort,
  sha256: (input: Uint8Array) => Uint8Array,
): Promise<Uint8Array> {
  return signObjectBytes(encodeForumSignatureObject(object), port, sha256);
}

function validateHash32(value: Uint8Array, name: string): void {
  if (value.length !== HASH_BYTES) {
    throw new ProtocolEncodingError("hash_length", `${name} 必须是 ${HASH_BYTES} 字节，实际 ${value.length} 字节`);
  }
}

function hexOf(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export const FORUM_PROTOCOL_KINDS = Object.freeze({
  forum: KIND_FORUM,
  reply: KIND_REPLY,
  changetip: KIND_CHANGETIP,
});