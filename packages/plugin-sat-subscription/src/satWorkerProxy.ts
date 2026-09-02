// 页面侧 SatSubscription facade。
//
// 本文件不打开 Sat DB、不创建网络连接，也不持有 Channel 私钥。所有调用
// 通过 SharedWorker Coordinator 的 sat.operation 语义化 RPC 完成。

import type {
  CoordinatorSatEvent,
  CoordinatorSatOperation,
  MessageProvider,
  MessageProviderHandle,
  MessageProviderHealth,
  MessageProviderOperations,
  ProviderDeliveryAckClaim,
  ProviderGetInput,
  ProviderListInput,
  ProviderListResult,
  ProviderOnlineInput,
  ProviderOnlineResult,
  ProviderSealedMessageRecord,
  ProviderSendInput,
  ProviderSendResult,
  ProviderSigner,
  SatActionResult,
  SatIncomingPublish,
  SatOwnerSupplierSettingsV1,
  SatSubscriptionAdminService,
  SatSubscriptionService,
  SatSubscriptionSettingsSnapshot,
  SatSubscriptionSpiService,
  SatSpiInformation,
  SatSupplierConfigV1,
  SatTopUpPreview,
  SatTopUpResult,
  SatCollectResult,
} from "@keymaster/contracts";
import type { SessionCoordinatorClient } from "@keymaster/contracts";

function unavailable(message: string): Error {
  return new Error(message);
}

function unwrap<T>(result: Awaited<ReturnType<SessionCoordinatorClient["satOperation"]>>, operation: string): T {
  if (result.status !== "ok") {
    const message = "message" in result ? result.message : result.status === "blocked" ? (typeof result.reason === "string" ? result.reason : result.reason.fallback) : result.status;
    const error = new Error(`${operation} failed: ${message}`) as Error & { code?: string };
    if ("code" in result && typeof result.code === "string") error.code = result.code;
    throw error;
  }
  return result.value as T;
}

function copyRecord(record: ProviderSealedMessageRecord): ProviderSealedMessageRecord {
  return {
    ...record,
    envelope: {
      envelopeBytes: record.envelope.envelopeBytes.slice(),
      signatureBytes: record.envelope.signatureBytes.slice(),
    },
  };
}

/** ACK RPC 只携带 Worker claim 引用，不把页面可篡改的消息正文/路由送回 Worker。 */
function copyAckClaim(record: ProviderSealedMessageRecord): ProviderDeliveryAckClaim {
  return {
    deliveryId: typeof record.deliveryId === "string" ? record.deliveryId : "",
    supplierId: typeof record.ingressSupplierId === "string" ? record.ingressSupplierId : "",
    ackClaimToken: typeof record.ackClaimToken === "string" ? record.ackClaimToken : "",
  };
}

/** SharedWorker 事件总线上 Sat message 的订阅辅助。 */
export function subscribeSatMessages(
  coordinator: SessionCoordinatorClient,
  handler: (record: ProviderSealedMessageRecord) => void,
): () => void {
  return coordinator.subscribeTopic("sat.events", (raw: { event?: CoordinatorSatEvent }) => {
    const event = raw?.event;
    if (!event || event.type !== "message") return;
    try { handler(copyRecord(event.record)); } catch { /* 页面 subscriber 不得反向打断 Coordinator */ }
  });
}

/** SharedWorker 事件总线上 Sat inbound Publish 的订阅辅助。 */
export function subscribeSatIncoming(
  coordinator: SessionCoordinatorClient,
  handler: (event: SatIncomingPublish) => void,
): () => void {
  return coordinator.subscribeTopic("sat.events", (raw: { event?: CoordinatorSatEvent }) => {
    const event = raw?.event;
    if (!event || event.type !== "incoming") return;
    try { handler({ ...event.event, contentJson: event.event.contentJson.slice() }); } catch { /* ignore */ }
  });
}

class SatWorkerProviderHandle implements MessageProviderOperations {
  private currentState: "bound" | "closed" = "bound";
  private readonly off: Array<() => void> = [];

  constructor(private readonly coordinator: SessionCoordinatorClient) {}

  state(): "idle" | "connecting" | "bound" | "closed" { return this.currentState; }

  close(): void {
    if (this.currentState === "closed") return;
    this.currentState = "closed";
    for (const unsubscribe of this.off.splice(0)) {
      try { unsubscribe(); } catch { /* ignore */ }
    }
  }

  private assertOpen(): void {
    if (this.currentState !== "bound") throw unavailable("SatSubscription provider handle is closed");
  }

  async sendMessage(input: ProviderSendInput): Promise<ProviderSendResult> {
    this.assertOpen();
    return unwrap<ProviderSendResult>(await this.coordinator.satOperation({ type: "provider.send", input }), "Sat message send");
  }

  async listMessages(_input: ProviderListInput): Promise<ProviderListResult> {
    this.assertOpen();
    throw unavailable("SatSubscription provider has no remote history");
  }

  async getMessage(_input: ProviderGetInput): Promise<ProviderSealedMessageRecord | null> {
    this.assertOpen();
    throw unavailable("SatSubscription provider has no remote history");
  }

  subscribeMessages(handler: (record: ProviderSealedMessageRecord) => void): () => void {
    this.assertOpen();
    const off = subscribeSatMessages(this.coordinator, handler);
    this.off.push(off);
    return () => { off(); const index = this.off.indexOf(off); if (index >= 0) this.off.splice(index, 1); };
  }

  async checkOnline(input: ProviderOnlineInput): Promise<ProviderOnlineResult> {
    this.assertOpen();
    return Object.fromEntries(input.publicKeyHexes.map((key) => [key, "unknown"]));
  }

  async ackMessage(record: ProviderSealedMessageRecord): Promise<void> {
    this.assertOpen();
    unwrap<unknown>(await this.coordinator.satOperation({ type: "provider.ack", claim: copyAckClaim(record) }), "Sat message ACK");
  }
}

/** 页面 MessageProvider；真正的 SatSubscription handle 由 Worker runtime 持有。 */
export class SatSubscriptionWorkerProxyProvider implements MessageProvider {
  readonly id = "sat-subscription";
  readonly displayName = "SatSubscription";
  readonly features = { remoteHistory: false, onlineQuery: false, deliveryAck: true } as const;
  private healthSnapshot: MessageProviderHealth = { isHealthy: false, lastError: null, lastConnectedAtMs: 0 };
  private offHealth?: () => void;

  constructor(private readonly coordinator: SessionCoordinatorClient) {
    this.subscribeHealth();
  }

  private subscribeHealth(): void {
    if (this.offHealth) return;
    this.offHealth = this.coordinator.subscribeTopic("sat.events", (raw: { health?: MessageProviderHealth }) => {
      if (raw?.health) this.healthSnapshot = { ...raw.health };
    });
  }

  async bind(input: { signer: ProviderSigner }): Promise<MessageProviderHandle> {
    if (!input?.signer?.publicKeyHex) throw unavailable("SatSubscription owner signer is missing");
    this.subscribeHealth();
    const health = unwrap<MessageProviderHealth>(await this.coordinator.satOperation({ type: "ensure" }), "SatSubscription runtime");
    this.healthSnapshot = health;
    return new SatWorkerProviderHandle(this.coordinator);
  }

  async shutdown(): Promise<void> {
    // SharedWorker runtime不能随某一个 Tab 的 AppMsg handle 关闭；锁定、切 key
    // 时由 Coordinator 统一释放。这里仅清理页面侧健康缓存。
    this.offHealth?.();
    this.offHealth = undefined;
    this.healthSnapshot = { isHealthy: false, lastError: null, lastConnectedAtMs: 0 };
  }

  health(): MessageProviderHealth { return { ...this.healthSnapshot }; }

  async checkOnline(input: ProviderOnlineInput): Promise<ProviderOnlineResult> {
    return Object.fromEntries(input.publicKeyHexes.map((key) => [key, "unknown"]));
  }
}

function call<T>(coordinator: SessionCoordinatorClient, operation: CoordinatorSatOperation, label: string): Promise<T> {
  return coordinator.satOperation(operation).then((result) => unwrap<T>(result, label));
}

/** 页面 trusted admin facade；仍然只传业务参数。 */
export function createSatWorkerAdminService(coordinator: SessionCoordinatorClient): SatSubscriptionAdminService {
  const service: SatSubscriptionService = {
    publish: (input) => call(coordinator, { type: "service.publish", input }, "Sat Publish"),
    setSubscription: (input) => call<SatActionResult>(coordinator, { type: "service.setSubscription", input }, "Sat subscription update"),
    subscribe: (input) => call<SatActionResult>(coordinator, { type: "service.subscribe", input }, "Sat Subscribe"),
    unsubscribe: (input) => call<SatActionResult>(coordinator, { type: "service.unsubscribe", input }, "Sat Unsubscribe"),
    refreshSubscriptions: (input) => call(coordinator, { type: "service.refreshSubscriptions", input }, "Sat subscription refresh"),
    subscribeEvents: (handler) => subscribeSatIncoming(coordinator, handler),
  };
  return {
    ...service,
    getSettingsSnapshot: () => call<SatSubscriptionSettingsSnapshot>(coordinator, { type: "admin.getSettings" }, "Sat settings"),
    upsertSupplier: (config: SatSupplierConfigV1) => call<void>(coordinator, { type: "admin.upsertSupplier", config }, "Sat supplier save"),
    deleteSupplier: (supplierId: string) => call<void>(coordinator, { type: "admin.deleteSupplier", supplierId }, "Sat supplier delete"),
    setOwnerSettings: (settings: SatOwnerSupplierSettingsV1) => call<void>(coordinator, { type: "admin.setOwnerSettings", settings }, "Sat owner settings"),
  };
}

/** 页面 SPI facade；BigInt/Uint8Array 由 structured clone 原样传输。 */
export function createSatWorkerSpiService(coordinator: SessionCoordinatorClient): SatSubscriptionSpiService {
  return {
    getInformation: (input) => call<SatSpiInformation>(coordinator, { type: "spi.getInformation", input }, "SPI Information"),
    prepareTopUp: (input) => call<SatTopUpPreview>(coordinator, { type: "spi.prepareTopUp", input }, "SPI top-up preview"),
    submitTopUp: (preview) => call<SatTopUpResult>(coordinator, { type: "spi.submitTopUp", preview }, "SPI top-up submit"),
    collectNew: (input) => call<SatCollectResult>(coordinator, { type: "spi.collectNew", input }, "SPI Collect"),
    retryCollect: (input) => call<SatCollectResult>(coordinator, { type: "spi.retryCollect", input }, "SPI Collect retry"),
    collect: (input) => call<SatCollectResult>(coordinator, { type: "spi.collect", input }, "SPI Collect"),
  };
}
