import type { ConnectMsFileReadRecord } from "@keymaster/contracts";
import type { MsFileReadStatus, ProtocolError } from "keymaster-connect/protocol";

export const msfileReadInterrupted = {
  code: "msfile_read_interrupted",
  message: "下载已中断。请在钱包中继续原任务后重试读取。",
} as const;

export const msfileReadCancelled = {
  code: "msfile_read_cancelled",
  message: "读取已取消。",
} as const;

export function msfileReadError({ phase, error }: ConnectMsFileReadRecord): ProtocolError | undefined {
  switch (phase) {
    case "interrupted":
      return msfileReadInterrupted;
    case "cancelled":
      return error?.code === "user_rejected" ? { code: error.code, message: error.message } : msfileReadCancelled;
    case "failed":
      return {
        code: (error?.code ?? "msfile_unavailable") as ProtocolError["code"],
        message: error?.message || "读取失败，请查看钱包购买历史。",
      };
    default:
      return undefined;
  }
}

export function toPublicMsFileReadStatus(status: ConnectMsFileReadRecord): MsFileReadStatus {
  const { phase, error: _error, ...details } = status;
  const error = msfileReadError(status);
  if (error) return { ...details, phase: "stopped", error };
  return { ...details, phase: phase === "available" ? "available" : "pending" };
}
