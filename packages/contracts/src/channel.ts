// Channel 运行时契约。
//
// 说明：Channel 是唯一的消息/发布抽象。这里不暴露 Supplier、SSP Wire、私钥、
// 付款信息或远端历史；这些都属于 Coordinator 和 SatSubscription 内部。

/** ChannelProtocol/SSP 共用的递归 JSON 值。 */
export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };

/** Connect App 的 Channel 发布入参。 */
export interface ChannelPublishParams {
  /** 要发布到的 SSP 精确频道；不允许通配符。 */
  channel: string;
  /** App 自己定义的 JSON 内容；协议标识也应放在这里。 */
  content: JSONValue;
}

/** Channel 发布结果。 */
export interface ChannelPublishResult {
  /** 由 Keymaster/ChannelProtocol 生成的消息编号。 */
  messageId: string;
}

/** 受信任 WebRTC/内容插件发布的公开 Hash 请求参数。 */
export interface ChannelHashRequestPublishParams {
  /** 目标内容的 SHA-256（64 位小写 hex）；不是随机请求编号。 */
  hash: string;
  /** 当前版本由 Coordinator 固定为 WebRTC SDP locator。 */
  locator: "webrtc-sdp";
}

/** Connect App 的订阅替换入参。 */
export interface ChannelSubscriptionSetParams {
  /** 替换当前 caller 的完整精确频道集合；空数组表示释放全部订阅。 */
  channels: string[];
}

/** Channel 订阅替换结果。 */
export interface ChannelSubscriptionSetResult {
  /** Coordinator 已接受的当前 caller 逻辑期望集合；不代表 Supplier 物理订阅已完成。 */
  channels: string[];
}

/** Connect App 收到的已验签 Channel 事件数据。 */
export interface ChannelMessageReceivedEventData {
  /** 实际收到的精确频道。 */
  channel: string;
  /** ChannelProtocol 验签得到的作者压缩公钥 hex。 */
  publisherPublicKeyHex: string;
  /** ChannelProtocol 消息编号。 */
  messageId: string;
  /** 已验签的 App JSON 内容。 */
  content: JSONValue;
}

/** 对外事件之外，Coordinator 内部使用的 Channel 事件。 */
export interface ChannelMessageReceivedEvent extends ChannelMessageReceivedEventData {
  /** 当前 owner 会话世代；仅供 Coordinator 做失效隔离。 */
  sessionEpoch: string;
}

/** 已通过 owner inbox 固定路由的内部私有消息。 */
export interface ChannelPrivateMessageEvent {
  /** 固定的 owner inbox 频道。 */
  channel: string;
  /** 发送者公钥。 */
  publisherPublicKeyHex: string;
  /** 私有消息编号。 */
  messageId: string;
  /** ChannelProtocol 私有协议标识。 */
  protocol: string;
  /** 已验签/解密后的业务 JSON。 */
  content: JSONValue;
}

/** 受信任插件申请 Channel 运行时的 caller 身份。 */
export type ChannelCaller =
  | { kind: "plugin"; pluginId: string }
  | { kind: "system"; systemId: string };

/** Coordinator RPC 使用的 caller；Connect caller 由 Session Window 预先验真。 */
export type ChannelOperationCaller = ChannelCaller | {
  kind: "connect";
  connectSessionId: string;
  origin: string;
};

/** Session Window 向 Coordinator 传递的已验证 Connect session 上下文。 */
export interface ConnectChannelCaller {
  /** 已验证 Connect session 编号；不进入 App content。 */
  connectSessionId: string;
  /** Session Window 已验证的 exact origin。 */
  origin: string;
  /** 从 Connect session 取得的 owner 公钥；App 不可自报。 */
  ownerPublicKeyHex: string;
}

/** 受信任插件使用的 Channel 运行时。 */
export interface ChannelRuntime {
  /** 当前 owner Channel runtime 是否可用。 */
  isReady(): boolean;
  /** 发布 JSON 内容；消息编号由 Coordinator 产生。 */
  publish(input: ChannelPublishParams): Promise<ChannelPublishResult>;
  /** 发布真实 bsv8.hash.request.v1；请求编号由 Coordinator 生成并返回。 */
  publishHashRequest?(input: ChannelHashRequestPublishParams): Promise<ChannelPublishResult>;
  /** 受信任插件发布固定 owner-inbox 私有协议消息；Connect App 不可调用。 */
  publishPrivate(input: {
    recipientPublicKeyHex: string;
    protocol: string;
    content: JSONValue;
  }): Promise<ChannelPublishResult>;
  /** 替换本 caller 的订阅集合。 */
  subscriptionSet(channels: string[]): Promise<ChannelSubscriptionSetResult>;
  /** 订阅已验签的入站事件。 */
  subscribe(handler: (event: ChannelMessageReceivedEventData) => void): () => void;
  /** 订阅固定 owner-inbox 已路由的私有协议消息。 */
  subscribePrivate(handler: (event: ChannelPrivateMessageEvent) => void): () => void;
}

/**
 * Coordinator Channel capability 的受信任构造面。
 *
 * 业务插件通过自己的 pluginId 创建 caller-scoped runtime；物理订阅、owner
 * epoch 和私钥仍由 Coordinator 生成/校验，插件不接触传输实现。
 */
export interface ChannelRuntimeFactory {
  /** 创建绑定业务插件 caller 的 Channel runtime；Host 会忽略调用方自报的 id。 */
  forPlugin(pluginId: string): ChannelRuntime;
  /** 创建绑定平台系统 caller 的 Channel runtime。 */
  forSystem(systemId: string): ChannelRuntime;
}

/** Protocol Service 使用的 Connect Channel facade。 */
export interface ConnectChannelRuntime {
  /** 使用已验证 session 上下文发布。 */
  publish(caller: ConnectChannelCaller, input: ChannelPublishParams): Promise<ChannelPublishResult>;
  /** 使用已验证 session 上下文替换订阅。 */
  subscriptionSet(caller: ConnectChannelCaller, channels: string[]): Promise<ChannelSubscriptionSetResult>;
  /** 释放 session 的全部虚拟订阅。 */
  release(caller: ConnectChannelCaller): void;
  /** 接收 Coordinator 已验签的入站事件。 */
  subscribe(handler: (event: ChannelMessageReceivedEvent) => void): () => void;
}

/** Channel 运行时 capability key。 */
export const CHANNEL_RUNTIME_CAPABILITY = "channel.runtime";

/** Protocol Service 注入的 Connect Channel facade capability key。 */
export const CONNECT_CHANNEL_RUNTIME_CAPABILITY = "channel.connect-runtime";
