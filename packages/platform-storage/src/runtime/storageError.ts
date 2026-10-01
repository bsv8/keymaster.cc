import type { StorageErrorCode } from "@keymaster/contracts";

/** 脱敏诊断文本：只用于诊断展示，不得包含秘密。 */
export type StorageDiagnostic = string;

export class StorageRuntimeError extends Error {
  readonly code: StorageErrorCode;
  readonly diagnostic?: StorageDiagnostic;
  constructor(code: StorageErrorCode, message: string = code, diagnostic?: StorageDiagnostic) {
    super(message);
    this.name = "StorageRuntimeError";
    this.code = code;
    this.diagnostic = diagnostic;
  }
}

export function storageErrorCode(error: unknown): StorageErrorCode | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("storage_") ? code as StorageErrorCode : undefined;
}
