/** 身份网络在创建/导入时确定；公钥相同也不能跨网复用业务身份。 */
export type BsvNetwork = "main" | "test";
export interface NetworkIdentity {
  readonly bsvNetwork: BsvNetwork;
  readonly publicKeyHex: string;
}
export function validateBsvNetwork(value: unknown): BsvNetwork {
  if (value !== "main" && value !== "test") throw new TypeError("BSV network must be main or test");
  return value;
}
export function validateNetworkIdentity(value: unknown): NetworkIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Network identity is invalid");
  const input = value as Record<string, unknown>;
  if (typeof input.publicKeyHex !== "string" || !/^(02|03)[0-9a-f]{64}$/iu.test(input.publicKeyHex)) throw new TypeError("Network identity public key is invalid");
  return Object.freeze({ bsvNetwork: validateBsvNetwork(input.bsvNetwork), publicKeyHex: input.publicKeyHex.toLowerCase() });
}
export function sameNetworkIdentity(left: NetworkIdentity, right: NetworkIdentity): boolean {
  return left.bsvNetwork === right.bsvNetwork && left.publicKeyHex.toLowerCase() === right.publicKeyHex.toLowerCase();
}
/** 只由平台使用：插件拿到已绑定句柄，不得自报根路径。 */
export function networkIdentityStorageRoot(identity: NetworkIdentity): string {
  const valid = validateNetworkIdentity(identity);
  return `${valid.bsvNetwork}/${valid.publicKeyHex}/`;
}
