// packages/plugin-vault/src/vaultCoordinator.ts
// Vault 协调层：把密码派生、verifier 校验、正式记录 AAD 升级与密码轮换
// 中的纯协调逻辑收口到一个地方。
//
// 设计缘由：
//   - vaultService 需要保留状态机和 keyspace / messageBus 交互；
//   - 密码校验、meta 组装、AAD 迁移和轮换是可复用的协调逻辑，应该独立
//     出来，便于解锁 / 改密码 / 首启流程共用同一条语义；
//   - 这不是新的持久化持有者，不保存密码根或私钥。

import {
  decryptBytes,
  decryptBytesWithAad,
  deriveKey,
  encryptBytesWithAad,
  encryptVerifier,
  bytesToHex,
  hexToBytes,
  PBKDF2_PARAMS,
  vaultKeyAad,
  verifyVerifier
} from "./crypto.js";
import { deriveKeyIdentity } from "./keyIdentity.js";
import type { VaultKeyRecord, VaultMetaRecord } from "./vaultDb.js";

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

export async function verifyVaultPasswordKey(
  password: string,
  meta: VaultMetaRecord
): Promise<CryptoKey> {
  const salt = hexToBytes(meta.saltB64);
  const key = await deriveVaultPasswordKey(password, salt);
  const ok = await verifyVerifier(key, {
    salt: hexToBytes(meta.verifierSaltB64),
    iv: hexToBytes(meta.verifierIvB64),
    ciphertext: hexToBytes(meta.verifierCipherB64)
  });
  if (!ok) {
    throw new Error("Invalid password");
  }
  return key;
}

export async function encryptVaultKeyMaterial(
  key: CryptoKey,
  publicKeyHex: string,
  material: VaultKeyMaterial
): Promise<{
  cipherVersion: "v2";
  cipherSaltB64: string;
  cipherIvB64: string;
  cipherB64: string;
}> {
  const payload = new TextEncoder().encode(JSON.stringify({ hex: material.hex, wif: material.wif }));
  const blob = await encryptBytesWithAad(key, payload, vaultKeyAad(publicKeyHex));
  return {
    cipherVersion: "v2",
    cipherSaltB64: bytesToHex(blob.salt),
    cipherIvB64: bytesToHex(blob.iv),
    cipherB64: bytesToHex(blob.ciphertext)
  };
}

export async function decryptVaultKeyMaterialForMigration(
  key: CryptoKey,
  record: VaultKeyRecord
): Promise<VaultKeyMaterial> {
  const blob = {
    salt: hexToBytes(record.cipherSaltB64),
    iv: hexToBytes(record.cipherIvB64),
    ciphertext: hexToBytes(record.cipherB64)
  };
  const plain =
    record.cipherVersion === "v2"
      ? await decryptBytesWithAad(key, blob, vaultKeyAad(record.publicKeyHex))
      : await decryptBytes(key, blob);
  const decoded = new TextDecoder().decode(plain);
  const parsed = JSON.parse(decoded) as { hex: string; wif?: string };
  return { hex: parsed.hex, wif: parsed.wif };
}

export async function migrateVaultKeysToV2Aad(input: {
  meta: VaultMetaRecord;
  records: VaultKeyRecord[];
  decryptRecord(record: VaultKeyRecord): Promise<VaultKeyMaterial>;
  encryptRecord(publicKeyHex: string, material: VaultKeyMaterial): Promise<{
    cipherVersion: "v2";
    cipherSaltB64: string;
    cipherIvB64: string;
    cipherB64: string;
  }>;
  putMeta(meta: VaultMetaRecord): Promise<void>;
  putMetaAndKeys(meta: VaultMetaRecord, records: VaultKeyRecord[]): Promise<void>;
}): Promise<void> {
  if (input.meta.cryptoVersion === "v2") {
    return;
  }
  const migratedRecords: VaultKeyRecord[] = [];
  let needsWrite = false;
  for (const record of input.records) {
    const material = await input.decryptRecord(record);
    const identity = deriveKeyIdentity(hexToBytes(material.hex));
    if (identity.publicKeyHex !== record.publicKeyHex) {
      throw new Error(
        `vault key ${record.publicKeyHex} failed identity verification during v2 migration`
      );
    }
    const encoded = await input.encryptRecord(record.publicKeyHex, material);
    migratedRecords.push({ ...record, ...encoded });
    if (record.cipherVersion !== "v2") {
      needsWrite = true;
    }
  }
  const nextMeta: VaultMetaRecord = {
    ...input.meta,
    cryptoVersion: "v2",
    kdf: "pbkdf2-sha256",
    iterations: PBKDF2_PARAMS.iterations,
    keyLengthBits: 256
  };
  if (!needsWrite) {
    await input.putMeta(nextMeta);
    return;
  }
  await input.putMetaAndKeys(nextMeta, migratedRecords);
}
