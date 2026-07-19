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
  base64ToBytes,
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

/** 持久化二进制字段的历史编码。新格式固定 hex；旧版为实际 base64。 */
export type VaultBinaryEncoding = "hex" | "base64";

export interface VerifiedVaultPasswordKey {
  key: CryptoKey;
  encoding: VaultBinaryEncoding;
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
 * 通过 verifier 探测历史二进制编码。
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
      const ok = await verifyVerifier(key, {
        salt: decodeVaultBytes(meta.verifierSaltB64, encoding),
        iv: decodeVaultBytes(meta.verifierIvB64, encoding),
        ciphertext: decodeVaultBytes(meta.verifierCipherB64, encoding)
      });
      if (ok) return { key, encoding };
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
  record: VaultKeyRecord,
  encoding: VaultBinaryEncoding = "hex"
): Promise<VaultKeyMaterial> {
  const blob = {
    salt: decodeVaultBytes(record.cipherSaltB64, encoding),
    iv: decodeVaultBytes(record.cipherIvB64, encoding),
    ciphertext: decodeVaultBytes(record.cipherB64, encoding)
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
  /** 旧 base64 编码即使已经是 v2，也必须重加密为当前 hex 格式。 */
  forceReencrypt?: boolean;
  /** 把旧 meta 的 base64 二进制字段一并改写为当前 hex 格式。 */
  sourceEncoding?: VaultBinaryEncoding;
}): Promise<void> {
  if (input.meta.cryptoVersion === "v2" && !input.forceReencrypt) {
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
    if (record.cipherVersion !== "v2" || input.forceReencrypt) {
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
  if (input.sourceEncoding === "base64") {
    nextMeta.saltB64 = bytesToHex(decodeVaultBytes(input.meta.saltB64, input.sourceEncoding));
    nextMeta.verifierSaltB64 = bytesToHex(
      decodeVaultBytes(input.meta.verifierSaltB64, input.sourceEncoding)
    );
    nextMeta.verifierIvB64 = bytesToHex(
      decodeVaultBytes(input.meta.verifierIvB64, input.sourceEncoding)
    );
    nextMeta.verifierCipherB64 = bytesToHex(
      decodeVaultBytes(input.meta.verifierCipherB64, input.sourceEncoding)
    );
  }
  if (!needsWrite) {
    await input.putMeta(nextMeta);
    return;
  }
  await input.putMetaAndKeys(nextMeta, migratedRecords);
}
