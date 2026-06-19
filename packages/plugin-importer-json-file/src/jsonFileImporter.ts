// packages/plugin-importer-json-file/src/jsonFileImporter.ts
// 解析 BSV 通用钱包导出的 JSON 格式（handcash/moneybutton/relayx 等），
// 同时支持 bsv8 加密 JSON envelope（keK-v1 / argon2id / xchacha20poly1305）。
// 设计缘由：
//   - 每种 wallet 的 JSON 字段都不同，但都包含私钥或 WIF，我们只挑出 hex/wif 字段。
//   - bsv8 envelope 是加密 JSON，必须走 bsv8 解密逻辑，不能和普通 JSON 一起递归扫描，
//     否则 ciphertext_hex / salt_hex / nonce_hex 会被误判为私钥候选。
//   - importer 插件不写 Vault、不调用 vault.withPrivateKey —— bsv8 envelope 解密
//     成功后返回标准 PrivateKeyMaterial，交给调用方保存。
// 解析失败时只返回格式错误，不写任何 DB（DB 写入由 vault 完成）。
//
// 硬切换 012（施工单 001）：本 importer 同时支持 text 与 file 两种输入，
// 共享同一套解析路径；`password` 是输入的属性，文本与文件都可能携带。

import type { KeyImporter, KeyImportInput, KeyImportResult } from "@keymaster/contracts";
import { decryptBsv8KeyEnvelope, isBsv8KeyEnvelope, type Bsv8EnvelopeShape } from "./bsv8KeyEnvelope.js";

interface JsonCandidate {
  /** 字段路径数组，便于错误提示。 */
  path: string[];
  /** 32 字节 hex。 */
  hex: string;
  /** 原始 WIF（如果原文件提供）。 */
  wif?: string;
}

const HEX_RE = /^[0-9a-fA-F]{64}$/;

// bsv8 envelope 不应被误判为私钥候选的字段名。
// 这些字段内容是 hex 字符串，但语义是 KDF salt / AEAD nonce / ciphertext。
// 普通 JSON importer 递归扫描时直接跳过它们。
const ENVELOPE_FIELD_NAMES = new Set([
  "salt_hex",
  "nonce_hex",
  "ciphertext_hex",
  "memory_kib",
  "time_cost",
  "parallelism"
]);

function dig(obj: unknown, path: string[] = []): JsonCandidate[] {
  if (!obj || typeof obj !== "object") return [];
  const out: JsonCandidate[] = [];
  const record = obj as Record<string, unknown>;
  for (const [k, v] of Object.entries(record)) {
    const here = [...path, k];
    if (ENVELOPE_FIELD_NAMES.has(k)) continue;
    if (typeof v === "string") {
      const trimmed = v.trim();
      if (HEX_RE.test(trimmed)) {
        out.push({ path: here, hex: trimmed.toLowerCase() });
      } else if (/^5[HJK][1-9A-HJ-NP-Za-km-z]{49}$/.test(trimmed) || trimmed.startsWith("L") || trimmed.startsWith("K")) {
        // 启发式 WIF：以 5/K/L 开头且长度 51-52。
        out.push({ path: here, hex: "", wif: trimmed });
      }
    } else if (v && typeof v === "object") {
      out.push(...dig(v, here));
    }
  }
  return out;
}

/**
 * 把任意 `KeyImportInput` 归一化为 JSON 字符串。
 * 设计缘由：JSON 文件与 JSON 文本本质上是同一种导入材料，只是来源不同；
 * 解析时不应该走两条分支。下游所有逻辑（JSON.parse / envelope 判断 / dig）
 * 都基于这串文本，不关心来源。
 */
function readInputText(input: KeyImportInput): string {
  if (input.kind === "text") return input.text;
  return new TextDecoder().decode(input.content);
}

export const jsonFileImporter: KeyImporter = {
  id: "json-file",
  // 硬切换 012：名称回归为更准确的 "JSON"，因为 importer 已经支持
  // text + file 两种来源；继续叫 "JSON File" 会和"支持 JSON 文本"直接冲突。
  name: { key: "importerJsonFile.name", fallback: "JSON" },
  description: {
    key: "importerJsonFile.description",
    fallback: "Extract private keys from a wallet JSON export; supports JSON files, JSON text, and bsv8 encrypted envelopes."
  },
  // 硬切换 012：同时支持 text 与 file。两条入口都共用同一套输入模式切换
  // 与解析逻辑，不再区分 "json-file" 与 "json-text"。
  supports: ["text", "file"],
  // 是否需要"导入源密码"取决于输入本身——明文 JSON 走 dig(parsed) 不需要，
  // bsv8 envelope 才需要。**不**在 importer 级静态声明"需要密码"，
  // 让调用方通过 parse() 的实际行为判断（失败时抛
  // "Password is required for encrypted key file"）。
  async parse(input: KeyImportInput): Promise<KeyImportResult[]> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readInputText(input));
    } catch (err) {
      throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    // bsv8 envelope 必须走专用解密逻辑；不能用普通递归扫描去找 hex。
    if (isBsv8KeyEnvelope(parsed)) {
      const envelope = parsed as Bsv8EnvelopeShape;
      const password = input.password;
      if (!password) {
        // 文案虽然包含 "file"，本次先保持不变以不破坏既有 UI 与测试常量；
        // 未来若改成更中性的 "encrypted key JSON"，必须同步两个入口和测试。
        throw new Error("Password is required for encrypted key file");
      }
      const hex = decryptBsv8KeyEnvelope({ envelope, password });
      return [
        {
          material: { hex },
          address: "",
          network: "main",
          detectedFormat: "bsv8-key-envelope",
          summary: { key: "importerJsonFile.summary.envelope", fallback: "bsv8 encrypted key envelope" }
        }
      ];
    }
    const candidates = dig(parsed);
    if (candidates.length === 0) {
      throw new Error("No private key candidates found in JSON");
    }
    return candidates.map((c) => ({
      material: { hex: c.hex, wif: c.wif },
      address: "",
      network: "main",
      detectedFormat: "json-file",
      summary: {
        key: "importerJsonFile.summary.field",
        fallback: "Field: ",
        values: { path: c.path.join(".") }
      }
    }));
  }
};