// packages/plugin-appmsg/src/messageFacade.ts
// app/plugin 统一简单 facade 实现（施工单 2026-07-03 002 硬切换）。
//
// 设计缘由：
//   - 每个 facade 实例在构造时把 `AppMsgSenderProjection` 固化；
//   - 任何 sendMessage / listMessages / getMessage / subscribeMessages
//     都**带这个 sender 投影走到 core**；
//   - 不允许 facade 端"假设 core 自动知道 sender"——这一假设在反馈
//     §"必须修改"中已明确指出会引入 ACL 漏洞。
//   - facade 还提供校验入参合法性的工具函数（recipient 必须给出
//     一个且唯一的 `recipientOrigin` / `recipientAppId`）；
//   - 旧 `SystemMessageAppClient` 与 `makeSystemMessageAppClient` 已
//     从主设计中移除——`plugin-message` 现在是一个普通 scoped 消息插件
//     （appId = `keymaster.message`），不再走"系统消息应用 facade"。
//
// 本文件**不**持有任何 owner 私钥 / HubMsg 连接真值——所有能力来
// 自 `AppMsgCore`。

import type {
  AppMsgCore,
  AppMsgGetInput,
  AppMsgGetScopedInput,
  AppMsgListInput,
  AppMsgListScopedInput,
  AppMsgListResult,
  AppMsgMessage,
  AppMsgOnlineInput,
  AppMsgOnlineResult,
  AppMsgSendInput,
  AppMsgSendResult,
  AppMsgSendScopedInput,
  AppMsgSenderProjection,
  AppMsgSimpleClient,
  AppMsgSubscribeScopedInput
} from "@keymaster/contracts";

/**
 * 校验 facade 入参。
 *
 * 失败路径：抛 `Error`——调用方在 facade 自己 try/catch。
 */
export function validateSendInput(input: AppMsgSendInput): void {
  const hasOrigin = typeof input.recipientOrigin === "string" && input.recipientOrigin.length > 0;
  const hasAppId = typeof input.recipientAppId === "string" && input.recipientAppId.length > 0;
  if (hasOrigin === hasAppId) {
    throw new Error(
      "appmsg: send requires exactly one of recipientOrigin / recipientAppId"
    );
  }
  if (!input.body || input.body.length === 0) {
    throw new Error("appmsg: send requires non-empty body");
  }
  if (input.contentType !== "text/plain" && input.contentType !== "text/markdown") {
    throw new Error("appmsg: send requires contentType text/plain or text/markdown");
  }
  if (!input.clientMessageId) {
    throw new Error("appmsg: send requires clientMessageId");
  }
  if (!input.recipientPublicKeyHex || input.recipientPublicKeyHex.length !== 66) {
    throw new Error("appmsg: send requires valid recipientPublicKeyHex");
  }
  if (hasOrigin && !/^(https?):\/\/([^/:]+):(\d+)$/.test(input.recipientOrigin as string)) {
    throw new Error("appmsg: invalid recipientOrigin (must be scheme://host:port)");
  }
  if (hasAppId && !/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(input.recipientAppId as string)) {
    throw new Error("appmsg: invalid recipientAppId (must be portable shape)");
  }
}

/**
 * 简单 facade 实现。
 *
 * 关键约束：
 *   - `sender` 在构造时固定，**不**变更；任何对 facade 的方法调用都
 *     自动带入 `sender` 给 core；
 *   - send / list / get / subscribe 全部走 core 的 scoped 接口；
 *   - subscribeMessages 的内部回调只在 scope 内事件触发时被调；
 *   - checkOnline 不带 sender 投影（与 sender 解耦）。
 */
export class MessageScopedClient implements AppMsgSimpleClient {
  readonly sender: AppMsgSenderProjection;

  constructor(private readonly core: AppMsgCore, sender: AppMsgSenderProjection) {
    this.sender = sender;
  }

  async sendMessage(input: AppMsgSendInput): Promise<AppMsgSendResult> {
    validateSendInput(input);
    const scoped: AppMsgSendScopedInput = {
      senderPublicKeyHex: this.sender.senderPublicKeyHex,
      senderOrigin: this.sender.senderOrigin,
      senderAppId: this.sender.senderAppId,
      recipientPublicKeyHex: input.recipientPublicKeyHex,
      recipientOrigin: input.recipientOrigin,
      recipientAppId: input.recipientAppId,
      contentType: input.contentType,
      body: input.body,
      clientMessageId: input.clientMessageId,
      createdAtMs: input.createdAtMs
    };
    return this.core.sendScopedMessage(scoped);
  }

  async listMessages(input?: AppMsgListInput): Promise<AppMsgListResult> {
    const scoped: AppMsgListScopedInput = {
      senderPublicKeyHex: this.sender.senderPublicKeyHex,
      senderOrigin: this.sender.senderOrigin,
      senderAppId: this.sender.senderAppId,
      afterMessageId: input?.afterMessageId,
      limit: input?.limit
    };
    return this.core.listScopedMessages(scoped);
  }

  async getMessage(input: AppMsgGetInput): Promise<AppMsgMessage | null> {
    const scoped: AppMsgGetScopedInput = {
      senderPublicKeyHex: this.sender.senderPublicKeyHex,
      senderOrigin: this.sender.senderOrigin,
      senderAppId: this.sender.senderAppId,
      messageId: input.messageId
    };
    return this.core.getScopedMessage(scoped);
  }

  subscribeMessages(handler: (msg: AppMsgMessage) => void): () => void {
    const scoped: AppMsgSubscribeScopedInput = {
      senderPublicKeyHex: this.sender.senderPublicKeyHex,
      senderOrigin: this.sender.senderOrigin,
      senderAppId: this.sender.senderAppId,
      handler
    };
    return this.core.subscribeScopedMessages(scoped);
  }

  async checkOnline(input: AppMsgOnlineInput): Promise<AppMsgOnlineResult> {
    return this.core.checkOnline(input);
  }
}

/**
 * 工厂：构造一个对外的 sender 已绑定 scoped client。
 */
export function makeMessageScopedClient(
  core: AppMsgCore,
  sender: AppMsgSenderProjection
): AppMsgSimpleClient {
  return new MessageScopedClient(core, sender);
}

/**
 * 兼容旧 `AppMsgPluginClient` 别名。
 */
export type { AppMsgPluginClient } from "@keymaster/contracts";