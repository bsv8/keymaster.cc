import type { ProtocolMethod, ProtocolCommandRecord, ConnectStorageRepository } from "@keymaster/contracts";
import { assertAppPublicKeyHex } from "@keymaster/contracts";

/** Stable application identity; verified connections of the same App share grants. */
export function applicationKey(appPublicKeyHex: string): string {
  return assertAppPublicKeyHex(appPublicKeyHex);
}

/**
 * 许可主键：已验证发布身份的连接按 App 公钥归属（跨 origin/渠道/版本共享，
 * 同名或同源不同公钥不串用）。未验证身份直接拒绝，不回退来源键。
 */
export function permissionKeyFor(_transportOrigin: string, appPublicKeyHex?: string): string {
  return assertAppPublicKeyHex(appPublicKeyHex);
}

/** Only external Connect operations. No wallet-internal policy or funding approval is installed here. */
export const APPROVAL_METHODS = ["identity.get", "intent.sign", "cipher.encrypt", "cipher.decrypt", "payment.pay"] as const satisfies readonly ProtocolMethod[];
type ApplicationApprovalMethod = (typeof APPROVAL_METHODS)[number];

const PERMISSION_DETAILS: Record<ApplicationApprovalMethod, string> = {
  "identity.get": "允许此应用获取钱包签署的身份凭证，无需逐次确认。",
  "intent.sign": "允许此应用请求钱包签署意图，无需逐次确认。",
  "cipher.encrypt": "允许此应用使用钱包的应用专属密钥加密内容，无需逐次确认。",
  "cipher.decrypt": "允许此应用使用钱包的应用专属密钥解密内容，无需逐次确认。",
  "payment.pay": "允许此应用发起付款，无需逐次确认，自动付款不设金额上限。",
};

export function requiresApplicationApproval(method: ProtocolMethod): method is ApplicationApprovalMethod {
  return APPROVAL_METHODS.some(approvalMethod => approvalMethod === method);
}

export function applicationPermissionDetail(method: ProtocolMethod): string | undefined {
  return requiresApplicationApproval(method) ? PERMISSION_DETAILS[method] : undefined;
}

export function applicationCommandApprovalDetail(command: ProtocolCommandRecord): string | undefined {
  if (command.manualApprovedAt) return "本次由你批准";
  if (command.autoApproved) {
    const permission = applicationPermissionDetail(command.method);
    return permission ? `使用已有永久授权 · ${permission}` : "本次按应用连接权限处理，无需单独审批。";
  }
  return command.phase === "rejected" ? "未获批准" : undefined;
}
export async function readApplicationPermissions(repo: ConnectStorageRepository | undefined, key: string): Promise<ProtocolMethod[]> {
  if (!repo?.getApplicationPermissions) throw new Error("Application permission storage unavailable");
  return (await repo.getApplicationPermissions(key))?.methods ?? [];
}
export async function setApplicationPermission(repo: ConnectStorageRepository | undefined, key: string, method: ProtocolMethod, enabled: boolean): Promise<void> {
  if (!repo?.setApplicationPermission) throw new Error("Application permission storage unavailable");
  await repo.setApplicationPermission(key, method, enabled);
}
