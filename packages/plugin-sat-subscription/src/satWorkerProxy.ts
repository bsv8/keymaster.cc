// 页面侧 SatSubscription / Channel facade。
//
// 页面不打开 Sat K-V、不创建网络连接、不接触私钥或 SSP wire。所有动作都
// 通过 SharedWorker 的 typed RPC 完成；Channel runtime 是唯一业务消息入口。

import type {
  ChannelMessageReceivedEventData,
  ChannelPrivateMessageEvent,
  ChannelRuntime,
  ChannelSubscriptionSetResult,
  ChannelSubscriptionStatus,
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
  SatCoordinatorControl
} from "@keymaster/contracts";

function unwrap<T>(result: Awaited<ReturnType<SatCoordinatorControl["satOperation"]>>, operation: string): T {
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

function unwrapChannel<T>(result: Awaited<ReturnType<SatCoordinatorControl["channelOperation"]>>, operation: string): T {
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
  coordinator: SatCoordinatorControl,
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

function currentOwner(coordinator: SatCoordinatorControl): string {
  const owner = coordinator.getBootstrapSnapshot().activePublicKeyHex;
  if (!owner) throw new Error("No unlocked active owner");
  return owner;
}

function callSat<T>(coordinator: SatCoordinatorControl, operation: CoordinatorSatOperation, label: string): Promise<T> {
  return coordinator.satOperation(operation).then((result) => unwrap<T>(result, label));
}

function callChannel<T>(coordinator: SatCoordinatorControl, operation: CoordinatorChannelOperation, label: string, signal?: AbortSignal): Promise<T> {
  const request = signal === undefined
    ? coordinator.channelOperation(operation)
    : coordinator.channelOperation(operation, signal);
  return request.then((result) => unwrapChannel<T>(result, label));
}

/** 受信任插件使用的 Channel runtime。caller id 在 Coordinator 内生成。 */
export function createSatWorkerChannelRuntime(
  coordinator: SatCoordinatorControl,
  caller: { kind: "plugin"; pluginId: string } | { kind: "system"; systemId: string }
): ChannelRuntime {
  const subscribedChannels = new Set<string>();
  const subscriptionStatuses = new Map<string, ChannelSubscriptionStatus>();
  const subscriptionStatusListeners = new Set<(status: ChannelSubscriptionStatus) => void>();
  let offSubscriptionStatusTopic: (() => void) | undefined;
  let offSubscriptionStatusSession: (() => void) | undefined;
  let subscribedOwner: string | undefined;
  let subscribedSessionEpoch: string | undefined;
  const ownerForRequest = (): string => {
    const owner = currentOwner(coordinator);
    if (subscribedOwner !== owner) {
      subscribedChannels.clear();
      subscriptionStatuses.clear();
      subscribedOwner = owner;
    }
    subscribedSessionEpoch = coordinator.getSessionEpoch();
    if (subscriptionStatusListeners.size > 0) {
      try { ensureSubscriptionStatusTopic(); } catch { /* 订阅前尚未解锁；下一次请求再建立总线。 */ }
    }
    return owner;
  };
  const publishLocalSubscriptionStatus = (status: ChannelSubscriptionStatus): void => {
    const snapshot = { ...status };
    subscriptionStatuses.set(snapshot.channel, snapshot);
    for (const listener of [...subscriptionStatusListeners]) {
      try { listener({ ...snapshot }); } catch { /* 单个插件观察者不能打断总线。 */ }
    }
  };
  const ensureSubscriptionStatusTopic = (): void => {
    if (offSubscriptionStatusTopic) return;
    subscribedOwner = currentOwner(coordinator);
    subscribedSessionEpoch = coordinator.getSessionEpoch();
    offSubscriptionStatusTopic = coordinator.subscribeTopic("channel.events", (raw: {
      sessionEpoch?: unknown;
      subscriptionStatus?: ChannelSubscriptionStatus;
      subscriptionStatuses?: ChannelSubscriptionStatus[];
    }) => {
      if (raw.sessionEpoch !== subscribedSessionEpoch) return;
      const status = raw.subscriptionStatus;
      if (status && typeof status.channel === "string") publishLocalSubscriptionStatus(status);
      if (Array.isArray(raw.subscriptionStatuses)) {
        for (const snapshot of raw.subscriptionStatuses) {
          if (snapshot && typeof snapshot.channel === "string") publishLocalSubscriptionStatus(snapshot);
        }
      }
    });
    offSubscriptionStatusSession = coordinator.subscribeTopic("session.state", (raw: { sessionEpoch?: unknown; activePublicKeyHex?: unknown }) => {
      const owner = typeof raw.activePublicKeyHex === "string" ? raw.activePublicKeyHex : undefined;
      const epoch = typeof raw.sessionEpoch === "string" ? raw.sessionEpoch : undefined;
      if (owner !== subscribedOwner || epoch !== subscribedSessionEpoch) {
        subscribedChannels.clear();
        subscriptionStatuses.clear();
        subscribedOwner = owner;
        subscribedSessionEpoch = epoch;
      }
    });
  };
  const stopSubscriptionStatusTopic = (): void => {
    offSubscriptionStatusTopic?.();
    offSubscriptionStatusSession?.();
    offSubscriptionStatusTopic = undefined;
    offSubscriptionStatusSession = undefined;
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
    publish: (input, signal) => {
      const owner = ownerForRequest();
      return callChannel(coordinator, {
        type: "publish",
        ownerPublicKeyHex: owner,
        caller,
        channel: input.channel,
        content: input.content
      }, "Channel publish", signal);
    },
    publishHashRequest: (input, signal) => {
      const owner = ownerForRequest();
      return callChannel(coordinator, {
        type: "hash-request-publish",
        ownerPublicKeyHex: owner,
        caller,
        hash: input.hash,
        locator: input.locator
      }, "Channel Hash request publish", signal);
    },
    publishPrivate: (input, signal) => {
      const owner = ownerForRequest();
      return callChannel(coordinator, {
        type: "private-publish",
        ownerPublicKeyHex: owner,
        caller,
        recipientPublicKeyHex: input.recipientPublicKeyHex,
        protocol: input.protocol,
        content: input.content
      }, "Private Channel publish", signal);
    },
    openPrivateEnvelope: (input, signal) => {
      const owner = ownerForRequest();
      return callChannel(coordinator, {
        type: "open-private-envelope",
        ownerPublicKeyHex: owner,
        caller,
        envelope: input.envelope
      }, "Private Channel history open", signal);
    },
    subscriptionSet: async (channels, signal): Promise<ChannelSubscriptionSetResult> => {
      const owner = ownerForRequest();
      const requestSessionEpoch = coordinator.getSessionEpoch();
      const previousChannels = [...subscribedChannels];
      // 只有 Coordinator 返回的 result.channels 才是“已接受的逻辑订阅
      // 集合”。请求尚未完成前不能先放宽本地过滤，否则 Coordinator 拒绝
      // owner inbox 等保留频道时，插件仍会从全局 channel.events 收到私信。
      const result = await callChannel<ChannelSubscriptionSetResult>(coordinator, {
        type: "subscription-set",
        ownerPublicKeyHex: owner,
        caller,
        channels: [...channels]
      }, "Channel subscription set", signal);
      const currentSessionEpoch = coordinator.getSessionEpoch();
      const currentOwner = coordinator.getBootstrapSnapshot().activePublicKeyHex;
      if (currentSessionEpoch !== requestSessionEpoch || currentOwner !== owner) {
        // 异步 RPC 返回时 owner 可能已经锁屏/切换。旧 owner 的成功结果
        // 不能写入新 owner 的过滤集合，否则全局 channel.events 会形成
        // 跨 owner 的私信泄漏窗口。
        subscribedChannels.clear();
        subscriptionStatuses.clear();
        subscribedOwner = currentOwner;
        subscribedSessionEpoch = currentSessionEpoch;
        throw new Error("Channel subscription result became stale");
      }
      subscribedChannels.clear();
      for (const channel of result.channels) subscribedChannels.add(channel);
      for (const channel of previousChannels) {
        if (!subscribedChannels.has(channel)) {
          publishLocalSubscriptionStatus({ channel, phase: "idle", errorCode: null, errorMessage: null, updatedAtMs: Date.now() });
        }
      }
      const authoritativeStatuses = new Map(
        (result.statuses ?? [])
          .filter((status) => subscribedChannels.has(status.channel))
          .map((status) => [status.channel, status] as const)
      );
      for (const channel of subscribedChannels) {
        const status = authoritativeStatuses.get(channel);
        if (status) {
          // The result is an atomic snapshot from the Coordinator/Mux. Apply
          // it even when a previous caller already emitted a different status;
          // this is the handoff path for a newly-created runtime.
          publishLocalSubscriptionStatus(status);
        } else if (!subscriptionStatuses.has(channel) || subscriptionStatuses.get(channel)?.phase === "idle") {
          // Keep compatibility with an older Coordinator that only returns
          // channels. An accepted channel is at least being reconciled until
          // its status event arrives.
          publishLocalSubscriptionStatus({ channel, phase: "subscribing", errorCode: null, errorMessage: null, updatedAtMs: Date.now() });
        }
      }
      subscribedSessionEpoch = currentSessionEpoch;
      return result;
    },
    subscriptionStatus: (channel: string): ChannelSubscriptionStatus => {
      validateExactChannelForRuntime(channel);
      const snapshot = coordinator.getBootstrapSnapshot();
      if (snapshot.activePublicKeyHex !== subscribedOwner || snapshot.sessionEpoch !== subscribedSessionEpoch) {
        subscriptionStatuses.clear();
        subscribedChannels.clear();
        subscribedOwner = snapshot.activePublicKeyHex;
        subscribedSessionEpoch = snapshot.sessionEpoch;
      }
      // The Coordinator's channel.events baseline is the only synchronous
      // source for a current physical status. Attach before reading the local
      // cache so a fresh runtime can answer for an already-subscribed channel.
      try { ensureSubscriptionStatusTopic(); } catch { /* locked/disconnected: idle is the safe fallback */ }
      const status = subscriptionStatuses.get(channel);
      return status ? { ...status } : idleChannelStatus(channel);
    },
    subscribeSubscriptionStatus: (handler: (status: ChannelSubscriptionStatus) => void): (() => void) => {
      subscriptionStatusListeners.add(handler);
      try { ensureSubscriptionStatusTopic(); } catch { /* 尚未解锁时保持监听，随后由 subscriptionSet 建立。 */ }
      return () => {
        subscriptionStatusListeners.delete(handler);
        if (subscriptionStatusListeners.size === 0) stopSubscriptionStatusTopic();
      };
    },
    subscribe: (handler) => listen(handler, (event) => event.publicMessage ?? null),
    subscribePrivate: (handler) => listen(handler, (event) => event.privateMessage ?? null)
  };
}

function validateExactChannelForRuntime(channel: string): void {
  if (
    typeof channel !== "string" ||
    channel.length === 0 ||
    channel === "*" ||
    new TextEncoder().encode(channel).byteLength > 256 ||
    [...channel].some((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  ) throw new Error("Channel must be a non-empty exact UTF-8 channel");
}

function idleChannelStatus(channel: string): ChannelSubscriptionStatus {
  return { channel, phase: "idle", errorCode: null, errorMessage: null, updatedAtMs: 0 };
}

/** 页面 trusted Sat 管理 facade；仍然只传语义化参数。 */
export function createSatWorkerAdminService(coordinator: SatCoordinatorControl): SatSubscriptionAdminService {
  return {
    getSettingsSnapshot: () => callSat<SatSubscriptionSettingsSnapshot>(coordinator, { type: "admin.getSettings" }, "Sat settings"),
    upsertSupplier: (config: SatSupplierConfigV1) => callSat<void>(coordinator, { type: "admin.upsertSupplier", config }, "Sat supplier save"),
    deleteSupplier: (supplierId: string) => callSat<void>(coordinator, { type: "admin.deleteSupplier", supplierId }, "Sat supplier delete"),
    setOwnerSettings: (settings: SatOwnerSupplierSettingsV1) => callSat<void>(coordinator, { type: "admin.setOwnerSettings", settings }, "Sat owner settings"),
    refreshSubscriptions: (input) => callSat(coordinator, { type: "admin.refreshSubscriptions", input }, "Sat subscription refresh")
  };
}

/** 页面 SPI facade；BigInt/Uint8Array 由 structured clone 原样传输。 */
export function createSatWorkerSpiService(coordinator: SatCoordinatorControl): SatSubscriptionSpiService {
  return {
    getInformation: (input) => callSat<SatSpiInformation>(coordinator, { type: "spi.getInformation", input }, "SPI Information"),
    prepareTopUp: (input) => callSat<SatTopUpPreview>(coordinator, { type: "spi.prepareTopUp", input }, "SPI top-up preview"),
    submitTopUp: (preview) => callSat<SatTopUpResult>(coordinator, { type: "spi.submitTopUp", preview }, "SPI top-up submit"),
    collectNew: (input) => callSat<SatCollectResult>(coordinator, { type: "spi.collectNew", input }, "SPI Collect"),
    retryCollect: (input) => callSat<SatCollectResult>(coordinator, { type: "spi.retryCollect", input }, "SPI Collect retry"),
    collect: (input) => callSat<SatCollectResult>(coordinator, { type: "spi.collect", input }, "SPI Collect")
  };
}
