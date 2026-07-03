// packages/plugin-appmsg/src/pluginClient.ts
// 插件 scoped message client 适配层。
//
// 设计缘由（施工单 2026-07-03 001 §8.5）：
//   - 注入到插件 `ctx.get(APPMESSAGE_CLIENT_CAPABILITY)` 时，sender 已经
//     固定为插件 manifest 声明的 `appMessageEndpoint.endpointId`；
//   - 插件只传 `recipientPublicKeyHex` + `recipientOrigin|recipientAppId`
//     + `body` + `contentType`，**不**允许自报 sender。
//   - 公开接口只暴露 `sendMessage` / `listMessages` / `getMessage` /
//     `subscribeMessages`——sender 投影、owner、endpoint、box、atMs 全部
//     不可见。
//   - 与 runtime host 的对接：`createMessageScopedClient(...)` 返回
//     `AppMsgSimpleClient`；本类只是把 sender 已经固定的 client 进一步
//     收口到"按插件角度看"。
//
// 本仓库**不**再保留旧 `AppMsgPluginClient.subscribeInboxDirty(...)` 或
// `AppMsgPluginClient.list(... box ...)` 这类以 box 为中心的接口。

import type { AppMsgCore, AppMsgSimpleClient } from "@keymaster/contracts";

/**
 * 插件 scoped message client 形态。
 *
 * 与 `AppMsgSimpleClient` 同义；保留类型别名仅为兼容旧 import。
 */
export type AppMsgPluginClient = AppMsgSimpleClient;

/**
 * 工厂：构造一个 sender 已绑定的 scoped `appmsg.client`。
 *
 * `endpointId` 在本仓库模型中等价于 `appId`；runtime 在 enable 阶段
 * 通过 `manifest.appMessageEndpoint.endpointId` 注入；binding 后这条
 * 投影**不变**。
 *
 * 本函数不保存 endpointId 状态——插件拿到的是 `AppMsgSimpleClient`，
 * 内部 sender 投影已经固定，调用方无法更改。
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
