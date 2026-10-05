// packages/plugin-vault/src/import/hexImporter.ts
// 解析 32 字节 hex 私钥。
// 设计缘由：importer 只能输出标准导入材料，不假设网络（由调用方决定）。


import type { KeyImporter, KeyImportInput, KeyImportResult } from "./types.js";

const HEX_RE = /^[0-9a-fA-F]{64}$/;

export const hexImporter: KeyImporter = {
  id: "hex",
  name: { key: "vault.importerHex.name", fallback: "Hex" },
  description: { key: "vault.importerHex.description", fallback: "32-byte hex private key." },
  supports: ["text"],
  async parse(input: KeyImportInput): Promise<KeyImportResult[]> {
    if (input.kind !== "text") throw new Error("Hex importer only supports text input");
    const text = input.text.trim().replace(/^0x/, "");
    if (!HEX_RE.test(text)) {
      throw new Error("Hex must be 64 hex characters (32 bytes)");
    }
    return [
      {
        material: { hex: text.toLowerCase() },
        address: "",
        network: "main",
        detectedFormat: "hex",
        summary: { key: "vault.importerHex.summary", fallback: "32-byte hex private key" }
      }
    ];
  }
};
