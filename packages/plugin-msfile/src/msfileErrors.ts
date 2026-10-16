// packages/plugin-msfile/src/msfileErrors.ts
// 稳定错误码见 contracts/src/msfile.ts；message 为可展示的具体原因，不携带协议原文或密钥。

import type { MsFileErrorCode } from "@keymaster/contracts";

/** user_rejected 不是 MSFile 错误域，但 gateway 需要把它作为稳定结果上抛。 */
export type MsFileServiceErrorCode = MsFileErrorCode | "user_rejected";

/** 展示层保留服务返回的具体原因；只有缺失 message 时才用通用文案。 */
export function msfileErrorMessage(cause: unknown, fallback: string): string {
  if (typeof cause === "string" && cause.trim()) return cause;
  if (cause && typeof cause === "object" && "message" in cause
    && typeof cause.message === "string" && cause.message.trim()) return cause.message;
  return fallback;
}

export class MsFileServiceError extends Error {
  constructor(
    public readonly code: MsFileServiceErrorCode,
    message: string = code
  ) {
    super(message);
    this.name = "MsFileServiceError";
  }
}
