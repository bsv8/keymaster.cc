export type AppRequirement = "private-key" | "storage";

/** 外部 caller / catalog 使用的完整签名 proof。 */
export interface AppIdentityProofV1 {
  version: 1;
  publisherPublicKey: string;
  app: { id: string; name: string; description: string };
  requirements: AppRequirement[];
  signature: string;
}

/** 本地 session 中的 proof digest 快照；digest 来源是 proof JCS，不是 metadata-only。 */
export interface VerifiedAppIdentity {
  version: 1;
  publisherPublicKeyHex: string;
  appId: string;
  appName: string;
  identityDigestHex: string;
}

/**
 * 从已验证的 publisher 公钥和 App ID 派生三方 App 的稳定存储目录 ID。
 *
 * 这不是 caller 可以提交的权限字段：Host 必须从已验证 identity 重新计算，
 * 这样 caller 伪造 owner 或另一个 App UUID 时会在装配层被拒绝。
 * 算法使用 SHA-256 的固定域分隔输入，并按 RFC 4122 UUID v5 的版本/变体
 * 位格式化；同一 publisher + appId 在不同设备和 Provider 上结果一致。
 */
export function deriveThirdPartyApplicationStorageId(
  publisherPublicKeyHex: string,
  appId: string
): string {
  if (!/^(02|03)[0-9a-f]{64}$/u.test(publisherPublicKeyHex)) {
    throw new Error("publisherPublicKeyHex is invalid");
  }
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/u.test(appId) || [...appId].length > 63) {
    throw new Error("appId is invalid");
  }

  // The implementation is synchronous so it can be used during manifest
  // validation. Keep the small hash implementation local to contracts and
  // avoid making the public contract depend on a crypto provider at runtime.
  const bytes = new TextEncoder().encode(
    `keymaster.app-storage.v1\u0000${publisherPublicKeyHex.toLowerCase()}\u0000${appId}`
  );
  // SHA-256 is provided by the platform through a tiny, deterministic
  // fallback-free implementation imported by the contracts package.
  const digest = sha256(bytes);
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// Kept as a local import at the end so the identity types remain the first
// thing visible to consumers in generated documentation.
import { sha256 } from "@noble/hashes/sha2.js";

export type AppIdentitySnapshot = VerifiedAppIdentity;

/** 本地 catalog 按 origin 的 proof 三态解析。 */
export type AppCatalogResolution =
  | { kind: "known-valid"; proof: AppIdentityProofV1; appId?: string }
  | { kind: "known-invalid"; reason: string }
  | { kind: "unknown" };

export interface AppCatalogResolver {
  resolve(origin: string): AppCatalogResolution;
}
