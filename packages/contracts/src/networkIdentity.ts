import { validateNetworkIdentity, type NetworkIdentity } from "keymaster-connect/protocol";
/** 网络/身份的公开定义与校验统一由独立 Connect 提供。 */
export { validateBsvNetwork, validateNetworkIdentity, sameNetworkIdentity } from "keymaster-connect/protocol";
export type { BsvNetwork, NetworkIdentity } from "keymaster-connect/protocol";

/** 只由平台使用：插件拿到已绑定句柄，不得自报根路径。 */
export function networkIdentityStorageRoot(identity: NetworkIdentity): string {
  const valid = validateNetworkIdentity(identity);
  return `${valid.bsvNetwork}/${valid.publicKeyHex}/`;
}
