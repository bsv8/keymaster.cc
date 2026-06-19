// packages/plugin-key-import/src/importFileSniff.test.ts
// importFileSniff 单测：覆盖 ImportPage / FirstTimeImportWizard 中的 UI 嗅探。
// 设计缘由：sniff 拆出来后必须用真 JSON.parse + 形状判断，
// 不能用字符串精确匹配；任何合法的 JSON 排版都应被正确识别。
//
// 硬切换 012：增加文本嗅探路径测试，确保文件 / 文本共用同一套形状判断。

import { describe, expect, it } from "vitest";
import {
  isBsv8KeyEnvelopeShape,
  peekBsv8Envelope,
  peekBsv8EnvelopeBytes,
  peekBsv8EnvelopeText
} from "./importFileSniff.js";

const ENVELOPE = {
  version: "kek-v1",
  key_id: "default",
  kdf: "argon2id",
  kdf_params: {
    memory_kib: 65536,
    time_cost: 3,
    parallelism: 4,
    salt_hex: "00".repeat(16)
  },
  cipher: "xchacha20poly1305",
  nonce_hex: "00".repeat(24),
  ciphertext_hex: "00".repeat(96),
  aad: "bitfs-keyring|client|default"
};

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("isBsv8KeyEnvelopeShape", () => {
  it("recognizes bsv8 envelope", () => {
    expect(isBsv8KeyEnvelopeShape(ENVELOPE)).toBe(true);
  });

  it("rejects non-envelope objects", () => {
    expect(isBsv8KeyEnvelopeShape({})).toBe(false);
    expect(isBsv8KeyEnvelopeShape(null)).toBe(false);
    expect(isBsv8KeyEnvelopeShape("string")).toBe(false);
    expect(isBsv8KeyEnvelopeShape(42)).toBe(false);
  });

  it("rejects envelope missing required fields", () => {
    const missingCipher = { ...ENVELOPE, cipher: "aes-gcm" };
    expect(isBsv8KeyEnvelopeShape(missingCipher)).toBe(false);
  });
});

describe("peekBsv8EnvelopeBytes (硬切换 010 既有回归)", () => {
  it("recognizes pretty JSON (whitespace tolerant)", () => {
    const pretty = JSON.stringify(ENVELOPE, null, 2);
    expect(peekBsv8Envelope(encode(pretty))).toBe(true);
  });

  it("recognizes compact JSON (no whitespace)", () => {
    const compact = JSON.stringify(ENVELOPE);
    expect(peekBsv8Envelope(encode(compact))).toBe(true);
  });

  it("rejects plain JSON that is not bsv8 envelope", () => {
    const plain = JSON.stringify({ privateKey: "5Hwgr3..." });
    expect(peekBsv8Envelope(encode(plain))).toBe(false);
  });

  it("rejects invalid JSON", () => {
    expect(peekBsv8Envelope(encode("not json"))).toBe(false);
    expect(peekBsv8Envelope(encode(""))).toBe(false);
  });

  it("rejects non-JSON binary garbage", () => {
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
    expect(peekBsv8Envelope(garbage)).toBe(false);
  });

  it("bytes alias returns the same result as the canonical bytes API", () => {
    const pretty = JSON.stringify(ENVELOPE, null, 2);
    expect(peekBsv8EnvelopeBytes(encode(pretty))).toBe(
      peekBsv8Envelope(encode(pretty))
    );
  });
});

describe("peekBsv8EnvelopeText (硬切换 012 新增)", () => {
  it("recognizes pretty JSON text", () => {
    const pretty = JSON.stringify(ENVELOPE, null, 2);
    expect(peekBsv8EnvelopeText(pretty)).toBe(true);
  });

  it("recognizes compact JSON text", () => {
    const compact = JSON.stringify(ENVELOPE);
    expect(peekBsv8EnvelopeText(compact)).toBe(true);
  });

  it("rejects plain JSON text that is not bsv8 envelope", () => {
    const plain = JSON.stringify({ wallet: "handcash", privateKey: "5Hwgr3..." });
    expect(peekBsv8EnvelopeText(plain)).toBe(false);
  });

  it("rejects invalid JSON text", () => {
    expect(peekBsv8EnvelopeText("not json")).toBe(false);
    expect(peekBsv8EnvelopeText("")).toBe(false);
    expect(peekBsv8EnvelopeText("{version: 'kek-v1'}")).toBe(false);
  });

  it("rejects plain text that is not even JSON", () => {
    expect(peekBsv8EnvelopeText("hello world")).toBe(false);
    expect(peekBsv8EnvelopeText("0xdeadbeef")).toBe(false);
  });

  it("text sniff agrees with bytes sniff on the same JSON string", () => {
    const pretty = JSON.stringify(ENVELOPE, null, 2);
    expect(peekBsv8EnvelopeText(pretty)).toBe(peekBsv8Envelope(encode(pretty)));
    const compact = JSON.stringify(ENVELOPE);
    expect(peekBsv8EnvelopeText(compact)).toBe(peekBsv8Envelope(encode(compact)));
  });
});