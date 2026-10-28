import { projectNetworkIdentity, type AppBootstrapPayload, type AppIdentitySnapshot, type NetworkIdentity, type SessionRuntimeBootstrap } from "@keymaster/contracts";

/** 钱包内部启动材料；不经 URL、消息帧或另一个钱包页面传递 crypto 句柄。 */
export interface ApplicationLaunchInput {
  networkIdentity: NetworkIdentity;
  appId: string;
  appOrigin: string;
  appUrl: string;
  walletPublicKeyHex: string;
  ownerPublicKeyHex: string;
  resolvedClaims: Record<string, unknown>;
  resolvedAt: number;
  appIdentity?: AppIdentitySnapshot;
  launchToken: string;
  expiresAt: number;
  sessionRuntimeBootstrap: SessionRuntimeBootstrap;
}
/** 保留真实句柄有效性判断，不重复校验受信内部 DTO 的形状。 */
export function buildAppBootstrapPayload(input: ApplicationLaunchInput): AppBootstrapPayload {
  input.sessionRuntimeBootstrap.crypto.getIdentity();
  return {
    networkIdentity: projectNetworkIdentity(input.networkIdentity),
    app: { appId: input.appId, appOrigin: input.appOrigin, appUrl: input.appUrl },
    walletPublicKeyHex: input.walletPublicKeyHex, ownerPublicKeyHex: input.ownerPublicKeyHex,
    resolvedClaims: input.resolvedClaims as AppBootstrapPayload["resolvedClaims"], resolvedAt: input.resolvedAt,
    ...(input.appIdentity ? { appIdentity: input.appIdentity } : {}),
    launchToken: input.launchToken, sessionRuntimeBootstrap: input.sessionRuntimeBootstrap,
  };
}
