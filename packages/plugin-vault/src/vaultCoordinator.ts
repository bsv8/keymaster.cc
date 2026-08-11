// packages/plugin-vault/src/vaultCoordinator.ts
// Vault 协调层：把密码派生、verifier 校验与密码轮换
// 中的纯协调逻辑收口到一个地方。
//
// 设计缘由：
//   - vaultService 需要保留状态机和 keyspace / messageBus 交互；
//   - 密码校验、meta 组装和轮换是可复用的协调逻辑，应该独立
//     出来，便于解锁 / 改密码 / 首启流程共用同一条语义；
//   - 这不是新的持久化持有者，不保存密码根或私钥。

import {
  deriveKey,
  encryptVerifier,
  base64ToBytes,
  bytesToHex,
  hexToBytes,
  PBKDF2_PARAMS,
  verifyLegacyVerifier,
  verifyVerifier
} from "./crypto.js";
import type { VaultMetaRecord } from "./vaultDb.js";

export interface VaultKeyMaterial {
  hex: string;
  wif?: string;
}

export interface VaultMetaInput {
  salt: Uint8Array;
  verifier: Awaited<ReturnType<typeof encryptVerifier>>;
  createdAt?: string;
  cryptoVersion?: "v1" | "v2";
}

/** 持久化二进制字段的历史编码。新格式固定 hex；旧版为实际 base64。 */
export type VaultBinaryEncoding = "hex" | "base64";
/** verifier 的加密语义版本。 */
export type VaultVerifierVersion = "v1" | "v2";

export interface VerifiedVaultPasswordKey {
  key: CryptoKey;
  encoding: VaultBinaryEncoding;
  verifierVersion: VaultVerifierVersion;
}

function decodeVaultBytes(value: string, encoding: VaultBinaryEncoding): Uint8Array {
  return encoding === "hex" ? hexToBytes(value) : base64ToBytes(value);
}

export function buildVaultMeta(input: VaultMetaInput): VaultMetaRecord {
  return {
    id: "singleton",
    saltB64: bytesToHex(input.salt),
    verifierSaltB64: bytesToHex(input.verifier.salt),
    verifierIvB64: bytesToHex(input.verifier.iv),
    verifierCipherB64: bytesToHex(input.verifier.ciphertext),
    createdAt: input.createdAt ?? new Date().toISOString(),
    cryptoVersion: input.cryptoVersion ?? "v2",
    kdf: "pbkdf2-sha256",
    iterations: PBKDF2_PARAMS.iterations,
    keyLengthBits: 256
  };
}

export async function deriveVaultPasswordKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  return deriveKey(password, salt);
}

/**
 * 通过 verifier 探测历史二进制编码与 verifier 加密版本。
 *
 * 不根据字符串外观猜测编码：Base64 完全可能只包含 hex 字符。每种候选
 * 都必须用密码派生出的 key 成功解开 verifier，才能被接受。
 */
export async function resolveVaultPasswordKey(
  password: string,
  meta: VaultMetaRecord
): Promise<VerifiedVaultPasswordKey> {
  for (const encoding of ["hex", "base64"] as const) {
    try {
      const salt = decodeVaultBytes(meta.saltB64, encoding);
      // Vault password salt has always been 16 bytes. This also prevents a
      // malformed alternate representation from reaching PBKDF2.
      if (salt.byteLength !== 16) continue;
      const key = await deriveVaultPasswordKey(password, salt);
      const verifier = {
        salt: decodeVaultBytes(meta.verifierSaltB64, encoding),
        iv: decodeVaultBytes(meta.verifierIvB64, encoding),
        ciphertext: decodeVaultBytes(meta.verifierCipherB64, encoding)
      };
      if (await verifyVerifier(key, verifier)) return { key, encoding, verifierVersion: "v2" };
      if (await verifyLegacyVerifier(key, verifier)) {
        return { key, encoding, verifierVersion: "v1" };
      }
    } catch {
      // Try the other historic representation. The verifier remains the sole
      // authority: malformed data and a wrong password both fail closed below.
    }
  }
  throw new Error("Invalid password");
}

/** 保持调用方只需要 key 的现有 API；需解码记录时使用 resolve*。 */
export async function verifyVaultPasswordKey(
  password: string,
  meta: VaultMetaRecord
): Promise<CryptoKey> {
  return (await resolveVaultPasswordKey(password, meta)).key;
}
