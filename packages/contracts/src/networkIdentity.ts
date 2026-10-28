import type { NetworkIdentity } from "keymaster-connect/protocol";
/** 网络/身份的公开定义与校验统一由独立 Connect 提供。 */
export { validateBsvNetwork, validateNetworkIdentity, sameNetworkIdentity } from "keymaster-connect/protocol";
export type { BsvNetwork, NetworkIdentity } from "keymaster-connect/protocol";

/** 可信身份的公开字段投影；不重新解析内部身份，也不暴露 KeyIdentity 附带字段。 */
export function projectNetworkIdentity(identity: NetworkIdentity): NetworkIdentity {
  return Object.freeze({ bsvNetwork: identity.bsvNetwork, publicKeyHex: identity.publicKeyHex.toLowerCase() });
}

/** 只由平台使用：插件拿到已绑定句柄，不得自报根路径。 */
export function networkIdentityStorageRoot(identity: NetworkIdentity): string {
  return `${identity.bsvNetwork}/${identity.publicKeyHex}/`;
}
