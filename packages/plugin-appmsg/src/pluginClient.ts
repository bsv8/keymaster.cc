// packages/plugin-appmsg/src/pluginClient.ts
// 面向插件的 scoped `appmsg.client` 实现。
//
// 设计缘由（施工单 2026-07-01 002 硬切换）：
//   - 注入到插件 `ctx.get(APPMESSAGE_CLIENT_CAPABILITY)` 时，sender endpoint
//     已经固定为插件 manifest 声明的 `pluginEndpointId`；插件只传
//     recipient / body / contentType。
//   - 插件**不**允许自报 sender endpoint；scoped client 内部统一填 sender。
//   - owner runtime 来自 platform 注入：本组件**不**持有 owner 私钥；
//     sender.ownerPublicKeyHex 由 platform `appmsg.core` 用当前 bind owner
//     覆盖。

import type {
  AppMsgCore,
  AppMsgEndpoint,
  AppMsgInboxDirtyEvent,
  AppMsgListBox,
  AppMsgListResult,
  AppMsgMessage,
  AppMsgPluginClient,
  AppMsgSendResult,
  AppMsgContentType
} from "@keymaster/contracts";

/**
 * scoped `appmsg.client` 实现。
 *
 * 关键约束：
 *   - endpointId 在创建时**一次性**绑定到 sender endpoint；
 *   - 任何 list / get / send 都用 platform 提供的当前 owner；
 *   - 订阅 dirty event 时**只**收自己 endpoint 的事件（按 kind/id 过滤）。
 */
export class AppMsgPluginClientImpl implements AppMsgPluginClient {
  public readonly endpointId: string;
  private readonly core: AppMsgCore;

  constructor(core: AppMsgCore, endpointId: string) {
    this.core = core;
    this.endpointId = endpointId;
  }

  async list(input: {
    box: AppMsgListBox;
    afterMessageId?: string;
    beforeMessageId?: string;
    limit?: number;
  }): Promise<AppMsgListResult> {
    return this.core.list({
      // scope.ownerPublicKeyHex 由 core 用当前 bind owner 覆盖；
      // 这里只固定 endpoint 部分，owner 由 core 决定（平台单例）。
      scope: { ownerPublicKeyHex: "", endpoint: { kind: "plugin", id: this.endpointId } },
      params: {
        box: input.box,
        afterMessageId: input.afterMessageId,
        beforeMessageId: input.beforeMessageId,
        limit: input.limit
      }
    });
  }

  async get(messageId: string): Promise<AppMsgMessage | null> {
    return this.core.get({
      scope: { ownerPublicKeyHex: "", endpoint: { kind: "plugin", id: this.endpointId } },
      messageId
    });
  }

  async send(input: {
    recipientOwnerPublicKeyHex: string;
    recipientEndpoint: AppMsgEndpoint;
    contentType: AppMsgContentType;
    body: string;
    clientMessageId: string;
    createdAtMs: number;
  }): Promise<AppMsgSendResult> {
    return this.core.send({
      sender: { ownerPublicKeyHex: "", endpoint: { kind: "plugin", id: this.endpointId } },
      recipientOwnerPublicKeyHex: input.recipientOwnerPublicKeyHex,
      recipientEndpoint: input.recipientEndpoint,
      contentType: input.contentType,
      body: input.body,
      clientMessageId: input.clientMessageId,
      createdAtMs: input.createdAtMs
    });
  }

  subscribeInboxDirty(handler: (event: AppMsgInboxDirtyEvent) => void): () => void {
    const filtered = (event: AppMsgInboxDirtyEvent) => {
      if (event.endpoint.kind === "plugin" && event.endpoint.id === this.endpointId) {
        handler(event);
      }
    };
    return this.core.subscribeInboxDirty(filtered);
  }
}