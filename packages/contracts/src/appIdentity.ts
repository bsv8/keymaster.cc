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

export type AppIdentitySnapshot = VerifiedAppIdentity;

/** 本地 catalog 按 origin 的 proof 三态解析。 */
export type AppCatalogResolution =
  | { kind: "known-valid"; proof: AppIdentityProofV1; appId?: string }
  | { kind: "known-invalid"; reason: string }
  | { kind: "unknown" };

export interface AppCatalogResolver {
  resolve(origin: string): AppCatalogResolution;
}
