import type { AppIdentitySnapshot, ProtocolMethod, ProtocolStorageRepository } from "@keymaster/contracts";

/** Stable application identity; a changed publisher/appId or exact origin never inherits another app's grants. */
export function applicationKey(origin: string, identity?: AppIdentitySnapshot): string {
  return JSON.stringify([origin, identity?.publisherPublicKeyHex.toLowerCase() ?? null, identity?.appId ?? null]);
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
