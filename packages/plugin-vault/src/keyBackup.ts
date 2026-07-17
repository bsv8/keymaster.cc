// packages/plugin-vault/src/keyBackup.ts
// 单 Key 备份格式：只保存 vault_meta + 选中的 canonical vault_keys 记录。

import type { VaultKeyRecord, VaultMetaRecord } from "./vaultDb.js";

export const KEY_BACKUP_VERSION = 1 as const;

export interface KeyBackupEnvelope {
  backupVersion: typeof KEY_BACKUP_VERSION;
  sourceVaultMeta: VaultMetaRecord;
  keyRecord: VaultKeyRecord;
}

export function encodeKeyBackup(envelope: KeyBackupEnvelope): string {
  validateKeyBackupEnvelope(envelope);
  return JSON.stringify(envelope);
}

export function decodeKeyBackup(payload: string): KeyBackupEnvelope {
  const parsed = JSON.parse(payload) as unknown;
  validateKeyBackupEnvelope(parsed);
  return parsed;
}

export function validateKeyBackupEnvelope(value: unknown): asserts value is KeyBackupEnvelope {
  if (!value || typeof value !== "object") {
    throw new Error("Key backup payload must be an object");
  }
  const v = value as Record<string, unknown>;
  if (v.backupVersion !== KEY_BACKUP_VERSION) {
    throw new Error(`Unsupported key backup version: ${String(v.backupVersion)}`);
  }
  if (!v.sourceVaultMeta || typeof v.sourceVaultMeta !== "object") {
    throw new Error("Key backup sourceVaultMeta is missing");
  }
  if (!v.keyRecord || typeof v.keyRecord !== "object") {
    throw new Error("Key backup keyRecord is missing");
  }
  const meta = v.sourceVaultMeta as Record<string, unknown>;
  const record = v.keyRecord as Record<string, unknown>;
  if (meta.id !== "singleton") throw new Error("Key backup sourceVaultMeta.id must be singleton");
  if (typeof meta.saltB64 !== "string" || meta.saltB64.length === 0) {
    throw new Error("Key backup sourceVaultMeta.saltB64 missing");
  }
  if (typeof record.publicKeyHex !== "string" || record.publicKeyHex.length === 0) {
    throw new Error("Key backup keyRecord.publicKeyHex missing");
  }
  if (typeof record.cipherSaltB64 !== "string" || record.cipherSaltB64.length === 0) {
    throw new Error("Key backup keyRecord.cipherSaltB64 missing");
  }
  if (typeof record.cipherIvB64 !== "string" || record.cipherIvB64.length === 0) {
    throw new Error("Key backup keyRecord.cipherIvB64 missing");
  }
  if (typeof record.cipherB64 !== "string" || record.cipherB64.length === 0) {
    throw new Error("Key backup keyRecord.cipherB64 missing");
  }
}
