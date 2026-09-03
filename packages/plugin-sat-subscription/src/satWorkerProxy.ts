// 页面侧 SatSubscription / Channel facade。
//
// 页面不打开 Sat DB、不创建网络连接、不接触私钥或 SSP wire。所有动作都
// 通过 SharedWorker 的 typed RPC 完成；Channel runtime 是唯一业务消息入口。

import type {
  ChannelMessageReceivedEventData,
  ChannelPrivateMessageEvent,
  ChannelRuntime,
  ChannelSubscriptionSetResult,
  CoordinatorChannelOperation,
  CoordinatorSatOperation,
  SatIncomingPublish,
  SatIncomingPublishHandler,
  SatOwnerSupplierSettingsV1,
  SatSubscriptionAdminService,
  SatSubscriptionSettingsSnapshot,
  SatSubscriptionSpiService,
  SatSpiInformation,
  SatSupplierConfigV1,
  SatTopUpPreview,
  SatTopUpResult,
  SatCollectResult,
  SessionCoordinatorClient
} from "@keymaster/contracts";

function unwrap<T>(result: Awaited<ReturnType<SessionCoordinatorClient["satOperation"]>>, operation: string): T {
  if (result.status !== "ok") {
    const message = "message" in result
      ? result.message
      : result.status === "blocked"
        ? (typeof result.reason === "string" ? result.reason : result.reason.fallback)
        : result.status;
    const error = new Error(`${operation} failed: ${message}`) as Error & { code?: string };
    if ("code" in result && typeof result.code === "string") error.code = result.code;
    throw error;
  }
  return result.value as T;
}

function unwrapChannel<T>(result: Awaited<ReturnType<SessionCoordinatorClient["channelOperation"]>>, operation: string): T {
  if (result.status !== "ok") {
    const message = "message" in result
      ? result.message
      : result.status === "blocked"
        ? (typeof result.reason === "string" ? result.reason : result.reason.fallback)
        : result.status;
    const error = new Error(`${operation} failed: ${message}`) as Error & { code?: string };
    if ("code" in result && typeof result.code === "string") error.code = result.code;
    throw error;
  }
  return result.value as T;
}

/** SharedWorker 事件总线中的原始 SSP Publish；只给 Sat 设置页诊断使用。 */
export function subscribeSatIncoming(
  coordinator: SessionCoordinatorClient,
  handler: SatIncomingPublishHandler
): () => void {
  return coordinator.subscribeTopic("sat.events", (raw: { event?: { type?: string; event?: SatIncomingPublish } }) => {
    const event = raw?.event;
    if (!event || event.type !== "incoming" || !event.event) return;
    const incoming: SatIncomingPublish = event.event;
    void Promise.resolve()
      .then(() => handler({
        deliveryId: incoming.deliveryId,
        ingressSupplierId: incoming.ingressSupplierId,
        channel: incoming.channel,
        requestIdHex: incoming.requestIdHex,
        contentJson: incoming.contentJson.slice(),
        chargedAmount: incoming.chargedAmount,
        receivedAtMs: incoming.receivedAtMs
      }))
      .catch(() => undefined); // 页面诊断消费者不能打断 Coordinator。
  });
}

function currentOwner(coordinator: SessionCoordinatorClient): string {
  const owner = coordinator.getBootstrapSnapshot().activePublicKeyHex;
  if (!owner) throw new Error("No unlocked active owner");
  return owner;
}

function callSat<T>(coordinator: SessionCoordinatorClient, operation: CoordinatorSatOperation, label: string): Promise<T> {
  return coordinator.satOperation(operation).then((result) => unwrap<T>(result, label));
}

function callChannel<T>(coordinator: SessionCoordinatorClient, operation: CoordinatorChannelOperation, label: string): Promise<T> {
  return coordinator.channelOperation(operation).then((result) => unwrapChannel<T>(result, label));
}

/** 受信任插件使用的 Channel runtime。caller id 在 Coordinator 内生成。 */
export function createSatWorkerChannelRuntime(
  coordinator: SessionCoordinatorClient,
  caller: { kind: "plugin"; pluginId: string } | { kind: "system"; systemId: string }
): ChannelRuntime {
  const subscribedChannels = new Set<string>();
  let subscribedOwner: string | undefined;
  let subscribedSessionEpoch: string | undefined;
  const ownerForRequest = (): string => {
    const owner = currentOwner(coordinator);
    if (subscribedOwner !== owner) {
      subscribedChannels.clear();
      subscribedOwner = owner;
    }
    subscribedSessionEpoch = coordinator.getSessionEpoch();
    return owner;
  };
  const listen = <T>(handler: (value: T) => void, select: (event: { publicMessage?: ChannelMessageReceivedEventData; privateMessage?: ChannelPrivateMessageEvent }) => T | null): (() => void) =>
    (() => {
      const offChannel = coordinator.subscribeTopic("channel.events", (raw: { sessionEpoch?: unknown; publicMessage?: ChannelMessageReceivedEventData; privateMessage?: ChannelPrivateMessageEvent }) => {
        // channel.events 是全局广播；只有当前 runtime 登记的 session epoch
        // 才能进入插件，不能依赖 session.state 事件的先后顺序兜底。
        if (raw.sessionEpoch !== subscribedSessionEpoch) return;
        const channel = raw.publicMessage?.channel ?? raw.privateMessage?.channel;
        if (!channel || !subscribedChannels.has(channel)) return;
        const value = select(raw);
        if (value) {
          try { handler(value); } catch { /* 单个插件 handler 失败不影响总线。 */ }
        }
      });
      const offSession = coordinator.subscribeTopic("session.state", (raw: { sessionEpoch?: unknown; activePublicKeyHex?: unknown }) => {
        const owner = typeof raw.activePublicKeyHex === "string" ? raw.activePublicKeyHex : undefined;
        const epoch = typeof raw.sessionEpoch === "string" ? raw.sessionEpoch : undefined;
        if (owner !== subscribedOwner || epoch !== subscribedSessionEpoch) {
          subscribedChannels.clear();
          subscribedOwner = owner;
          subscribedSessionEpoch = epoch;
        }
      });
      return () => { offChannel(); offSession(); };
    })();

  return {
    isReady: () => Boolean(coordinator.getIsConnected() && coordinator.getBootstrapSnapshot().activePublicKeyHex),
    publish: (input) => {
      const owner = ownerForRequest();
      return callChannel(coordinator, {
        type: "publish",
        ownerPublicKeyHex: owner,
        caller,
        channel: input.channel,
        content: input.content
      }, "Channel publish");
    },
    publishHashRequest: (input) => {
      const owner = ownerForRequest();
      return callChannel(coordinator, {
        type: "hash-request-publish",
        ownerPublicKeyHex: owner,
        caller,
        hash: input.hash,
        locator: input.locator
      }, "Channel Hash request publish");
    },
    publishPrivate: (input) => {
      const owner = ownerForRequest();
      return callChannel(coordinator, {
        type: "private-publish",
        ownerPublicKeyHex: owner,
        caller,
        recipientPublicKeyHex: input.recipientPublicKeyHex,
        protocol: input.protocol,
        content: input.content
      }, "Private Channel publish");
    },
    subscriptionSet: async (channels): Promise<ChannelSubscriptionSetResult> => {
      const owner = ownerForRequest();
      const requestSessionEpoch = coordinator.getSessionEpoch();
      // 只有 Coordinator 返回的 result.channels 才是“已接受的逻辑订阅
      // 集合”。请求尚未完成前不能先放宽本地过滤，否则 Coordinator 拒绝
      // owner inbox 等保留频道时，插件仍会从全局 channel.events 收到私信。
      const result = await callChannel<ChannelSubscriptionSetResult>(coordinator, {
        type: "subscription-set",
        ownerPublicKeyHex: owner,
        caller,
        channels: [...channels]
      }, "Channel subscription set");
      const currentSessionEpoch = coordinator.getSessionEpoch();
      const currentOwner = coordinator.getBootstrapSnapshot().activePublicKeyHex;
      if (currentSessionEpoch !== requestSessionEpoch || currentOwner !== owner) {
        // 异步 RPC 返回时 owner 可能已经锁屏/切换。旧 owner 的成功结果
        // 不能写入新 owner 的过滤集合，否则全局 channel.events 会形成
        // 跨 owner 的私信泄漏窗口。
        subscribedChannels.clear();
        subscribedOwner = currentOwner;
        subscribedSessionEpoch = currentSessionEpoch;
        throw new Error("Channel subscription result became stale");
      }
      subscribedChannels.clear();
      for (const channel of result.channels) subscribedChannels.add(channel);
      subscribedSessionEpoch = currentSessionEpoch;
      return result;
    },
    subscribe: (handler) => listen(handler, (event) => event.publicMessage ?? null),
    subscribePrivate: (handler) => listen(handler, (event) => event.privateMessage ?? null)
  };
}

/** 页面 trusted Sat 管理 facade；仍然只传语义化参数。 */
export function createSatWorkerAdminService(coordinator: SessionCoordinatorClient): SatSubscriptionAdminService {
  return {
    getSettingsSnapshot: () => callSat<SatSubscriptionSettingsSnapshot>(coordinator, { type: "admin.getSettings" }, "Sat settings"),
    upsertSupplier: (config: SatSupplierConfigV1) => callSat<void>(coordinator, { type: "admin.upsertSupplier", config }, "Sat supplier save"),
    deleteSupplier: (supplierId: string) => callSat<void>(coordinator, { type: "admin.deleteSupplier", supplierId }, "Sat supplier delete"),
    setOwnerSettings: (settings: SatOwnerSupplierSettingsV1) => callSat<void>(coordinator, { type: "admin.setOwnerSettings", settings }, "Sat owner settings"),
    refreshSubscriptions: (input) => callSat(coordinator, { type: "admin.refreshSubscriptions", input }, "Sat subscription refresh")
  };
}

/** 页面 SPI facade；BigInt/Uint8Array 由 structured clone 原样传输。 */
export function createSatWorkerSpiService(coordinator: SessionCoordinatorClient): SatSubscriptionSpiService {
  return {
    getInformation: (input) => callSat<SatSpiInformation>(coordinator, { type: "spi.getInformation", input }, "SPI Information"),
    prepareTopUp: (input) => callSat<SatTopUpPreview>(coordinator, { type: "spi.prepareTopUp", input }, "SPI top-up preview"),
    submitTopUp: (preview) => callSat<SatTopUpResult>(coordinator, { type: "spi.submitTopUp", preview }, "SPI top-up submit"),
    collectNew: (input) => callSat<SatCollectResult>(coordinator, { type: "spi.collectNew", input }, "SPI Collect"),
    retryCollect: (input) => callSat<SatCollectResult>(coordinator, { type: "spi.retryCollect", input }, "SPI Collect retry"),
    collect: (input) => callSat<SatCollectResult>(coordinator, { type: "spi.collect", input }, "SPI Collect")
  };
}
