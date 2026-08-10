import type { StorageErrorCode, StorageProbeResult } from "@keymaster/contracts";

export class StorageServiceError extends Error {
  readonly code: StorageErrorCode;
  readonly diagnostic?: StorageProbeResult["diagnostic"];
  constructor(code: StorageErrorCode, message: string = code, diagnostic?: StorageProbeResult["diagnostic"]) {
    super(message);
    this.name = "StorageServiceError";
    this.code = code;
    this.diagnostic = diagnostic;
  }
}

export function storageErrorCode(error: unknown): StorageErrorCode | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("storage_") ? code as StorageErrorCode : undefined;
}
