// BSV-21 脚本编码器。

const textEncoder = new TextEncoder();
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(input: string): Uint8Array {
  if (input.length === 0) return new Uint8Array(0);
  const bytes = [0];
  for (const ch of input) {
    let carry = BASE58_ALPHABET.indexOf(ch);
    if (carry < 0) throw new Error("Invalid base58 character");
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

function pushData(data: Uint8Array): Uint8Array {
  if (data.length < 0x4c) return Uint8Array.from([data.length, ...data]);
  if (data.length <= 0xff) return Uint8Array.from([0x4c, data.length, ...data]);
  if (data.length <= 0xffff) {
    return Uint8Array.from([0x4d, data.length & 0xff, (data.length >> 8) & 0xff, ...data]);
  }
  return Uint8Array.from([
    0x4e,
    data.length & 0xff,
    (data.length >> 8) & 0xff,
    (data.length >> 16) & 0xff,
    (data.length >> 24) & 0xff,
    ...data
  ]);
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function p2pkhLockScript(address: string): Uint8Array {
  const decoded = base58Decode(address);
  if (decoded.length !== 25) {
    throw new Error("Invalid P2PKH address");
  }
  const hash160 = decoded.slice(1, 21);
  return Uint8Array.from([0x76, 0xa9, 0x14, ...hash160, 0x88, 0xac]);
}

export interface Bsv21Payload {
  p: "bsv-20";
  op: "deploy+mint" | "transfer";
  amt: string;
  sym?: string;
  dec?: number;
  id?: string;
}

export function encodeBsv21Payload(payload: Bsv21Payload): Uint8Array {
  return textEncoder.encode(JSON.stringify(payload));
}

export function buildBsv21P2pkhScript(input: { address: string; payload: Bsv21Payload }): Uint8Array {
  return concatBytes(
    p2pkhLockScript(input.address),
    Uint8Array.from([0x00, 0x63]),
    pushData(textEncoder.encode("ord")),
    Uint8Array.from([0x51]),
    pushData(textEncoder.encode("application/bsv-20")),
    Uint8Array.from([0x00]),
    pushData(encodeBsv21Payload(input.payload)),
    Uint8Array.from([0x68])
  );
}
