// packages/plugin-vault/src/p2pkhAddress.ts
// 本地 P2PKH 地址派生：避免 vault 反向依赖 plugin-p2pkh。

import { ripemd160 } from "@noble/hashes/ripemd160";
import { sha256 } from "@noble/hashes/sha256";

export function publicKeyHexToP2pkhAddress(
  publicKeyHex: string,
  network: "main" | "test" = "main"
): string {
  const pub = hexToBytes(publicKeyHex);
  if (pub.length !== 33) {
    throw new Error("Public key must be 33 bytes (compressed)");
  }
  const sha = sha256(pub);
  const ripe = ripemd160(sha);
  const versionByte = network === "main" ? 0x00 : 0x6f;
  const payload = concatBytes(new Uint8Array([versionByte]), ripe);
  const checksum = sha256(sha256(payload)).slice(0, 4);
  return base58Encode(concatBytes(payload, checksum));
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "").trim().toLowerCase();
  if (clean.length % 2 !== 0) throw new Error("Invalid hex length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

function base58Encode(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let x = BigInt("0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""));
  let out = "";
  while (x > 0n) {
    const mod = Number(x % 58n);
    out = alphabet[mod] + out;
    x /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) out = "1" + out;
    else break;
  }
  return out || "1";
}
