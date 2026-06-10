// packages/plugin-key-import/src/importFileSniff.test.ts
// importFileSniff 单测：覆盖 ImportPage 中的 UI 嗅探。
// 设计缘由：sniff 拆出来后必须用真 JSON.parse + 形状判断，
// 不能用字符串精确匹配；任何合法的 JSON 排版都应被正确识别。

import { describe, expect, it } from "vitest";
import { isBsv8KeyEnvelopeShape, peekBsv8Envelope } from "./importFileSniff.js";

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

describe("peekBsv8Envelope", () => {
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
});
