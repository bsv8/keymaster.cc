// 1Sat Ordinals 脚本编码器。

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
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
  if (data.length < 0x4c) {
    return Uint8Array.from([data.length, ...data]);
  }
  if (data.length <= 0xff) {
    return Uint8Array.from([0x4c, data.length, ...data]);
  }
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

function isP2pkhPrefix(script: Uint8Array): boolean {
  return (
    script.length >= 25 &&
    script[0] === 0x76 &&
    script[1] === 0xa9 &&
    script[2] === 0x14 &&
    script[23] === 0x88 &&
    script[24] === 0xac
  );
}

function findOrdinalEnvelopeStart(script: Uint8Array): number {
  for (let i = 25; i <= script.length - 7; i++) {
    if (
      script[i] === 0x00 &&
      script[i + 1] === 0x63 &&
      script[i + 2] === 0x03 &&
      script[i + 3] === 0x6f &&
      script[i + 4] === 0x72 &&
      script[i + 5] === 0x64 &&
      script[i + 6] === 0x51
    ) {
      return i;
    }
  }
  return -1;
}

export interface OrdinalEnvelopeEntry {
  key: string;
  value: string;
}

export function encodeOrdinalEnvelope(input: {
  contentType: string;
  data: Uint8Array;
  metadata?: OrdinalEnvelopeEntry[];
}): Uint8Array {
  const parts: Uint8Array[] = [
    Uint8Array.from([0x00, 0x63]),
    pushData(textEncoder.encode("ord")),
    Uint8Array.from([0x51]),
    pushData(textEncoder.encode(input.contentType)),
    Uint8Array.from([0x00]),
    pushData(input.data)
  ];
  for (const entry of input.metadata ?? []) {
    parts.push(pushData(textEncoder.encode(entry.key)));
    parts.push(pushData(textEncoder.encode(entry.value)));
  }
  parts.push(Uint8Array.from([0x68]));
  return concatBytes(...parts);
}

export function buildOrdinalP2pkhScript(input: {
  address: string;
  contentType: string;
  data: Uint8Array;
  metadata?: OrdinalEnvelopeEntry[];
}): Uint8Array {
  return concatBytes(
    p2pkhLockScript(input.address),
    encodeOrdinalEnvelope({ contentType: input.contentType, data: input.data, metadata: input.metadata })
  );
}

export function replaceOrdinalP2pkhRecipient(sourceScript: Uint8Array, recipientAddress: string): Uint8Array {
  if (!isP2pkhPrefix(sourceScript)) {
    throw new Error("Ordinal transfer requires a P2PKH source script");
  }
  const envelopeStart = findOrdinalEnvelopeStart(sourceScript);
  if (envelopeStart < 0) {
    throw new Error("Ordinal transfer source script is missing ord envelope");
  }
  const recipientPrefix = p2pkhLockScript(recipientAddress);
  return concatBytes(recipientPrefix, sourceScript.slice(envelopeStart));
}

export function decodeOrdinalEnvelope(script: Uint8Array): {
  contentType?: string;
  data?: Uint8Array;
  metadata: OrdinalEnvelopeEntry[];
} {
  const bytes = [...script];
  const ord = textEncoder.encode("ord");
  const ordIndex = findSubsequence(bytes, [...ord]);
  if (ordIndex < 0) return { metadata: [] };
  const contentTypeStart = ordIndex + ord.length + 2;
  const contentTypeLength = bytes[contentTypeStart - 1];
  const contentType = contentTypeLength !== undefined
    ? textDecoder.decode(new Uint8Array(bytes.slice(contentTypeStart, contentTypeStart + contentTypeLength)))
    : undefined;
  const dataMarker = contentTypeStart + (contentTypeLength ?? 0) + 1;
  const dataLength = bytes[dataMarker - 1];
  const data = dataLength !== undefined
    ? new Uint8Array(bytes.slice(dataMarker, dataMarker + dataLength))
    : undefined;
  return { contentType, data, metadata: [] };
}

function findSubsequence(haystack: number[], needle: number[]): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
