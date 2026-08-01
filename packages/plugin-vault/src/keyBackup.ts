// 单 Key 备份格式。v2 把密码和多个 WebAuthn PRF 保护器显式列在
// protectors map 中；每个保护器都可以独立解开同一把业务私钥。

import type { VaultKeyRecord, VaultMetaRecord, VaultPasskeyProtectionRecord } from "./vaultDb.js";

export const KEY_BACKUP_VERSION = 2 as const;

export interface LegacyKeyBackupEnvelope {
  backupVersion: 1;
  sourceVaultMeta: VaultMetaRecord;
  keyRecord: VaultKeyRecord;
}

export interface PasswordBackupProtector {
  type: "password";
  sourceVaultMeta: VaultMetaRecord;
  cipherVersion?: "v1" | "v2";
  cipherSaltB64: string;
  cipherIvB64: string;
  cipherB64: string;
}

export interface PasskeyBackupProtector extends VaultPasskeyProtectionRecord {
  type: "webauthn-prf";
}

export interface KeyBackupEnvelope {
  backupVersion: typeof KEY_BACKUP_VERSION;
  publicKeyHex: string;
  key: Omit<
    VaultKeyRecord,
    "publicKeyHex" | "cipherVersion" | "cipherSaltB64" | "cipherIvB64" | "cipherB64" | "passkeyProtections"
  >;
  /** 例如 { password: {...}, "MacBook Touch ID": {...} }。 */
  protectors: Record<string, PasswordBackupProtector | PasskeyBackupProtector>;
}

export type DecodedKeyBackupEnvelope = KeyBackupEnvelope | LegacyKeyBackupEnvelope;

export function buildKeyBackupEnvelope(
  sourceVaultMeta: VaultMetaRecord,
  keyRecord: VaultKeyRecord
): KeyBackupEnvelope {
  const {
    publicKeyHex,
    cipherVersion,
    cipherSaltB64,
    cipherIvB64,
    cipherB64,
    passkeyProtections = [],
    ...key
  } = keyRecord;
  const protectors: KeyBackupEnvelope["protectors"] = {
    password: {
      type: "password",
      sourceVaultMeta,
      cipherVersion,
      cipherSaltB64,
      cipherIvB64,
      cipherB64
    }
  };
  for (const passkey of passkeyProtections) {
    let name = passkey.label.trim() || "passkey";
    if (name === "password" || protectors[name]) {
      let suffix = 2;
      const base = name === "password" ? "passkey" : name;
      name = base;
      while (protectors[name]) name = `${base}-${suffix++}`;
    }
    protectors[name] = { type: "webauthn-prf", ...passkey };
  }
  return { backupVersion: KEY_BACKUP_VERSION, publicKeyHex, key, protectors };
}

export function encodeKeyBackup(envelope: KeyBackupEnvelope | LegacyKeyBackupEnvelope): string {
  validateKeyBackupEnvelope(envelope);
  return JSON.stringify(envelope, null, 2);
}

export function decodeKeyBackup(payload: string): DecodedKeyBackupEnvelope {
  const parsed = JSON.parse(payload) as unknown;
  validateKeyBackupEnvelope(parsed);
  return parsed;
}

/** 为现有密码恢复路径重建 canonical record；同时保留 v2 passkey 保护器。 */
export function passwordBackupView(envelope: DecodedKeyBackupEnvelope): {
  sourceVaultMeta: VaultMetaRecord;
  keyRecord: VaultKeyRecord;
} {
  if (envelope.backupVersion === 1) return envelope;
  const password = envelope.protectors.password;
  if (!password || password.type !== "password") {
    throw new Error("Key backup password protector is missing");
  }
  const passkeyProtections = Object.values(envelope.protectors)
    .filter((item): item is PasskeyBackupProtector => item.type === "webauthn-prf")
    .map(({ type: _type, ...item }) => item);
  return {
    sourceVaultMeta: password.sourceVaultMeta,
    keyRecord: {
      ...envelope.key,
      publicKeyHex: envelope.publicKeyHex,
      cipherVersion: password.cipherVersion,
      cipherSaltB64: password.cipherSaltB64,
      cipherIvB64: password.cipherIvB64,
      cipherB64: password.cipherB64,
      passkeyProtections
    }
  };
}

export function validateKeyBackupEnvelope(
  value: unknown
): asserts value is DecodedKeyBackupEnvelope {
  if (!value || typeof value !== "object") throw new Error("Key backup payload must be an object");
  const v = value as Record<string, unknown>;
  if (v.backupVersion === 1) {
    validateLegacy(v);
    return;
  }
  if (v.backupVersion !== KEY_BACKUP_VERSION) {
    throw new Error(`Unsupported key backup version: ${String(v.backupVersion)}`);
  }
  if (typeof v.publicKeyHex !== "string" || !v.publicKeyHex) {
    throw new Error("Key backup publicKeyHex missing");
  }
  if (!v.key || typeof v.key !== "object") throw new Error("Key backup key metadata missing");
  if (!v.protectors || typeof v.protectors !== "object" || Array.isArray(v.protectors)) {
    throw new Error("Key backup protectors missing");
  }
  const protectors = v.protectors as Record<string, unknown>;
  const password = protectors.password as Record<string, unknown> | undefined;
  if (!password || password.type !== "password") {
    throw new Error("Key backup password protector is missing");
  }
  validateCipher(password, "password protector");
  if (!password.sourceVaultMeta || typeof password.sourceVaultMeta !== "object") {
    throw new Error("Key backup password protector meta missing");
  }
  for (const [name, protector] of Object.entries(protectors)) {
    if (!protector || typeof protector !== "object") throw new Error(`Invalid protector ${name}`);
    const p = protector as Record<string, unknown>;
    if (p.type === "password") continue;
    if (p.type !== "webauthn-prf") throw new Error(`Unsupported protector type: ${String(p.type)}`);
    validateCipher(p, `passkey protector ${name}`, false);
    for (const field of ["id", "label", "credentialIdB64", "prfSaltB64", "rpId", "createdAt"]) {
      if (typeof p[field] !== "string" || !p[field]) throw new Error(`Passkey protector ${name}.${field} missing`);
    }
  }
}

function validateLegacy(v: Record<string, unknown>): void {
  if (!v.sourceVaultMeta || typeof v.sourceVaultMeta !== "object") {
    throw new Error("Key backup sourceVaultMeta is missing");
  }
  if (!v.keyRecord || typeof v.keyRecord !== "object") throw new Error("Key backup keyRecord is missing");
  const record = v.keyRecord as Record<string, unknown>;
  if (typeof record.publicKeyHex !== "string" || !record.publicKeyHex) {
    throw new Error("Key backup keyRecord.publicKeyHex missing");
  }
  validateCipher(record, "keyRecord");
}

function validateCipher(value: Record<string, unknown>, name: string, requireSalt = true): void {
  if (requireSalt && (typeof value.cipherSaltB64 !== "string" || !value.cipherSaltB64)) {
    throw new Error(`Key backup ${name}.cipherSaltB64 missing`);
  }
  if (typeof value.cipherIvB64 !== "string" || !value.cipherIvB64) {
    throw new Error(`Key backup ${name}.cipherIvB64 missing`);
  }
  if (typeof value.cipherB64 !== "string" || !value.cipherB64) {
    throw new Error(`Key backup ${name}.cipherB64 missing`);
  }
}
