// packages/plugin-vault/src/vaultCoordinator.test.ts
// Vault coordinator 回归测试。
//
// 关键不变量：
//   - meta 组装必须稳定写入 v2 默认值；
//   - 正确密码能通过 verifier 校验，错误密码必须 fail closed；
//   - 旧 v1 记录迁移后必须升级到 v2 AAD。

import { describe, expect, it, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  bytesToHex,
  deriveKey,
  encryptBytes,
  encryptBytesWithAad,
  encryptVerifier,
  hexToBytes,
  vaultKeyAad
} from "./crypto.js";
import { deriveKeyIdentity } from "./keyIdentity.js";
import type { VaultKeyRecord, VaultMetaRecord } from "./vaultDb.js";
import {
  buildVaultMeta,
  decryptVaultKeyMaterialForMigration,
  encryptVaultKeyMaterial,
  migrateVaultKeysToV2Aad,
  resolveVaultPasswordKey,
  verifyVaultPasswordKey
} from "./vaultCoordinator.js";

const TEST_PRIV_HEX = "0000000000000000000000000000000000000000000000000000000000000001";
const TEST_PUB_HEX = bytesToHex(secp256k1.getPublicKey(hexToBytes(TEST_PRIV_HEX), true));

async function makeMeta(password: string, salt: Uint8Array) {
  const key = await deriveKey(password, salt);
  const verifier = await encryptVerifier(key);
  return { key, verifier, meta: buildVaultMeta({ salt, verifier, createdAt: "2026-07-17T00:00:00.000Z" }) };
}

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

describe("vaultCoordinator", () => {
  it("buildVaultMeta encodes verifier material and defaults to v2", async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const { verifier, meta } = await makeMeta("vault-password", salt);

    expect(meta).toMatchObject({
      id: "singleton",
      cryptoVersion: "v2",
      kdf: "pbkdf2-sha256",
      iterations: 200_000,
      keyLengthBits: 256,
      createdAt: "2026-07-17T00:00:00.000Z"
    });
    expect(meta.saltB64).toBe(bytesToHex(salt));
    expect(meta.verifierSaltB64).toBe(bytesToHex(verifier.salt));
    expect(meta.verifierIvB64).toBe(bytesToHex(verifier.iv));
    expect(meta.verifierCipherB64).toBe(bytesToHex(verifier.ciphertext));
  });

  it("verifyVaultPasswordKey accepts the correct password and rejects the wrong one", async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const { meta } = await makeMeta("vault-password", salt);

    await expect(verifyVaultPasswordKey("vault-password", meta)).resolves.toBeDefined();
    await expect(verifyVaultPasswordKey("wrong-password", meta)).rejects.toThrow("Invalid password");
  });

  it("recognizes old base64 vault material only after its verifier validates", async () => {
    const password = "vault-password";
    const passwordSalt = crypto.getRandomValues(new Uint8Array(16));
    const { key, verifier, meta } = await makeMeta(password, passwordSalt);
    const material = { hex: TEST_PRIV_HEX };
    const blob = await encryptBytesWithAad(
      key,
      new TextEncoder().encode(JSON.stringify(material)),
      vaultKeyAad(TEST_PUB_HEX)
    );
    const legacyMeta: VaultMetaRecord = {
      ...meta,
      saltB64: bytesToBase64(passwordSalt),
      verifierSaltB64: bytesToBase64(verifier.salt),
      verifierIvB64: bytesToBase64(verifier.iv),
      verifierCipherB64: bytesToBase64(verifier.ciphertext)
    };
    const legacyRecord: VaultKeyRecord = {
      publicKeyHex: TEST_PUB_HEX,
      cipherVersion: "v2",
      label: "legacy key",
      address: "",
      network: "main",
      format: "hex",
      capabilities: ["p2pkh"],
      createdAt: "2026-07-17T00:00:00.000Z",
      cipherSaltB64: bytesToBase64(blob.salt),
      cipherIvB64: bytesToBase64(blob.iv),
      cipherB64: bytesToBase64(blob.ciphertext)
    };

    const resolved = await resolveVaultPasswordKey(password, legacyMeta);
    expect(resolved.encoding).toBe("base64");
    await expect(resolveVaultPasswordKey("wrong-password", legacyMeta)).rejects.toThrow("Invalid password");
    await expect(
      decryptVaultKeyMaterialForMigration(resolved.key, legacyRecord, resolved.encoding)
    ).resolves.toEqual(material);
  });

  it("migrateVaultKeysToV2Aad upgrades legacy v1 records to v2 AAD", async () => {
    const passwordSalt = crypto.getRandomValues(new Uint8Array(16));
    const { key: passwordKey, meta: baseMeta } = await makeMeta("vault-password", passwordSalt);
    const legacyMeta: VaultMetaRecord = { ...baseMeta, cryptoVersion: "v1" };
    const material = { hex: TEST_PRIV_HEX };
    const legacyPayload = new TextEncoder().encode(JSON.stringify(material));
    const legacyBlob = await encryptBytes(passwordKey, legacyPayload);
    const legacyRecord: VaultKeyRecord = {
      publicKeyHex: TEST_PUB_HEX,
      cipherVersion: "v1",
      label: "legacy key",
      address: "",
      network: "main",
      format: "hex",
      capabilities: ["p2pkh"],
      createdAt: "2026-07-17T00:00:00.000Z",
      source: "legacy",
      cipherSaltB64: bytesToHex(legacyBlob.salt),
      cipherIvB64: bytesToHex(legacyBlob.iv),
      cipherB64: bytesToHex(legacyBlob.ciphertext)
    };
    const decrypted = await decryptVaultKeyMaterialForMigration(passwordKey, legacyRecord);
    expect(decrypted).toEqual(material);

    const records = [legacyRecord];
    const putMeta = vi.fn(async (_meta: VaultMetaRecord) => undefined);
    const putMetaAndKeys = vi.fn(async (_meta: VaultMetaRecord, _keys: VaultKeyRecord[]) => undefined);
    const encryptRecord = vi.fn(async (publicKeyHex: string, value: { hex: string; wif?: string }) =>
      encryptVaultKeyMaterial(passwordKey, publicKeyHex, value)
    );

    await migrateVaultKeysToV2Aad({
      meta: legacyMeta,
      records,
      decryptRecord: (record) => decryptVaultKeyMaterialForMigration(passwordKey, record),
      encryptRecord,
      putMeta,
      putMetaAndKeys
    });

    expect(putMeta).not.toHaveBeenCalled();
    expect(putMetaAndKeys).toHaveBeenCalledTimes(1);
    const [nextMeta, migratedRecords] = putMetaAndKeys.mock.calls[0] ?? [];
    expect(nextMeta).toMatchObject({
      cryptoVersion: "v2",
      kdf: "pbkdf2-sha256",
      iterations: 200_000,
      keyLengthBits: 256
    });
    expect(migratedRecords).toHaveLength(1);
    expect(migratedRecords?.[0]).toMatchObject({
      publicKeyHex: TEST_PUB_HEX,
      cipherVersion: "v2"
    });

    const migrated = migratedRecords?.[0] as VaultKeyRecord;
    const roundTrip = await decryptVaultKeyMaterialForMigration(passwordKey, migrated);
    expect(roundTrip).toEqual(material);
    expect(encryptRecord).toHaveBeenCalledWith(TEST_PUB_HEX, material);
    expect(deriveKeyIdentity(hexToBytes(roundTrip.hex)).publicKeyHex).toBe(TEST_PUB_HEX);
    expect(migrated.cipherVersion).toBe("v2");
    expect(migrated.cipherSaltB64).toBeDefined();
    expect(migrated.cipherIvB64).toBeDefined();
    expect(migrated.cipherB64).toBeDefined();
    expect(vaultKeyAad(TEST_PUB_HEX)).toContain(TEST_PUB_HEX);
  });
});
