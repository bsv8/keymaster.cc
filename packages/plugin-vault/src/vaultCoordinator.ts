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
  bytesToHex,
  hexToBytes,
  PBKDF2_PARAMS,
  verifyVerifier
} from "./crypto.js";
import type { VaultMetaRecord } from "./storage/vaultKeyRepository.js";

export interface VaultKeyMaterial {
  hex: string;
  wif?: string;
}

export interface VaultMetaInput {
  salt: Uint8Array;
  verifier: Awaited<ReturnType<typeof encryptVerifier>>;
  createdAt?: string;
  cryptoVersion?: "v2";
}

export function buildVaultMeta(input: VaultMetaInput): VaultMetaRecord {
  return {
    id: "singleton",
    saltB64: bytesToHex(input.salt),
    verifierSaltB64: bytesToHex(input.verifier.salt),
    verifierIvB64: bytesToHex(input.verifier.iv),
    verifierCipherB64: bytesToHex(input.verifier.ciphertext),
    createdAt: input.createdAt ?? new Date().toISOString(),
    cryptoVersion: "v2",
    kdf: "pbkdf2-sha256",
    iterations: PBKDF2_PARAMS.iterations,
    keyLengthBits: 256
  };
}

export async function deriveVaultPasswordKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  return deriveKey(password, salt);
}

/** 只接受当前 Vault schema；旧编码和旧 verifier 不进入新桶读取路径。 */
export async function resolveVaultPasswordKey(password: string, meta: VaultMetaRecord): Promise<{ key: CryptoKey }> {
  if (meta.cryptoVersion !== "v2" || meta.kdf !== "pbkdf2-sha256" || meta.iterations !== PBKDF2_PARAMS.iterations || meta.keyLengthBits !== 256) {
    throw new Error("Unsupported Vault schema");
  }
  const salt = hexToBytes(meta.saltB64);
  const verifierSalt = hexToBytes(meta.verifierSaltB64);
  const verifierIv = hexToBytes(meta.verifierIvB64);
  const ciphertext = hexToBytes(meta.verifierCipherB64);
  if (salt.byteLength !== 16 || verifierSalt.byteLength !== 16 || verifierIv.byteLength !== 12 || ciphertext.byteLength < 16) {
    throw new Error("Unsupported Vault schema");
  }
  const key = await deriveVaultPasswordKey(password, salt);
  if (!(await verifyVerifier(key, { salt: verifierSalt, iv: verifierIv, ciphertext }))) throw new Error("Invalid password");
  return { key };
}

/** 保持调用方只需要 key 的现有 API；需解码记录时使用 resolve*。 */
export async function verifyVaultPasswordKey(
  password: string,
  meta: VaultMetaRecord
): Promise<CryptoKey> {
  return (await resolveVaultPasswordKey(password, meta)).key;
}
