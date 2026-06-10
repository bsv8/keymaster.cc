// packages/plugin-importer-json-file/src/bsv8KeyEnvelope.test.ts
// bsv8 envelope 解密单测：
//   - 同密码可解密 envelope -> 拿到原私钥。
//   - 错误密码报错（不抛明文错误细节）。
//   - 缺少 password 报错。
//   - 错误 AAD 报错。
//   - 字段缺失 / KDF 超限 / nonce 长度错误 -> 报错。
//   - 文件 aad 优先于 fallback；缺 aad 时尝试兼容默认。

import { describe, expect, it } from "vitest";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { argon2id } from "@noble/hashes/argon2.js";
import {
  decryptBsv8KeyEnvelope,
  isBsv8KeyEnvelope,
  type Bsv8EnvelopeShape
} from "./bsv8KeyEnvelope.js";

const VALID_PRIV = "0000000000000000000000000000000000000000000000000000000000000001";

function buildEnvelope(opts: { password: string; aad?: string; privHex?: string }): Bsv8EnvelopeShape {
  const priv = opts.privHex ?? VALID_PRIV;
  const privBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) privBytes[i] = parseInt(priv.substring(i * 2, i * 2 + 2), 16);
  const salt = new Uint8Array(16);
  const nonce = new Uint8Array(24);
  for (let i = 0; i < 16; i++) salt[i] = i + 1;
  for (let i = 0; i < 24; i++) nonce[i] = i + 1;
  const aad = opts.aad ?? "bitfs-keyring|client|default";
  // 单测里使用更小的 KDF 参数（仍符合 bsv8 envelope 形状，但 Argon2id 跑得快）。
  const mem = 8192;
  const tCost = 2;
  const par = 2;
  const key = argon2id(opts.password, salt, {
    m: mem,
    t: tCost,
    p: par,
    dkLen: 32,
    maxmem: 1024 * 1024 * 1024
  });
  const cipher = xchacha20poly1305(key, nonce, new TextEncoder().encode(aad));
  const ct = cipher.encrypt(privBytes);
  return {
    version: "kek-v1",
    key_id: "default",
    kdf: "argon2id",
    kdf_params: {
      memory_kib: mem,
      time_cost: tCost,
      parallelism: par,
      salt_hex: bytesToHex(salt)
    },
    cipher: "xchacha20poly1305",
    nonce_hex: bytesToHex(nonce),
    ciphertext_hex: bytesToHex(ct),
    aad,
    created_at_unix: 1
  };
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}

describe("isBsv8KeyEnvelope", () => {
  it("recognizes bsv8 envelope shape", () => {
    const env = buildEnvelope({ password: "pw" });
    expect(isBsv8KeyEnvelope(env)).toBe(true);
  });

  it("rejects non-bsv8 objects", () => {
    expect(isBsv8KeyEnvelope({})).toBe(false);
    expect(isBsv8KeyEnvelope({ version: "kek-v1" })).toBe(false);
    expect(isBsv8KeyEnvelope(null)).toBe(false);
    expect(isBsv8KeyEnvelope("string")).toBe(false);
  });
});

describe("decryptBsv8KeyEnvelope", () => {
  it("decrypts envelope with correct password and returns same priv", () => {
    const env = buildEnvelope({ password: "correct-horse" });
    const hex = decryptBsv8KeyEnvelope({ envelope: env, password: "correct-horse" });
    expect(hex).toBe(VALID_PRIV);
  });

  it("rejects wrong password", () => {
    const env = buildEnvelope({ password: "correct-horse" });
    expect(() =>
      decryptBsv8KeyEnvelope({ envelope: env, password: "wrong" })
    ).toThrow(/Invalid password|corrupted/i);
  });

  it("rejects empty password", () => {
    const env = buildEnvelope({ password: "x" });
    expect(() => decryptBsv8KeyEnvelope({ envelope: env, password: "" })).toThrow(
      /required/i
    );
  });

  it("rejects mismatched AAD", () => {
    const env = buildEnvelope({ password: "pw", aad: "bitfs-keyring|client|default" });
    // 改写 envelope 的 aad 字段去解密，模拟 AAD 不一致
    const tampered = { ...env, aad: "bitfs-keyring|bitfs|default|kek-v1" };
    expect(() =>
      decryptBsv8KeyEnvelope({ envelope: tampered, password: "pw" })
    ).toThrow(/Invalid password|corrupted/i);
  });

  it("falls back when envelope has no aad", () => {
    const env = buildEnvelope({ password: "fallback" });
    // 移除 aad 字段模拟历史 envelope
    const { aad: _unused, ...withoutAad } = env;
    void _unused;
    const hex = decryptBsv8KeyEnvelope({ envelope: withoutAad, password: "fallback" });
    expect(hex).toBe(VALID_PRIV);
  });

  it("rejects envelope with too-large kdf params", () => {
    const env = buildEnvelope({ password: "x" });
    const tampered: Bsv8EnvelopeShape = {
      ...env,
      kdf_params: { ...env.kdf_params, memory_kib: 999999999 }
    };
    expect(() =>
      decryptBsv8KeyEnvelope({ envelope: tampered, password: "x" })
    ).toThrow(/Unsupported key kdf params/i);
  });

  it("rejects envelope with wrong nonce length", () => {
    const env = buildEnvelope({ password: "x" });
    const tampered: Bsv8EnvelopeShape = { ...env, nonce_hex: "00112233" };
    expect(() =>
      decryptBsv8KeyEnvelope({ envelope: tampered, password: "x" })
    ).toThrow(/24 bytes/i);
  });

  // ---- 私钥范围校验 ----
  // secp256k1 阶 n。解密得到 n 或 n+1 都被拒绝。
  const SECP256K1_N_HEX =
    "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";

  function buildPrivAt(hex: string): string {
    return "00".repeat(32 - hex.length / 2) + hex;
  }

  it("rejects all-zero private key", () => {
    const zero = "00".repeat(32);
    const env = buildEnvelope({ password: "x", privHex: zero });
    expect(() =>
      decryptBsv8KeyEnvelope({ envelope: env, password: "x" })
    ).toThrow(/Invalid password|corrupted/i);
  });

  it("rejects private key === secp256k1 n", () => {
    const env = buildEnvelope({ password: "x", privHex: SECP256K1_N_HEX });
    expect(() =>
      decryptBsv8KeyEnvelope({ envelope: env, password: "x" })
    ).toThrow(/Invalid password|corrupted/i);
  });

  it("rejects private key === secp256k1 n + 1", () => {
    // n+1 的最后两个字节是 41 -> 42，低位进位
    const nPlus1 = buildPrivAt(
      // 把 n 末位 0x41 + 1 = 0x42
      "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364142"
    );
    const env = buildEnvelope({ password: "x", privHex: nPlus1 });
    expect(() =>
      decryptBsv8KeyEnvelope({ envelope: env, password: "x" })
    ).toThrow(/Invalid password|corrupted/i);
  });

  it("falls back to default AAD list when envelope omits aad", () => {
    // 缺 aad 时按 FALLBACK_AADS 列表尝试。仍能解密。
    const env = buildEnvelope({ password: "fallback-2" });
    const { aad: _unused, ...withoutAad } = env;
    void _unused;
    const hex = decryptBsv8KeyEnvelope({ envelope: withoutAad, password: "fallback-2" });
    expect(hex).toBe(VALID_PRIV);
  });
});

describe("isBsv8KeyEnvelope shape", () => {
  it("recognizes bsv8 envelope in pretty JSON (whitespace tolerant)", () => {
    const env = buildEnvelope({ password: "pw" });
    const pretty = JSON.stringify(env, null, 2);
    // 模拟真实落盘文件：用 TextEncoder 重新编码
    const bytes = new TextEncoder().encode(pretty);
    // 解析后仍应被识别
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    expect(isBsv8KeyEnvelope(parsed)).toBe(true);
  });

  it("rejects a plain JSON object that is not bsv8 envelope", () => {
    const plain = { privateKey: "5Hwgr3..." };
    expect(isBsv8KeyEnvelope(plain)).toBe(false);
  });
});
