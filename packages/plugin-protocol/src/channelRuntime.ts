// Session Window Channel facade。
//
// 该文件只负责把已验证的 Connect caller 转成 Coordinator RPC。它不保存
// 私钥、Supplier、SSP Wire，也不向 Connect App 暴露私有 inbox 事件。

import type {
  ChannelMessageReceivedEvent,
  ChannelPublishParams,
  ChannelPublishResult,
  ChannelSubscriptionSetResult,
  ConnectChannelCaller,
  ConnectChannelRuntime,
  CoordinatorChannelOperation,
  CoordinatorChannelStateEvent,
  CoordinatorValueResult,
  SessionCoordinatorClient,
} from "@keymaster/contracts";

function unwrap<T>(result: CoordinatorValueResult<T>, operation: string): T {
  if (result.status === "ok") return result.value;
  const message = "message" in result
    ? result.message
    : result.status === "blocked"
      ? (typeof result.reason === "string" ? result.reason : result.reason.fallback)
      : result.status;
  throw new Error(`${operation} failed: ${message}`);
}

function ownerOperation(
  caller: ConnectChannelCaller,
  operation: Omit<Extract<CoordinatorChannelOperation, { type: "publish" }>, "ownerPublicKeyHex" | "caller">
): Extract<CoordinatorChannelOperation, { type: "publish" }> {
  return {
    ...operation,
    ownerPublicKeyHex: caller.ownerPublicKeyHex,
    caller: { kind: "connect", connectSessionId: caller.connectSessionId, origin: caller.origin }
  };
}

/** 为 protocol Service 创建只允许 Connect caller 的 Channel facade。 */
export function createConnectChannelRuntime(
  coordinator: SessionCoordinatorClient
): ConnectChannelRuntime {
  return {
    publish: async (caller: ConnectChannelCaller, input: ChannelPublishParams): Promise<ChannelPublishResult> => {
      const operation: CoordinatorChannelOperation = ownerOperation(caller, {
        type: "publish",
        channel: input.channel,
        content: input.content,
      });
      return unwrap(await coordinator.channelOperation(operation), "Channel publish") as ChannelPublishResult;
    },
    subscriptionSet: async (caller: ConnectChannelCaller, channels: string[]): Promise<ChannelSubscriptionSetResult> => {
      const operation: CoordinatorChannelOperation = {
        type: "subscription-set",
        ownerPublicKeyHex: caller.ownerPublicKeyHex,
        caller: { kind: "connect", connectSessionId: caller.connectSessionId, origin: caller.origin },
        channels: [...channels],
      };
      return unwrap(await coordinator.channelOperation(operation), "Channel subscription set") as ChannelSubscriptionSetResult;
    },
    release: (caller: ConnectChannelCaller): void => {
      const operation: CoordinatorChannelOperation = {
        type: "release",
        ownerPublicKeyHex: caller.ownerPublicKeyHex,
        caller: { kind: "connect", connectSessionId: caller.connectSessionId, origin: caller.origin },
      };
      void coordinator.channelOperation(operation).catch(() => undefined);
    },
    subscribe: (handler: (event: ChannelMessageReceivedEvent) => void): (() => void) =>
      coordinator.subscribeTopic("channel.events", (event: CoordinatorChannelStateEvent) => {
        // Coordinator 已完成验签；Connect facade 只投影公开消息。
        if (!event.publicMessage) return;
        const message = event.publicMessage;
        try {
          handler({
            channel: message.channel,
            publisherPublicKeyHex: message.publisherPublicKeyHex,
            messageId: message.messageId,
            content: message.content,
            sessionEpoch: event.sessionEpoch,
          });
        } catch {
          // 单个 Session Window listener 失败不能中断全局事件分发。
        }
      }),
  };
}
