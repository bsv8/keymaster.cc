// packages/plugin-protocol/src/protocolValidation.ts
// 协议层校验：顶层 message 结构 / BinaryField 形状 / aud / iat / exp /
// p2pkh 地址 / feepool 公钥 hex / 金额正整数。
//
// 设计缘由（施工单 001 + 002 硬切换）：
//   - 校验与业务执行分离：service 只调用这里抛错 / 返回值的接口。
//   - 校验失败全部映射为 ProtocolError，方便 service 直接组装 result。
//   - 不允许把"已经经过一轮校验的 request"再做一次隐式归一化。
//   - `aud` 严格按字节比较；不补默认端口、不 lower host、不改协议。
//   - 二进制字段必须含 `$type: "binary"` + ArrayBuffer；缺 mime 也接受。
//   - p2pkh 地址必须是 mainnet（version 0x00）；testnet（0x6f）直接
//     invalid_request。
//   - 公钥 hex 必须是 33-byte compressed secp256k1（66 个 hex 字符）。
//   - amountSatoshis 必须是正整数；feeRateSatoshisPerKb 必须 >= 1。

import type {
  BinaryField,
  CipherDecryptParams,
  CipherEncryptParams,
  FeepoolCommitParams,
  FeepoolPrepareParams,
  IdentityGetParams,
  IntentSignParams,
  MethodParams,
  P2pkhTransferParams,
  ProtocolErrorCode,
  ProtocolMethod,
  ProtocolRequestMessage
} from "@keymaster/contracts";
import { PROTOCOL_METHODS, PROTOCOL_VERSION } from "@keymaster/contracts";

/** 校验失败：抛出的对象。service 会捕获并组装 ProtocolError。 */
export class ProtocolValidationError extends Error {
  readonly code: ProtocolErrorCode;
  constructor(code: ProtocolErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ProtocolValidationError";
  }
}

/**
 * 校验顶层 message 形状。返回 { id, method, params } 或抛错。
 *
 * 不接受非对象 / 缺字段 / method 不在 PROTOCOL_METHODS 内 / 缺 v/version 不对。
 */
export function parseRequestMessage(
  raw: unknown
): { id: string; method: ProtocolMethod; params: MethodParams<ProtocolMethod> } {
  if (!isPlainObject(raw)) {
    throw new ProtocolValidationError("invalid_request", "Request must be a plain object");
  }
  if (raw.v !== PROTOCOL_VERSION) {
    throw new ProtocolValidationError("invalid_request", "Unsupported protocol version");
  }
  if (raw.type !== "request") {
    throw new ProtocolValidationError("invalid_request", "Message type must be 'request'");
  }
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    throw new ProtocolValidationError("invalid_request", "Request id is required");
  }
  if (typeof raw.method !== "string" || !PROTOCOL_METHODS.includes(raw.method as ProtocolMethod)) {
    throw new ProtocolValidationError("invalid_request", "Unknown method");
  }
  const method = raw.method as ProtocolMethod;
  const params = validateParams(method, raw.params, raw.id);
  return { id: raw.id, method, params };
}

/** 校验单个 method 的 params。抛 ProtocolValidationError。 */
function validateParams(
  method: ProtocolMethod,
  raw: unknown,
  _id: string
): MethodParams<ProtocolMethod> {
  switch (method) {
    case "identity.get":
      return validateIdentityGetParams(raw);
    case "intent.sign":
      return validateIntentSignParams(raw);
    case "cipher.encrypt":
      return validateCipherEncryptParams(raw);
    case "cipher.decrypt":
      return validateCipherDecryptParams(raw);
    case "p2pkh.transfer":
      return validateP2pkhTransferParams(raw);
    case "feepool.prepare":
      return validateFeepoolPrepareParams(raw);
    case "feepool.commit":
      return validateFeepoolCommitParams(raw);
  }
}

function validateIdentityGetParams(raw: unknown): IdentityGetParams {
  const obj = expectObject(raw, "identity.get params");
  const aud = expectString(obj.aud, "aud");
  const iat = expectInteger(obj.iat, "iat");
  const exp = expectInteger(obj.exp, "exp");
  const text = expectString(obj.text, "text");
  if (exp <= iat) {
    throw new ProtocolValidationError("invalid_request", "exp must be greater than iat");
  }
  if (obj.claims !== undefined) {
    if (!Array.isArray(obj.claims)) {
      throw new ProtocolValidationError("invalid_request", "claims must be an array of strings");
    }
    for (const c of obj.claims) {
      if (typeof c !== "string") {
        throw new ProtocolValidationError("invalid_request", "claims entries must be strings");
      }
    }
  }
  return { aud, iat, exp, text, claims: obj.claims as string[] | undefined };
}

function validateIntentSignParams(raw: unknown): IntentSignParams {
  const obj = expectObject(raw, "intent.sign params");
  const aud = expectString(obj.aud, "aud");
  const iat = expectInteger(obj.iat, "iat");
  const exp = expectInteger(obj.exp, "exp");
  const text = expectString(obj.text, "text");
  const contentType = expectString(obj.contentType, "contentType");
  if (exp <= iat) {
    throw new ProtocolValidationError("invalid_request", "exp must be greater than iat");
  }
  const content = parseBinaryField(obj.content, "content");
  return { aud, iat, exp, text, contentType, content };
}

function validateCipherEncryptParams(raw: unknown): CipherEncryptParams {
  const obj = expectObject(raw, "cipher.encrypt params");
  const text = expectString(obj.text, "text");
  const contentType = expectString(obj.contentType, "contentType");
  const content = parseBinaryField(obj.content, "content");
  return { text, contentType, content };
}

function validateCipherDecryptParams(raw: unknown): CipherDecryptParams {
  const obj = expectObject(raw, "cipher.decrypt params");
  const text = expectString(obj.text, "text");
  const nonce = parseBinaryField(obj.nonce, "nonce");
  const cipherbytes = parseBinaryField(obj.cipherbytes, "cipherbytes");
  return { text, nonce, cipherbytes };
}

/** 严格比较 `aud` 与 `event.origin`；不补端口 / 不 lower host。 */
export function assertOriginMatches(aud: string, eventOrigin: string): void {
  if (aud !== eventOrigin) {
    throw new ProtocolValidationError("invalid_origin", "aud does not match event origin");
  }
}

/* ============== 施工单 002 硬切换：p2pkh.transfer / feepool.* 校验 ============== */

function validateP2pkhTransferParams(raw: unknown): P2pkhTransferParams {
  const obj = expectObject(raw, "p2pkh.transfer params");
  const recipientAddress = expectString(obj.recipientAddress, "recipientAddress");
  assertMainnetP2pkhAddress(recipientAddress);
  const amountSatoshis = expectPositiveInteger(obj.amountSatoshis, "amountSatoshis");
  let feeRateSatoshisPerKb: number | undefined;
  if (obj.feeRateSatoshisPerKb !== undefined) {
    const v = expectPositiveInteger(obj.feeRateSatoshisPerKb, "feeRateSatoshisPerKb");
    if (v < 1) {
      throw new ProtocolValidationError("invalid_request", "feeRateSatoshisPerKb must be >= 1");
    }
    feeRateSatoshisPerKb = v;
  }
  return { recipientAddress, amountSatoshis, feeRateSatoshisPerKb };
}

function validateFeepoolPrepareParams(raw: unknown): FeepoolPrepareParams {
  const obj = expectObject(raw, "feepool.prepare params");
  const counterpartyPublicKeyHex = expectString(obj.counterpartyPublicKeyHex, "counterpartyPublicKeyHex");
  assertCompressedPubkeyHex(counterpartyPublicKeyHex);
  const amountSatoshis = expectPositiveInteger(obj.amountSatoshis, "amountSatoshis");
  return { counterpartyPublicKeyHex, amountSatoshis };
}

function validateFeepoolCommitParams(raw: unknown): FeepoolCommitParams {
  const obj = expectObject(raw, "feepool.commit params");
  const operationId = expectNonEmptyString(obj.operationId, "operationId");
  const counterpartyPublicKeyHex = expectString(obj.counterpartyPublicKeyHex, "counterpartyPublicKeyHex");
  assertCompressedPubkeyHex(counterpartyPublicKeyHex);
  if (!Array.isArray(obj.counterpartySignatures)) {
    throw new ProtocolValidationError("invalid_request", "counterpartySignatures must be an array");
  }
  if (obj.counterpartySignatures.length === 0) {
    throw new ProtocolValidationError("invalid_request", "counterpartySignatures must not be empty");
  }
  const counterpartySignatures: BinaryField[] = obj.counterpartySignatures.map((s, idx) =>
    parseBinaryField(s, `counterpartySignatures[${idx}]`)
  );
  // 可选：base / close 签名段；只允许在 create / close_and_recreate 路径下传入。
  function optionalSignatures(field: string): BinaryField[] | undefined {
    if (obj[field] === undefined) return undefined;
    const arr = obj[field];
    if (!Array.isArray(arr)) {
      throw new ProtocolValidationError("invalid_request", `${field} must be an array`);
    }
    return arr.map((s, idx) => parseBinaryField(s, `${field}[${idx}]`));
  }
  // V4 收口：base tx 不再需要 server sig（client 用 P2PKH UTXO funding
  // 并签 inputs，multisig output 是被创建不是被花费）；只保留可选的
  // closeCounterpartySignatures（仅 close_and_recreate 需要）。
  const closeCounterpartySignatures = optionalSignatures("closeCounterpartySignatures");
  return {
    operationId,
    counterpartyPublicKeyHex,
    counterpartySignatures,
    closeCounterpartySignatures
  };
}

/* ============== helpers ============== */

/**
 * 校验主网 P2PKH 地址：base58check 解码 → 25 字节 → version 0x00。
 * testnet（version 0x6f）直接 invalid_request；本次硬切换只支持主网。
 *
 * 不做 checksum 校验：base58 解码长度 + version 足够排除绝大多数误传；
 * 真正的 chain-level 校验由 p2pkhTransferService.prepare 在签名时承担。
 */
export function assertMainnetP2pkhAddress(addr: string): void {
  let decoded: Uint8Array;
  try {
    decoded = base58Decode(addr);
  } catch {
    throw new ProtocolValidationError("invalid_request", "recipientAddress is not a valid P2PKH address");
  }
  if (decoded.length !== 25) {
    throw new ProtocolValidationError("invalid_request", "recipientAddress must be a mainnet P2PKH address");
  }
  if (decoded[0] !== 0x00) {
    throw new ProtocolValidationError("invalid_request", "recipientAddress must be a mainnet P2PKH address");
  }
}

/** 33-byte compressed secp256k1 公钥 hex：66 字符，全 hex 字符。 */
export function assertCompressedPubkeyHex(hex: string): void {
  if (hex.length !== 66) {
    throw new ProtocolValidationError("invalid_request", "counterpartyPublicKeyHex must be a 33-byte compressed public key hex");
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new ProtocolValidationError("invalid_request", "counterpartyPublicKeyHex must be hex");
  }
}

function expectPositiveInteger(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new ProtocolValidationError("invalid_request", `${name} must be a positive integer`);
  }
  return v;
}

function expectNonEmptyString(v: unknown, name: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new ProtocolValidationError("invalid_request", `${name} must be a non-empty string`);
  }
  return v;
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** 最小 base58 解码（不验 checksum）。 */
function base58Decode(input: string): Uint8Array {
  if (input.length === 0) return new Uint8Array(0);
  const bytes: number[] = [0];
  for (const ch of input) {
    let carry = BASE58_ALPHABET.indexOf(ch);
    if (carry < 0) throw new Error("invalid base58");
    for (let i = 0; i < bytes.length; i++) {
      const v = bytes[i]! * 58 + carry;
      bytes[i] = v & 0xff;
      carry = (v / 256) | 0;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry = (carry / 256) | 0;
    }
  }
  let leadingZeros = 0;
  for (const ch of input) {
    if (ch === "1") leadingZeros++;
    else break;
  }
  const out = new Uint8Array(leadingZeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[out.length - 1 - i] = bytes[i]!;
  }
  return out;
}

/* ============== helpers ============== */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function expectObject(v: unknown, name: string): Record<string, unknown> {
  if (!isPlainObject(v)) {
    throw new ProtocolValidationError("invalid_request", `${name} must be an object`);
  }
  return v;
}

function expectString(v: unknown, name: string): string {
  if (typeof v !== "string") {
    throw new ProtocolValidationError("invalid_request", `${name} must be a string`);
  }
  return v;
}

function expectInteger(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new ProtocolValidationError("invalid_request", `${name} must be an integer`);
  }
  return v;
}

function parseBinaryField(v: unknown, name: string): BinaryField {
  if (!isPlainObject(v)) {
    throw new ProtocolValidationError("invalid_request", `${name} must be a BinaryField object`);
  }
  if (v.$type !== "binary") {
    throw new ProtocolValidationError("invalid_request", `${name} must have $type="binary"`);
  }
  if (!(v.bytes instanceof ArrayBuffer)) {
    throw new ProtocolValidationError("invalid_request", `${name}.bytes must be ArrayBuffer`);
  }
  if (v.mime !== undefined && typeof v.mime !== "string") {
    throw new ProtocolValidationError("invalid_request", `${name}.mime must be string when present`);
  }
  return { $type: "binary", bytes: v.bytes, mime: v.mime as string | undefined };
}

/** 顶层 message 形状的"只看是不是已绑定 source 会话能接受的 request"。 */
export function isStructuredCloneRequestCandidate(v: unknown): v is ProtocolRequestMessage {
  if (!isPlainObject(v)) return false;
  if (v.v !== PROTOCOL_VERSION) return false;
  if (v.type !== "request") return false;
  if (typeof v.id !== "string") return false;
  if (typeof v.method !== "string") return false;
  return true;
}
