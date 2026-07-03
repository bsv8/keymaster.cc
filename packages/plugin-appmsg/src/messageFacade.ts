// packages/plugin-appmsg/src/messageFacade.ts
// app/plugin 统一简单 facade。
//
// 设计缘由（施工单 2026-07-03 001 §4.4 / §5 / §8.3）：
//   - app / plugin 通过 `AppMsgSimpleClient` 拿到系统消息能力；
//   - facade 内部对 sender 投影做"自动补 owner / endpoint"——调用方**不**
//     允许也不需要传 sender / endpoint / box / atMs；
//   - facade 内部按本地 DB / 在线 RPC 走真值，**不**暴露同步 / 缓存细节；
//   - 失败语义：send / list / get 走 reject；subscribeMessages handler
//     内部抛错吞掉；checkOnline 整体失败时不抛错，全 `unknown`。
//
// 本文件不实现具体业务（都是透传到 appmsg.core）——只把 sender 投影从
// 公开 caller 视角切到 platform 内部视角；以及保证 facade 不会"漏"出
// 任何 owner / endpoint 字段。

import type {
  AppMsgCore,
  AppMsgGetInput,
  AppMsgListInput,
  AppMsgListResult,
  AppMsgMessage,
  AppMsgOnlineInput,
  AppMsgOnlineResult,
  AppMsgRecipient,
  AppMsgSendInput,
  AppMsgSendResult,
  AppMsgSimpleClient
} from "@keymaster/contracts";

/**
 * sender 投影（platform 内部身份）。
 *
 * 构造后不可变：sender 身份 + pubkey 在创建时固定，调用方无法更改。
 */
export interface SenderProjection {
  senderPublicKeyHex: string;
  senderOrigin?: string;
  senderAppId?: string;
}

/**
 * 把 sender 投影 + 公开 send 入参转成 `appmsg.core.sendMessage(...)` 真实入参。
 *
 * `appmsg.core.sendMessage` 接受公开 `AppMsgSendInput`（仅 `recipient*` /
 * `body` / `contentType` / `clientMessageId` / `createdAtMs`）；sender 投影
 * 由 core 内部从 "当前 owner runtime" + "当前 caller 是 origin 还是 appId"
 * 推断；facade 这里**不**替 caller 决定 sender——它由 runtime 在构造
 * `MessageScopedClient` 时固定，不在 send 调用时再传。
 *
 * 因此本函数仅做 recipient 必填字段合法性校验：必须恰好指定
 * `recipientOrigin` 或 `recipientAppId` 之一。
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
}

/**
 * 简单 facade 实现。
 *
 * 实现要点：
 *   - `sendMessage`：透传到 core；发送时 sender 由 core 自动从"当前 bind owner
 *     + senderProjection"得到—— facade 这里**不**给 sender。
 *   - `listMessages` / `getMessage`：透传到本地库读。
 *   - `subscribeMessages`：透传到 core；core 内部在 HubMsg push 时先写本地
 *     库再分发给订阅者，**不**再有 inbox_dirty 间接路径。
 *   - `checkOnline`：透传到 core；core 内部调 HubMsg `message.online`，
 *     失败整体回 `unknown`，**不**抛错。
 */
export class MessageScopedClient implements AppMsgSimpleClient {
  readonly sender: SenderProjection;
  private readonly core: AppMsgCore;

  constructor(core: AppMsgCore, sender: SenderProjection) {
    this.core = core;
    this.sender = sender;
  }

  async sendMessage(input: AppMsgSendInput): Promise<AppMsgSendResult> {
    validateSendInput(input);
    return this.core.sendMessage(input);
  }

  async listMessages(input?: AppMsgListInput): Promise<AppMsgListResult> {
    return this.core.listLocalMessages(input);
  }

  async getMessage(input: AppMsgGetInput): Promise<AppMsgMessage | null> {
    return this.core.getLocalMessage(input);
  }

  subscribeMessages(handler: (msg: AppMsgMessage) => void): () => void {
    return this.core.subscribeMessages(handler);
  }

  async checkOnline(input: AppMsgOnlineInput): Promise<AppMsgOnlineResult> {
    return this.core.checkOnline(input);
  }
}

/**
 * 工厂：构造一个对外的 sender 已绑定 scoped client。
 *
 * runtime host 在 enable / 调用方在组装时用本工厂；本工厂**不**记录
 * 任何状态，只把 sender 投影固化在闭包里。
 */
export function makeMessageScopedClient(
  core: AppMsgCore,
  sender: SenderProjection
): AppMsgSimpleClient {
  return new MessageScopedClient(core, sender);
}

/**
 * `MessageAppScopedClient` —— keymaster.message 系统消息应用专用。
 *
 * 与 `MessageScopedClient` 行为一致，但标记 appId，方便以后日志/审计
 * 在记录时知道这是系统消息应用。
 */
export class SystemMessageAppClient extends MessageScopedClient {
  readonly appId: string;
  constructor(core: AppMsgCore, sender: SenderProjection, appId: string) {
    super(core, sender);
    this.appId = appId;
  }
}

/**
 * 工厂：构造系统消息应用自身的 scoped client。
 *
 * 调用方传 core + 当前 owner publicKeyHex + 系统消息应用 appId
 * （固定为 `keymaster.message`）。
 */
export function makeSystemMessageAppClient(
  core: AppMsgCore,
  ownerPublicKeyHex: string
): AppMsgSimpleClient {
  return new SystemMessageAppClient(
    core,
    { senderPublicKeyHex: ownerPublicKeyHex, senderAppId: "keymaster.message" },
    "keymaster.message"
  );
}

// 防止被 IDE 报告 unused
export type { AppMsgRecipient };
