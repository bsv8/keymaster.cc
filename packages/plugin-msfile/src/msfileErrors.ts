// packages/plugin-msfile/src/msfileErrors.ts
// 稳定错误码见 contracts/src/msfile.ts；message 一律英文且不得携带敏感内容。

import type { MsFileErrorCode } from "@keymaster/contracts";

/** user_rejected 不是 MSFile 错误域，但 gateway 需要把它作为稳定结果上抛。 */
export type MsFileServiceErrorCode = MsFileErrorCode | "user_rejected";

export class MsFileServiceError extends Error {
  constructor(
    public readonly code: MsFileServiceErrorCode,
    message: string = code
  ) {
    super(message);
    this.name = "MsFileServiceError";
  }
}
