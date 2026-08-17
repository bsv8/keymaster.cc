import { ripemd160 } from "@noble/hashes/ripemd160";
import { sha256 } from "@noble/hashes/sha256";

export interface ParsedP2pkhTransaction {
  canonicalTxid: string;
  inputs: Array<{ prevTxid: string; prevVout: number; outpointKey: string }>;
  outputs: Array<{ vout: number; value: number; scriptHex: string }>;
}

const MAX_TRANSACTION_BYTES = 10 * 1024 * 1024;
const MAX_VECTOR_ITEMS = 100_000;

function fail(message: string): never {
  throw new Error(`Invalid raw transaction: ${message}`);
}

function hexToBytes(raw: string): Uint8Array {
  if (typeof raw !== "string" || raw.length === 0 || raw.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(raw)) {
    fail("expected even-length hexadecimal bytes");
  }
  const bytes = new Uint8Array(raw.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(raw.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function reverseHex(hex: string): string {
  return bytesToHex(Uint8Array.from(hexToBytes(hex)).reverse());
}

function dsha256(bytes: Uint8Array): Uint8Array {
  return sha256(sha256(bytes));
}

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  get remaining(): number { return this.bytes.length - this.offset; }
  get position(): number { return this.offset; }

  read(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) fail("truncated transaction");
    const result = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }

  u32(): number {
    const b = this.read(4);
    return (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0;
  }

  u64(): number {
    const b = this.read(8);
    let value = 0;
    for (let i = 7; i >= 0; i -= 1) {
      value = value * 256 + b[i]!;
      if (!Number.isSafeInteger(value)) fail("amount exceeds safe integer range");
    }
    return value;
  }

  varInt(): number {
    const prefix = this.read(1)[0]!;
    if (prefix < 0xfd) return prefix;
    if (prefix === 0xfd) {
      const b = this.read(2);
      const value = b[0]! | (b[1]! << 8);
      if (value < 0xfd) fail("non-canonical varint");
      return value;
    }
    if (prefix === 0xfe) {
      const value = this.u32();
      if (value <= 0xffff) fail("non-canonical varint");
      return value;
    }
    const b = this.read(8);
    let value = 0;
    for (let i = 7; i >= 0; i -= 1) {
      value = value * 256 + b[i]!;
      if (!Number.isSafeInteger(value)) fail("varint exceeds safe integer range");
    }
    if (value <= 0xffffffff) fail("non-canonical varint");
    return value;
  }

  finish(): void {
    if (this.remaining !== 0) fail("trailing bytes");
  }
}

/** Parse only the consensus bytes needed by P2PKH facts. Provider JSON is ignored. */
export function parseP2pkhTransaction(rawTxHex: string, expectedTxid?: string): ParsedP2pkhTransaction {
  const normalized = rawTxHex.replace(/^0x/i, "").toLowerCase();
  const bytes = hexToBytes(normalized);
  if (bytes.length > MAX_TRANSACTION_BYTES) fail("transaction is too large");
  const canonicalTxid = reverseHex(bytesToHex(dsha256(bytes)));
  if (expectedTxid !== undefined && canonicalTxid !== expectedTxid.toLowerCase()) {
    fail(`txid mismatch: expected ${expectedTxid}, calculated ${canonicalTxid}`);
  }

  const reader = new Reader(bytes);
  reader.u32(); // version
  const inputCount = reader.varInt();
  if (inputCount === 0 || inputCount > MAX_VECTOR_ITEMS) fail("invalid input count");
  const inputs: ParsedP2pkhTransaction["inputs"] = [];
  for (let i = 0; i < inputCount; i += 1) {
    const prevTxid = reverseHex(bytesToHex(reader.read(32)));
    const prevVout = reader.u32();
    const scriptLength = reader.varInt();
    if (scriptLength > reader.remaining) fail("scriptSig exceeds transaction");
    reader.read(scriptLength);
    reader.u32(); // sequence
    inputs.push({ prevTxid, prevVout, outpointKey: `${prevTxid}:${prevVout}` });
  }

  const outputCount = reader.varInt();
  if (outputCount === 0 || outputCount > MAX_VECTOR_ITEMS) fail("invalid output count");
  const outputs: ParsedP2pkhTransaction["outputs"] = [];
  for (let vout = 0; vout < outputCount; vout += 1) {
    const value = reader.u64();
    const scriptLength = reader.varInt();
    if (scriptLength > reader.remaining) fail("scriptPubKey exceeds transaction");
    outputs.push({ vout, value, scriptHex: bytesToHex(reader.read(scriptLength)) });
  }
  reader.u32(); // locktime
  reader.finish();
  return { canonicalTxid, inputs, outputs };
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(value: string): Uint8Array {
  if (!value) fail("empty address");
  const digits = [0];
  for (const char of value) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) fail("invalid base58 address");
    let carry = digit;
    for (let i = 0; i < digits.length; i += 1) {
      const next = digits[i]! * 58 + carry;
      digits[i] = next & 0xff;
      carry = next >> 8;
    }
    while (carry) { digits.push(carry & 0xff); carry >>= 8; }
  }
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === "1") leadingZeroes += 1;
  const result = new Uint8Array(leadingZeroes + digits.length - (digits.length === 1 && digits[0] === 0 ? 1 : 0));
  for (let i = 0; i < digits.length && i < result.length - leadingZeroes; i += 1) result[result.length - 1 - i] = digits[i]!;
  return result;
}

/** Convert a Base58Check P2PKH address to its exact locking script. */
export function p2pkhAddressToScriptHex(address: string, network?: "main" | "test"): string {
  const decoded = base58Decode(address);
  if (decoded.length !== 25) fail("invalid P2PKH address length");
  const version = decoded[0]!;
  if (network && version !== (network === "main" ? 0x00 : 0x6f)) fail("address/network mismatch");
  const payload = decoded.slice(0, 21);
  const checksum = decoded.slice(21);
  const actual = dsha256(payload).slice(0, 4);
  if (bytesToHex(actual) !== bytesToHex(checksum)) fail("invalid address checksum");
  return `76a914${bytesToHex(decoded.slice(1, 21))}88ac`;
}

export function ownedP2pkhOutputs(transaction: ParsedP2pkhTransaction, address: string, network?: "main" | "test") {
  const scriptHex = p2pkhAddressToScriptHex(address, network);
  return transaction.outputs.filter((output) => output.scriptHex === scriptHex);
}

export function base64ToHex(value: string): string {
  if (typeof atob !== "function") throw new Error("Base64 decoder is unavailable");
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return bytesToHex(bytes);
}
