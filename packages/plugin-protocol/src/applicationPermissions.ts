import type { ProtocolMethod, ProtocolStorageRepository } from "@keymaster/contracts";
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
export const APPROVAL_METHODS: readonly ProtocolMethod[] = ["identity.get", "intent.sign", "cipher.encrypt", "cipher.decrypt", "payment.pay"];
export const METHOD_LABELS: Partial<Record<ProtocolMethod, string>> = {
  "identity.get": "身份凭证", "intent.sign": "意图签名", "cipher.encrypt": "加密", "cipher.decrypt": "解密", "payment.pay": "付款",
};
export function requiresApplicationApproval(method: ProtocolMethod): boolean {
  return APPROVAL_METHODS.includes(method);
}
export async function readApplicationPermissions(repo: ProtocolStorageRepository | undefined, key: string): Promise<ProtocolMethod[]> {
  if (!repo?.getApplicationPermissions) throw new Error("Application permission storage unavailable");
  return (await repo.getApplicationPermissions(key))?.methods ?? [];
}
export async function setApplicationPermission(repo: ProtocolStorageRepository | undefined, key: string, method: ProtocolMethod, enabled: boolean): Promise<void> {
  if (!repo?.setApplicationPermission) throw new Error("Application permission storage unavailable");
  await repo.setApplicationPermission(key, method, enabled);
}
