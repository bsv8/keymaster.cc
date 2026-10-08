// Forum 协议字节原语：hex、大小端、hash 显示序与 DER。
//
// 与服务端 `internal/bsv/hash.go`、`internal/bsv/signature.go` 逐条对齐：
//   - txid/hash 一律是「显示顺序」的 32 字节，即 hex 字符串读出来的顺序；
//   - 原始交易内部把 txid 反转存放，只有跨 raw 边界时才做这一次反转；
//   - 签名是严格 DER 且 low-S，验证端同样拒绝 high-S。

export const HASH_BYTES = 32;
export const HASH_HEX_CHARS = HASH_BYTES * 2;
export const PUBLIC_KEY_BYTES = 33;
export const DER_MIN_BYTES = 8;
export const DER_MAX_BYTES = 72;

const LOWERCASE_HEX = /^[0-9a-f]*$/u;
const ANY_HEX = /^[0-9a-fA-F]*$/u;

/** 64 字符小写 hex 判定；协议字段一律要求这个形态。 */
export function isHashHex(input: unknown): input is string {
  return typeof input === "string" && input.length === HASH_HEX_CHARS && LOWERCASE_HEX.test(input);
}

/** 33 字节压缩 SEC1 的小写 hex 判定。 */
export function isPublicKeyHex(input: unknown): input is string {
  return (
    typeof input === "string" &&
    input.length === PUBLIC_KEY_BYTES * 2 &&
    (input.startsWith("02") || input.startsWith("03")) &&
    LOWERCASE_HEX.test(input)
  );
}

/** 偶数长度 hex 解码；奇数长度或非 hex 字符都拒绝。 */
export function hexToBytes(text: string): Uint8Array {
  if (text.length % 2 !== 0) throw new ProtocolEncodingError("hex_length", `hex 长度必须是偶数：${text.length}`);
  if (!ANY_HEX.test(text)) throw new ProtocolEncodingError("hex_charset", "hex 含有非十六进制字符");
  const out = new Uint8Array(text.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function reverseBytes(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) {
    out[index] = bytes[bytes.length - 1 - index] as number;
  }
  return out;
}

/** 协议编解码的稳定失败原因；界面按 code 展示，不解析英文 message。 */
export class ProtocolEncodingError extends Error {
  readonly code: string;

  /**
   * `code` 是稳定标识，`message` 只用于诊断。
   *
   * 两个参数都是必需的：漏传 message 会把中文提示塞进 code，让界面拿到一个
   * 无意义的稳定码，所以这里直接失败而不是静默降级。
   */
  constructor(code: string, message: string) {
    if (typeof code !== "string" || code.length === 0) {
      throw new TypeError("ProtocolEncodingError 需要非空的稳定 code");
    }
    if (typeof message !== "string" || message.length === 0) {
      throw new TypeError(`ProtocolEncodingError(${code}) 缺少诊断 message`);
    }
    super(message);
    this.name = "ProtocolEncodingError";
    this.code = code;
  }
}

/**
 * 解析 64 字符 txid/hash 为显示顺序的 32 字节。
 *
 * 大写被接受并归一化成小写，与服务端 `bsv.ParseHash` 一致：签名字段里的字节
 * 才是被签的内容，hex 字符串只是它的展示形式；客户端自己生成的字段一律用
 * `isHashHex` 校验的小写形态。
 */
export function parseHashHex(input: string): Uint8Array {
  if (input !== input.trim()) {
    throw new ProtocolEncodingError("hash_whitespace", "hash 不允许带首尾空白");
  }
  if (input.length !== HASH_HEX_CHARS) {
    throw new ProtocolEncodingError("hash_length", `hash 必须是 ${HASH_HEX_CHARS} 个 hex 字符，实际 ${input.length}`);
  }
  return hexToBytes(input.toLowerCase());
}

/** 32 字节显示顺序 hash 渲染成小写 hex。 */
export function formatHashHex(bytes: Uint8Array): string {
  if (bytes.length !== HASH_BYTES) {
    throw new ProtocolEncodingError("hash_length", `hash 必须是 ${HASH_BYTES} 字节，实际 ${bytes.length}`);
  }
  return bytesToHex(bytes);
}

/** raw 交易内部字节序（反向）→ 显示顺序。 */
export function rawTxidToDisplay(rawTxid: Uint8Array): Uint8Array {
  if (rawTxid.length !== HASH_BYTES) {
    throw new ProtocolEncodingError("hash_length", `raw txid 必须是 ${HASH_BYTES} 字节`);
  }
  return reverseBytes(rawTxid);
}

/** 显示顺序 → raw 交易内部字节序（反向）。 */
export function displayToRawTxid(displayTxid: Uint8Array): Uint8Array {
  if (displayTxid.length !== HASH_BYTES) {
    throw new ProtocolEncodingError("hash_length", `txid 必须是 ${HASH_BYTES} 字节`);
  }
  return reverseBytes(displayTxid);
}

/** 校验压缩公钥：33 字节、02/03 前缀、且落在曲线上。 */
export function validatePublicKey(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== PUBLIC_KEY_BYTES) {
    throw new ProtocolEncodingError("public_key_length", `公钥必须是 ${PUBLIC_KEY_BYTES} 字节，实际 ${publicKey.length}`);
  }
  const prefix = publicKey[0];
  if (prefix !== 0x02 && prefix !== 0x03) {
    throw new ProtocolEncodingError("public_key_prefix", "公钥必须是压缩 SEC1（02/03 前缀）");
  }
  if (!isOnCurve(publicKey)) {
    throw new ProtocolEncodingError("public_key_point", "公钥不是有效的 secp256k1 曲线点");
  }
  return publicKey;
}

function isOnCurve(publicKey: Uint8Array): boolean {
  const x = bytesToBigInt(publicKey.subarray(1));
  // y² = x³ + 7
  const ySquared = mod(((x * x % P) * x % P) + 7n, P);
  const y = modSqrt(ySquared, P);
  if (y === undefined) return false;
  // y = 0 时两个根相同，奇偶前缀都指向同一个点。
  if (y === 0n) return true;
  // 压缩前缀编码的是 y 的奇偶；不匹配时另一个根是 p - y。
  const parity = BigInt((publicKey[0] ?? 0) & 1);
  const candidate = (y & 1n) === parity ? y : P - y;
  return mod(candidate * candidate, P) === ySquared;
}

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function mod(value: bigint, modulus: bigint): bigint {
  const result = value % modulus;
  return result < 0n ? result + modulus : result;
}

/** 素数域模平方根；曲线 p ≡ 3 (mod 4)，所以 y = v^((p+1)/4)。 */
function modSqrt(value: bigint, modulus: bigint): bigint | undefined {
  if (value === 0n) return 0n;
  const exponent = (modulus + 1n) / 4n;
  let base = value;
  let result = 1n;
  let power = exponent;
  while (power > 0n) {
    if (power & 1n) result = (result * base) % modulus;
    base = (base * base) % modulus;
    power >>= 1n;
  }
  return mod(result * result, modulus) === value ? result : undefined;
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

export function bigIntToMinimalBytes(value: bigint): Uint8Array {
  if (value < 0n) throw new ProtocolEncodingError("uint_negative", "uint64 不接受负数");
  if (value === 0n) return new Uint8Array([0]);
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  return hexToBytes(hex);
}

export interface DerSignature {
  readonly r: bigint;
  readonly s: bigint;
}

/**
 * 严格 DER 读取，与服务端 `bsv.ParseDerSignature` 逐条对应。
 *
 * 拒绝项：外层 tag 不是 0x30、长度不等于剩余字节、整数 tag 不是 0x02、
 * 整数长度不在 1..33、最高位为 1（负数）、非最短编码（多余前导 0x00）、
 * 尾部多余字节，以及 high-S。
 */
export function parseDerSignature(signature: Uint8Array): DerSignature {
  if (signature.length < DER_MIN_BYTES || signature.length > DER_MAX_BYTES) {
    throw new ProtocolEncodingError("der_length", `DER 签名长度必须在 ${DER_MIN_BYTES}..${DER_MAX_BYTES} 字节`);
  }
  if (signature[0] !== 0x30) throw new ProtocolEncodingError("der_tag", "DER 签名必须以 0x30 开头");
  if (signature[1] !== signature.length - 2) {
    throw new ProtocolEncodingError("der_length", "DER 签名长度字节与实际长度不一致");
  }
  const r = readDerInteger(signature, 2);
  const s = readDerInteger(signature, r.next);
  if (s.next !== signature.length) {
    throw new ProtocolEncodingError("der_trailing", "DER 签名末尾有多余字节");
  }
  if (r.value <= 0n || r.value >= N) throw new ProtocolEncodingError("der_r_range", "DER 的 r 超出 secp256k1 阶");
  if (s.value <= 0n || s.value > N / 2n) throw new ProtocolEncodingError("der_s_range", "DER 的 s 必须是 low-S");
  return { r: r.value, s: s.value };
}

function readDerInteger(signature: Uint8Array, offset: number): { value: bigint; next: number } {
  if (signature[offset] !== 0x02) throw new ProtocolEncodingError("der_tag", "DER 整数标记必须是 0x02");
  const length = signature[offset + 1];
  if (length === undefined || length < 1 || length > 33) {
    throw new ProtocolEncodingError("der_integer_length", "DER 整数长度必须在 1..33");
  }
  const start = offset + 2;
  const end = start + length;
  if (end > signature.length) throw new ProtocolEncodingError("der_truncated", "DER 整数被截断");
  const body = signature.subarray(start, end);
  const first = body[0] as number;
  if ((first & 0x80) !== 0) throw new ProtocolEncodingError("der_negative", "DER 整数不接受负数");
  if (length > 1 && first === 0x00 && ((body[1] as number) & 0x80) === 0) {
    throw new ProtocolEncodingError("der_non_minimal", "DER 整数存在多余的前导零字节");
  }
  return { value: bytesToBigInt(body), next: end };
}

/** 只要格式合法（严格 DER + low-S）就返回 true。 */
export function isCanonicalDer(signature: Uint8Array): boolean {
  try {
    parseDerSignature(signature);
    return true;
  } catch {
    return false;
  }
}