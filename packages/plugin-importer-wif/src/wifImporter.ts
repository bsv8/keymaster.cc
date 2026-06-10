// packages/plugin-importer-wif/src/wifImporter.ts
// WIF 解析：把 WIF 字符串解出 32 字节 hex 私钥。
// 设计缘由：importer 只能输出标准 PrivateKeyMaterial，禁止写 Vault。
// 这里 inline 了一份最小 WIF 解码，避免跨 plugin 互相 import。

import type { KeyImporter, KeyImportInput, KeyImportResult } from "@keymaster/contracts";

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
    let c = carry;
    while (c > 0) {
      bytes.push(c & 0xff);
      c = (c / 256) | 0;
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

async function sha256d(data: Uint8Array): Promise<Uint8Array> {
  const first = new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
  return new Uint8Array(await crypto.subtle.digest("SHA-256", first as BufferSource));
}

async function wifToPrivateKey(wif: string): Promise<{ hex: string; network: "main" | "test"; compressed: boolean }> {
  const decoded = base58Decode(wif);
  if (decoded.length < 37 || decoded.length > 38) throw new Error("Invalid WIF length");
  const expectedChecksum = decoded.subarray(decoded.length - 4);
  const body = decoded.subarray(0, decoded.length - 4);
  const hash = await sha256d(body);
  for (let i = 0; i < 4; i++) {
    if (hash[i] !== expectedChecksum[i]) throw new Error("Invalid WIF checksum");
  }
  const version = body[0];
  const network: "main" | "test" = version === 0x80 ? "main" : "test";
  const compressed = body.length === 34 && body[33] === 0x01;
  const keyBytes = body.subarray(1, 33);
  if (keyBytes.length !== 32) throw new Error("Invalid key length");
  const hex = Array.from(keyBytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return { hex, network, compressed };
}

export const wifImporter: KeyImporter = {
  id: "wif",
  // 名称与描述为 I18nText：WIF 字面量稳定，仍可走 I18nText 表达。
  name: { key: "importerWif.name", fallback: "WIF" },
  description: { key: "importerWif.description", fallback: "Paste a BSV WIF private key (Base58Check encoded)." },
  supports: ["text"],
  async parse(input: KeyImportInput): Promise<KeyImportResult[]> {
    if (input.kind !== "text") throw new Error("WIF importer only supports text input");
    const text = input.text.trim();
    const { hex, network, compressed } = await wifToPrivateKey(text);
    return [
      {
        material: { hex, wif: text },
        address: "", // P2PKH 插件会监听 key.imported 并回填。
        network,
        // detectedFormat 是稳定业务 code，不翻译；UI 层走 i18n key 二次翻译。
        detectedFormat: compressed ? `wif-${network}-compressed` : `wif-${network}`,
        summary: compressed
          ? { key: "importerWif.summary.compressed", fallback: "Compressed WIF" }
          : { key: "importerWif.summary.uncompressed", fallback: "Uncompressed WIF" }
      }
    ];
  }
};
