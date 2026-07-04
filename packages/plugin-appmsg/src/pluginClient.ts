// packages/plugin-appmsg/src/pluginClient.ts
// 插件 scoped message client 适配层。
//
// 设计缘由（施工单 2026-07-03 001 + 反馈 §"必须修改"）：
//   - 注入到插件 `ctx.get(APPMESSAGE_CLIENT_CAPABILITY)` 时，sender
//     由 manifest `appMessageEndpoint.endpointId` 决定；
//   - sender 投影（`AppMsgSenderProjection`）在构造时由 runtime host 带到
//     `AppMsgCore.createMessageScopedClient(...)`；本类只是把 sender
//     已经固定的 client 进一步收口到"按插件角度看"。
//   - 公开接口只暴露 `AppMsgSimpleClient`：5 个简单方法，sender 投影
//     透明地透过 facade 带到 core 的 scoped 接口。
//   - 与 runtime host 的对接：runtime host 在 enable 阶段调用本类，由
//     本类持有 `core` + `endpointId` + 当前 owner publicKeyHex。

import type {
  AppMsgCore,
  AppMsgSimpleClient
} from "@keymaster/contracts";

/**
 * 插件 scoped message client 形态。
 *
 * 与 `AppMsgSimpleClient` 同义；保留类型别名仅为兼容旧 import。
 */
export type AppMsgPluginClient = AppMsgSimpleClient;

/**
 * 工厂：构造一个 sender 已绑定的 scoped `appmsg.client`。
 *
 * sender = { ownerPublicKeyHex, senderAppId: endpointId }——
 * facade 内部**显式**带这个 sender 到 core 的 scoped 接口。
 */
export function makePluginScopedClient(
  core: AppMsgCore,
  endpointId: string,
  ownerPublicKeyHex: string
): AppMsgSimpleClient {
  return core.createMessageScopedClient({
    senderPublicKeyHex: ownerPublicKeyHex,
    senderAppId: endpointId
  });
}

/**
 * 兼容旧名字的 `AppMsgPluginClientImpl`。
 *
 * 新代码应直接用 `AppMsgSimpleClient`；本类只为旧 import 留一个空壳。
 */
export class AppMsgPluginClientImpl implements AppMsgSimpleClient {
  readonly endpointId: string;
  private readonly inner: AppMsgSimpleClient;

  constructor(core: AppMsgCore, endpointId: string, ownerPublicKeyHex: string) {
    this.endpointId = endpointId;
    this.inner = makePluginScopedClient(core, endpointId, ownerPublicKeyHex);
  }

  sendMessage(input: Parameters<AppMsgSimpleClient["sendMessage"]>[0]) {
    return this.inner.sendMessage(input);
  }
  listMessages(input?: Parameters<AppMsgSimpleClient["listMessages"]>[0]) {
    return this.inner.listMessages(input);
  }
  getMessage(input: Parameters<AppMsgSimpleClient["getMessage"]>[0]) {
    return this.inner.getMessage(input);
  }
  subscribeMessages(
    handler: Parameters<AppMsgSimpleClient["subscribeMessages"]>[0]
  ): () => void {
    return this.inner.subscribeMessages(handler);
  }
  checkOnline(input: Parameters<AppMsgSimpleClient["checkOnline"]>[0]) {
    return this.inner.checkOnline(input);
  }
}
