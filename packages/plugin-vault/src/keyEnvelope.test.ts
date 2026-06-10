// packages/plugin-vault/src/keyEnvelope.test.ts
// 私钥 envelope 加密单测：
//   - 加密产物字段齐全、snake_case。
//   - 同一私钥加密后 cipher/salt/nonce 每次都不同。
//   - 缺密码 / 缺私钥 / 错误长度报错。
//   - 加密结果能被手工构造的解密器（与 jsonFileImporter 同源 bsv8 envelope）解回。
//
// 设计缘由：vault 测试不依赖 plugin-importer-json-file，避免包间循环 import；
// round-trip 解密逻辑在 plugin-importer-json-file 自己的 bsv8KeyEnvelope.test.ts
// 覆盖。这里只做"加密出来的 envelope 形状" + 静态格式断言。

import { describe, expect, it } from "vitest";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { argon2id } from "@noble/hashes/argon2.js";
import { encryptBsv8KeyEnvelope } from "./keyEnvelope.js";

const VALID_PRIV = "0000000000000000000000000000000000000000000000000000000000000001";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}

describe("encryptBsv8KeyEnvelope", () => {
  it("produces a bsv8-shaped envelope with snake_case fields", { timeout: 30_000 }, () => {
    const env = encryptBsv8KeyEnvelope(VALID_PRIV, "backup-pw");
    expect(env.version).toBe("kek-v1");
    expect(env.key_id).toBe("default");
    expect(env.kdf).toBe("argon2id");
    expect(env.cipher).toBe("xchacha20poly1305");
    expect(env.kdf_params.memory_kib).toBe(65536);
    expect(env.kdf_params.time_cost).toBe(3);
    expect(env.kdf_params.parallelism).toBe(4);
    expect(env.kdf_params.salt_hex).toMatch(/^[0-9a-f]{32}$/);
    expect(env.nonce_hex).toMatch(/^[0-9a-f]{48}$/);
    // 32 字节私钥 + 16 字节 tag = 48 字节
    expect(env.ciphertext_hex).toMatch(/^[0-9a-f]{96}$/);
    expect(env.aad).toBe("bitfs-keyring|client|default");
    expect(env.pubkey_hex).toMatch(/^[0-9a-f]{66}$/); // compressed pubkey 33 bytes
    expect(typeof env.created_at_unix).toBe("number");
  });

  it("produces a fresh salt/nonce/ciphertext each call", { timeout: 60_000 }, () => {
    const a = encryptBsv8KeyEnvelope(VALID_PRIV, "pw");
    const b = encryptBsv8KeyEnvelope(VALID_PRIV, "pw");
    expect(a.kdf_params.salt_hex).not.toBe(b.kdf_params.salt_hex);
    expect(a.nonce_hex).not.toBe(b.nonce_hex);
    expect(a.ciphertext_hex).not.toBe(b.ciphertext_hex);
  });

  it("round-trips with a manually-built decryptor using same primitives", { timeout: 30_000 }, () => {
    const env = encryptBsv8KeyEnvelope(VALID_PRIV, "round-trip");
    const salt = hexToBytes(env.kdf_params.salt_hex);
    const nonce = hexToBytes(env.nonce_hex);
    const ct = hexToBytes(env.ciphertext_hex);
    const key = argon2id("round-trip", salt, {
      m: env.kdf_params.memory_kib,
      t: env.kdf_params.time_cost,
      p: env.kdf_params.parallelism,
      dkLen: 32,
      maxmem: 1024 * 1024 * 1024
    });
    const plain = xchacha20poly1305(key, nonce, new TextEncoder().encode(env.aad)).decrypt(ct);
    expect(plain.length).toBe(32);
    expect(bytesToHex(plain)).toBe(VALID_PRIV);
  });

  it("requires backup password", () => {
    expect(() => encryptBsv8KeyEnvelope(VALID_PRIV, "")).toThrow(/Backup password/i);
  });

  it("requires private key", () => {
    expect(() => encryptBsv8KeyEnvelope("", "pw")).toThrow(/Private key/i);
  });

  it("rejects private key with wrong length", () => {
    expect(() => encryptBsv8KeyEnvelope("aabbcc", "pw")).toThrow(/32 bytes/);
  });

  // ---- 私钥范围校验 ----
  // secp256k1 阶 n；全 0、n、n+1 都不能导出。最大合法值 n-1 可以导出。
  const SECP256K1_N_HEX =
    "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";
  const SECP256K1_N_MINUS_1 =
    "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140";

  it("rejects all-zero private key", () => {
    const zero = "00".repeat(32);
    expect(() => encryptBsv8KeyEnvelope(zero, "pw")).toThrow(/Invalid secp256k1/i);
  });

  it("rejects private key === secp256k1 n", () => {
    expect(() => encryptBsv8KeyEnvelope(SECP256K1_N_HEX, "pw")).toThrow(
      /Invalid secp256k1/i
    );
  });

  it("rejects private key === secp256k1 n + 1", () => {
    const nPlus1 = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364142";
    expect(() => encryptBsv8KeyEnvelope(nPlus1, "pw")).toThrow(/Invalid secp256k1/i);
  });

  it("accepts the largest legal private key n - 1", { timeout: 30_000 }, () => {
    const env = encryptBsv8KeyEnvelope(SECP256K1_N_MINUS_1, "pw");
    expect(env.version).toBe("kek-v1");
    expect(env.ciphertext_hex).toMatch(/^[0-9a-f]{96}$/);
  });
});
