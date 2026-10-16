import { defineWorkerRequestRoute } from "@keymaster/contracts";
import { type CoordinatorClientRequest, type CoordinatorResponse, type ContactsPresenceChannel, type ChannelSubscriptionStatus, type ChannelPrivateMessageEvent } from "@keymaster/contracts";
import { inboxChannel, parsePublicKey } from "bsv8-channel-protocol";
import { HASH_REQUEST_CHANNEL } from "bsv8-channel-protocol/hash-request";
import { PING_PRIVATE_MESSAGE_MAX_LIFETIME_MS } from "bsv8-channel-protocol/inbox";
import {
  ChannelSubscriptionMux, validateExactChannel, createChannelProtocolRelations, createChannelPublications,
  createChannelCallerPolicy, createOwnerChannelMux, createContactsPresenceChannel, createChannelInbound,
  createChannelOperationExecutor, executeSatOperation, privateProtocol, validatePrivateProtocolCaller,
  privateBodyForPublish, publicMessageTimes, isUnknownChannelPublishFailure, type ChannelPrivateProtocol,
} from "./coordinator.js";
import type { SatWorkerRuntimeState } from "./workerLifecycle.js";
import type { ChannelInboundDependencies } from "./channelInbound.js";
import type { ChannelOperationDependencies } from "./channelOperationExecutor.js";

export interface ChannelWorkerPorts {
  session(): { vaultStatus: string; sessionEpoch: string; activePublicKeyHex?: string };
  runtime: { current(): SatWorkerRuntimeState | undefined; ensure(): Promise<SatWorkerRuntimeState> };
  io: { run<T>(operation: "read" | "write", signal: AbortSignal | undefined, execute: (signal: AbortSignal) => Promise<T>, options: { auditOperation: "sat.operation" | "channel.subscribe" | "channel.unsubscribe" | "channel.hash-publish" | "channel.public-publish" | "channel.private-publish" | "channel.incoming-decrypt" | "channel.history-open"; allowLocalLock?: boolean; allowLocalOwnerTransition?: boolean }): Promise<T> };
  admission: { disconnected(peerId: string): boolean; response(requestId: string): CoordinatorResponse };
  products: { available(id: string): boolean; blocked(requestId: string, id: string): CoordinatorResponse };
  events(event: Record<string, unknown>): void;
  connectSession: ChannelOperationDependencies<SatWorkerRuntimeState>["connectSession"];
  crypto: { signer: Parameters<typeof createChannelPublications>[0]["signer"]; open(channel: string, envelope: string | Uint8Array, signal?: AbortSignal): ReturnType<ChannelInboundDependencies<SatWorkerRuntimeState>["openPrivate"]> };
  related: Pick<ChannelInboundDependencies<SatWorkerRuntimeState>, "recordPong" | "routeSignal" | "hashRequestSeen"> & { prune(now: number): void };
}

/** Channel mux、协议关系、caller 订阅与业务分发由 SatSubscription 实例持有。 */
export function createChannelWorkerRuntime(ports: ChannelWorkerPorts) {
  let channelSubscriptionMux: ChannelSubscriptionMux | undefined;

  let channelMuxOwnerPublicKeyHex: string | undefined;

  let channelSubscriptionMuxStatusOff: (() => void) | undefined;

  const channelSubscriptionStatusSubscribers = new Set<{
    sessionEpoch: string;
    handler: (status: ChannelSubscriptionStatus) => void;
  }>();

  let channelSubscriptionMuxStarting: Promise<ChannelSubscriptionMux> | undefined;

  let channelSubscriptionMuxStartOwner: string | undefined;

  let channelSubscriptionMuxGeneration = 0;

  const channelPublicSubscribers = new Set<(event: { channel: string; publisherPublicKeyHex: string; messageId: string; content: import("@keymaster/contracts").JSONValue }) => void>();

  const channelPrivateSubscribers = new Set<(event: ChannelPrivateMessageEvent) => void>();

  const channelProtocolRelations = createChannelProtocolRelations({
    sessionEpoch: () => ports.session().sessionEpoch,
    ownerPublicKeyHex: () => ports.session().activePublicKeyHex,
    pruneRelated: ports.related.prune,
  });

  const channelPendingPings = channelProtocolRelations.pendingPings;

  const channelHashRequests = channelProtocolRelations.hashRequests;

  const channelWebrtcOffers = channelProtocolRelations.webrtcOffers;

  const pruneChannelProtocolRelations = channelProtocolRelations.prune;

  const channelHashRequestKey = channelProtocolRelations.hashRequestKey;

  const channelHashRequestByMessageId = channelProtocolRelations.hashRequestByMessageId;

  const channelWebrtcOfferKey = channelProtocolRelations.webrtcOfferKey;

  const findChannelWebrtcOffer = channelProtocolRelations.findWebrtcOffer;

  const pruneChannelPendingPings = channelProtocolRelations.prunePendingPings;

  const scheduleChannelPendingPingCleanup = channelProtocolRelations.schedulePendingPingCleanup;

  const allowAutomaticPong = channelProtocolRelations.allowAutomaticPong;

  const rememberChannelMessage = channelProtocolRelations.rememberMessage;

  const CHANNEL_PENDING_PING_TTL_MS = PING_PRIVATE_MESSAGE_MAX_LIFETIME_MS;

  const channelCallersByClient = new Map<string, Set<string>>();

  async function executeSatRequest(
    request: Extract<CoordinatorClientRequest, { kind: "sat.operation" }>,
  ): Promise<CoordinatorResponse> {
    // Sat 的 service.publish、TopUp、collect 和 Supplier 配置共享同一个
    // runtime；全部在内存 write lease 内完成，避免本次运行发生在签名/付款/
    // 远端提交与本地结果落库之间。
    if (ports.session().vaultStatus !== "unlocked" || !ports.session().activePublicKeyHex) {
      return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "locked" } };
    }
    return ports.io.run(
      "write",
      undefined,
      () => executeSatRequestUnsafe(request),
      { auditOperation: "sat.operation" },
    );
  }

  async function executeSatRequestUnsafe(
    request: Extract<CoordinatorClientRequest, { kind: "sat.operation" }>,
  ): Promise<CoordinatorResponse> {
    if (ports.session().vaultStatus !== "unlocked" || !ports.session().activePublicKeyHex) {
      return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "locked" } };
    }
    const runtime = await ports.runtime.ensure();
    const value = await executeSatOperation(request.operation, runtime, async () => {
      try {
        const mux = await ensureChannelSubscriptionMux(runtime);
        await mux.set(channelCallerId({ kind: "system", systemId: "owner-inbox" }), [inboxChannel(parsePublicKey(runtime.ownerPublicKeyHex))]);
      } catch (error) {
        // 设置已落库；若当前 receive Supplier 尚不可用，保留系统 caller
        // 的意图，下一次设置/Channel 操作会再次尝试物理订阅。
        console.warn("[channel] owner inbox rebind unavailable", error instanceof Error ? error.message : String(error));
      }
    });
    return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "ok" }, operationResult: value };
  }

  const channelCallerPolicy = createChannelCallerPolicy({ sessionEpoch: () => ports.session().sessionEpoch, ownerPublicKeyHex: () => ports.session().activePublicKeyHex });

  const channelCallerId = channelCallerPolicy.callerId;

  const isAllowedOwnerInboxSubscription = channelCallerPolicy.allowsOwnerInboxSubscription;

  const channelPublications = createChannelPublications({
    session: () => ({ sessionEpoch: ports.session().sessionEpoch, activePublicKeyHex: ports.session().activePublicKeyHex, vaultStatus: ports.session().vaultStatus }),
    signer: ports.crypto.signer,
    relations: channelProtocolRelations,
    unknownPublishFailure: isUnknownChannelPublishFailure,
  });

  const channelPublicMessageTimes = publicMessageTimes;

  function channelMonotonicNow(): number {
    return typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  }

  async function ensureMsfileBitfsBuyerSubscriptions(runtime: SatWorkerRuntimeState): Promise<void> {
    const mux = await ensureChannelSubscriptionMux(runtime);
    const ownerInbox = inboxChannel(parsePublicKey(runtime.ownerPublicKeyHex));
    const callerId = channelCallerId({ kind: "plugin", pluginId: "msfile" }, "bitfs-buyer-runtime");
    await mux.set(callerId, [ownerInbox], runtime.signal);
  }

  async function ensureMsfileBitfsSellerSubscriptions(runtime: SatWorkerRuntimeState): Promise<void> {
    const mux = await ensureChannelSubscriptionMux(runtime);
    const ownerInbox = inboxChannel(parsePublicKey(runtime.ownerPublicKeyHex));
    const callerId = channelCallerId({ kind: "plugin", pluginId: "msfile" }, "bitfs-seller-runtime");
    await mux.set(callerId, [HASH_REQUEST_CHANNEL, ownerInbox], runtime.signal);
  }

  async function clearMsfileBitfsSellerSubscriptions(): Promise<void> {
    const mux = channelSubscriptionMux;
    if (!mux || channelMuxOwnerPublicKeyHex !== ports.session().activePublicKeyHex) return;
    const callerId = channelCallerId({ kind: "plugin", pluginId: "msfile" }, "bitfs-seller-runtime");
    await mux.set(callerId, []);
  }

  async function ensureChannelSubscriptionMux(runtime: SatWorkerRuntimeState): Promise<ChannelSubscriptionMux> {
    if (channelSubscriptionMux && channelMuxOwnerPublicKeyHex === runtime.ownerPublicKeyHex) return channelSubscriptionMux;
    const existingStart = channelSubscriptionMuxStarting;
    if (existingStart && channelSubscriptionMuxStartOwner === runtime.ownerPublicKeyHex) return existingStart;
    if (existingStart) await existingStart.catch(() => undefined);

    const startGeneration = channelSubscriptionMuxGeneration;
    const start = createOwnerChannelMux({
      ownerPublicKeyHex: runtime.ownerPublicKeyHex, sessionEpoch: ports.session().sessionEpoch, signal: runtime.signal,
      driver: {
        // 订阅是可撤销的网络副作用，但仍必须绑定当前 Coordinator
        // authority。这样初始 owner inbox、请求中的 set/release 以及退避
        // 重试都不会在旧 Worker 接管后继续使用旧连接身份。
        subscribe: (channel, signal) => {
          // 主网与测试网都必须真实订阅；runtime 已按钱包身份绑定对应网关。
          // 提前返回会让 mux 错报 subscribed，页面却永远收不到行情。
          return ports.io.run(
            "write",
            signal,
            (leaseSignal) => runtime.handle.subscribePhysical(channel, leaseSignal),
            { allowLocalLock: true, allowLocalOwnerTransition: true, auditOperation: "channel.subscribe" },
          );
        },
        unsubscribe: (channel, signal) => ports.io.run(
          "write",
          signal,
          (leaseSignal) => runtime.handle.unsubscribePhysical(channel, leaseSignal),
          { allowLocalLock: true, allowLocalOwnerTransition: true, auditOperation: "channel.unsubscribe" },
        )
      },
      assertFresh(mux) {
        if (startGeneration !== channelSubscriptionMuxGeneration || ports.session().vaultStatus !== "unlocked" || ports.session().activePublicKeyHex !== runtime.ownerPublicKeyHex || (mux !== undefined && channelSubscriptionMux !== mux)) throw new Error("Channel subscription mux became stale during startup");
      },
      created(mux, offStatus) {
        channelSubscriptionMuxStatusOff?.();
        channelSubscriptionMux = mux;
        channelMuxOwnerPublicKeyHex = runtime.ownerPublicKeyHex;
        channelSubscriptionMuxStatusOff = offStatus;
      },
      released(mux) {
        if (channelSubscriptionMux === mux) {
          channelSubscriptionMux = undefined;
          channelMuxOwnerPublicKeyHex = undefined;
          channelSubscriptionMuxStatusOff = undefined;
        }
      },
      status: status => emitChannelSubscriptionStatus(status, runtime.ownerPublicKeyHex),
    });
    channelSubscriptionMuxStarting = start;
    channelSubscriptionMuxStartOwner = runtime.ownerPublicKeyHex;
    try {
      return await start;
    } finally {
      if (channelSubscriptionMuxStarting === start) {
        channelSubscriptionMuxStarting = undefined;
        channelSubscriptionMuxStartOwner = undefined;
      }
    }
  }

  type ChannelSeenMessageKind = "private" | "public" | "hash-request";

  function channelSeenMessageKey(kind: ChannelSeenMessageKind, ...parts: readonly string[]): string {
    return `${kind}\u0000${parts.join("\u0000")}`;
  }

  async function publishChannelHashRequest(
    runtime: SatWorkerRuntimeState,
    input: { hash: string; locator: "webrtc-sdp" },
    signal?: AbortSignal,
    onPrepared?: (messageId: string) => void,
  ): Promise<{ messageId: string }> {
    // 签名和随后不可逆的网络 Publish 必须属于同一个最终 lease；只保护
    // sign() 会在接管发生后留下“旧 owner 已签名但仍可发布”的窗口。
    return ports.io.run(
      "write",
      signal,
      (leaseSignal) => publishChannelHashRequestUnsafe(runtime, input, leaseSignal, onPrepared),
      { auditOperation: "channel.hash-publish" },
    );
  }

  const publishChannelHashRequestUnsafe = channelPublications.hash;

  async function publishChannelPublicMessage(
    runtime: SatWorkerRuntimeState,
    channel: string,
    content: import("@keymaster/contracts").JSONValue,
    signal?: AbortSignal,
  ): Promise<{ messageId: string }> {
    validateExactChannel(channel);
    if (channel.startsWith("bsv8.inbox.")) throw new Error("bsv8.inbox.* is a reserved private channel");
    if (channel === HASH_REQUEST_CHANNEL) throw new Error("bsv8.hash.request.v1 is reserved for the trusted WebRTC Hash request publisher");
    return ports.io.run("write", signal, async (leaseSignal) => {
      return channelPublications.public(runtime, channel, content, leaseSignal);
    }, { auditOperation: "channel.public-publish" });
  }

  function createCoordinatorChannelRuntime(assertActive: () => void = () => undefined): ContactsPresenceChannel {
    const contactsCaller = { kind: "system" as const, systemId: "contacts-presence" };
    const assertContactsEnabled = (): void => {
      if (!ports.products.available("contacts")) {
        throw new Error("Plugin unavailable: contacts");
      }
    };
    return createContactsPresenceChannel({
      assertActive,
      owner: () => ports.session().activePublicKeyHex,
      isReady: () => ports.products.available("contacts")
        && ports.session().vaultStatus === "unlocked"
        && Boolean(ports.session().activePublicKeyHex),
      async publishPrivate(input, signal) {
        assertContactsEnabled();
        const runtime = await ports.runtime.ensure();
        const protocol = privateProtocol(input.protocol);
        validatePrivateProtocolCaller(contactsCaller, protocol);
        const published = await publishPrivateEnvelope({
          runtime,
          recipientPublicKeyHex: input.recipientPublicKeyHex,
          protocol,
          body: privateBodyForPublish(protocol, input.content),
          signal: signal ?? runtime.signal
        });
        return { messageId: published.messageId, signedMessage: published.signedMessage };
      },
      async subscriptionSet(channels, signal) {
        assertContactsEnabled();
        const runtime = await ports.runtime.ensure();
        const ownerSessionEpoch = ports.session().sessionEpoch;
        const mux = await ensureChannelSubscriptionMux(runtime);
        const result = await mux.set(channelCallerId(contactsCaller), channels, signal ?? runtime.signal);
        if (ports.session().vaultStatus !== "unlocked"
          || ports.session().sessionEpoch !== ownerSessionEpoch
          || ports.session().activePublicKeyHex !== runtime.ownerPublicKeyHex) {
          throw new Error("Channel subscription became stale");
        }
        return {
          channels: [...result],
          // `channels` is only the logical caller result. Include the current
          // Mux status in the same response so a newly-created caller does not
          // have to win a race with the global status event stream.
          statuses: result.map((channel) => mux.subscriptionStatus(channel)),
        };
      },
    });
  }

  function idleChannelSubscriptionStatus(channel: string): ChannelSubscriptionStatus {
    validateExactChannel(channel);
    return { channel, phase: "idle", errorCode: null, errorMessage: null, updatedAtMs: 0 };
  }

  function channelSubscriptionStatusBaseline(): ChannelSubscriptionStatus[] {
    const mux = channelSubscriptionMux;
    if (!mux || channelMuxOwnerPublicKeyHex !== ports.session().activePublicKeyHex) return [];
    return [...mux.subscriptionStatuses()];
  }

  function emitChannelSubscriptionStatus(status: ChannelSubscriptionStatus, ownerPublicKeyHex: string): void {
    if (channelMuxOwnerPublicKeyHex !== ownerPublicKeyHex) return;
    for (const subscriber of [...channelSubscriptionStatusSubscribers]) {
      if (subscriber.sessionEpoch !== ports.session().sessionEpoch) continue;
      try { subscriber.handler({ ...status }); } catch { /* 状态观察者不能打断 Coordinator。 */ }
    }
    ports.events({
      type: "channel.subscription.changed",
      subscriptionStatus: { ...status },
    });
  }

  function emitChannelPublicMessage(message: { channel: string; publisherPublicKeyHex: string; messageId: string; content: import("@keymaster/contracts").JSONValue }): void {
    for (const subscriber of channelPublicSubscribers) {
      try { subscriber(message); } catch { /* 单个内部消费者不能打断 Channel 路由。 */ }
    }
    ports.events({
      type: "channel.message.received",
      publicMessage: message
    });
  }

  function emitChannelPrivateMessage(message: { channel: string; publisherPublicKeyHex: string; messageId: string; protocol: string; content: import("@keymaster/contracts").JSONValue; rawEnvelope?: Uint8Array }): void {
    for (const subscriber of channelPrivateSubscribers) {
      try { subscriber(message); } catch { /* 单个内部消费者不能打断 Channel 路由。 */ }
    }
    ports.events({
      type: "channel.message.received",
      privateMessage: message
    });
  }

  async function publishPrivateEnvelope(input: {
    runtime: SatWorkerRuntimeState;
    recipientPublicKeyHex: string;
    protocol: ChannelPrivateProtocol;
    body: import("bsv8-channel-protocol/inbox").UnsignedPrivateMessage["body"];
    signal?: AbortSignal;
  }): Promise<{ messageId: string; signedMessage: Uint8Array }> {
    // 私密消息也包含签名、加密和不可逆 Publish；这些步骤不能拆成多个
    // 独立边界，否则旧 Worker 仍可能在 authority 接管后发送迟到消息。
    return ports.io.run(
      "write",
      input.signal,
      (leaseSignal) => publishPrivateEnvelopeUnsafe({ ...input, signal: leaseSignal }),
      { auditOperation: "channel.private-publish" },
    );
  }

  const publishPrivateEnvelopeUnsafe = channelPublications.private;

  const handleIncomingChannelPublish = createChannelInbound<SatWorkerRuntimeState>({
    session: () => ({ sessionEpoch: ports.session().sessionEpoch, activePublicKeyHex: ports.session().activePublicKeyHex, vaultStatus: ports.session().vaultStatus }),
    runtime: () => ports.runtime.current(),
    relations: channelProtocolRelations,
    openPrivate: (event, owner, epoch) => ports.io.run(
      "read", undefined,
      (leaseSignal) => {
        if (ports.session().vaultStatus !== "unlocked" || ports.session().sessionEpoch !== epoch || ports.session().activePublicKeyHex !== owner) throw new Error("Channel owner changed before private message decrypt");
        return ports.crypto.open(event.channel, event.contentJson, leaseSignal);
      },
      { allowLocalLock: true, allowLocalOwnerTransition: true, auditOperation: "channel.incoming-decrypt" },
    ),
    publishPrivate: publishPrivateEnvelope,
    recordPong: ports.related.recordPong,
    emitPrivate: emitChannelPrivateMessage,
    emitPublic: emitChannelPublicMessage,
    routeSignal: ports.related.routeSignal,
    hashRequestSeen: ports.related.hashRequestSeen,
  });

  const executeOwnedChannelOperation = createChannelOperationExecutor<SatWorkerRuntimeState>({
    session: () => ({ sessionEpoch: ports.session().sessionEpoch, activePublicKeyHex: ports.session().activePublicKeyHex, vaultStatus: ports.session().vaultStatus }),
    publishHash: publishChannelHashRequest,
    publishPublic: publishChannelPublicMessage,
    publishPrivate: publishPrivateEnvelope,
    openPrivate: (owner, envelope, signal) => ports.io.run(
      "read", signal,
      (leaseSignal) => ports.crypto.open(inboxChannel(parsePublicKey(owner)), envelope, leaseSignal),
      { allowLocalLock: true, allowLocalOwnerTransition: true, auditOperation: "channel.history-open" },
    ),
    connectSession: ports.connectSession,
    disconnected: clientId => ports.admission.disconnected(clientId),
    disconnectedResponse: ports.admission.response,
    allowedInbox: isAllowedOwnerInboxSubscription,
    callers: channelCallersByClient,
  });

  async function executeChannelRequest(
    request: Extract<CoordinatorClientRequest, { kind: "channel.operation" }>,
    actualClientId: string,
    requestSignal?: AbortSignal,
  ): Promise<CoordinatorResponse> {
    if (requestSignal?.aborted || ports.admission.disconnected(actualClientId)) {
      return ports.admission.response(request.requestId);
    }
    if (request.expectedSessionEpoch !== ports.session().sessionEpoch) {
      return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "stale-epoch" } };
    }
    if (ports.session().vaultStatus !== "unlocked" || !ports.session().activePublicKeyHex) {
      return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "locked" } };
    }
    const operation = request.operation;
    const callerProductId = operation.caller.kind === "plugin"
      ? operation.caller.pluginId
      : operation.caller.kind === "system"
        ? operation.caller.systemId === "contacts-presence" ? "contacts" : "sat-subscription"
        : undefined;
    // 拒绝不在发行版目录中的产品身份。登记不授予调用权限：Channel 还要
    // 复核会话、owner 与 caller。Connect caller 属于独立授权链，不在此处
    // 伪造成某个插件；它仍由 Connect session 校验保护。
    if (callerProductId && !ports.products.available(callerProductId)) {
      return ports.products.blocked(request.requestId, callerProductId);
    }
    if (operation.ownerPublicKeyHex !== ports.session().activePublicKeyHex) {
      return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "stale-epoch" } };
    }
    if (operation.caller.kind === "connect") {
      const session = await ports.connectSession(operation.caller, operation.caller.origin);
      if (!session || session.revokedAt !== null || session.origin !== operation.caller.origin || session.ownerPublicKeyHex !== operation.ownerPublicKeyHex) {
        return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "error", message: "Channel Connect session is invalid", code: "storage_identity_required" } };
      }
    }
    const callerId = channelCallerId(operation.caller, actualClientId);
    if (operation.type === "subscription-set" || operation.type === "release") {
      const callers = channelCallersByClient.get(actualClientId) ?? new Set<string>();
      callers.add(callerId);
      channelCallersByClient.set(actualClientId, callers);
    }
    try {
      const runtime = await ports.runtime.ensure();
      const mux = await ensureChannelSubscriptionMux(runtime);
      if (requestSignal?.aborted || ports.admission.disconnected(actualClientId)) {
        return ports.admission.response(request.requestId);
      }
      return await executeOwnedChannelOperation(request, actualClientId, runtime, mux, callerId, requestSignal);
    } catch (error) {
      return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "error", message: error instanceof Error ? error.message : String(error) } };
    }
  }
  function release() {
    const mux = channelSubscriptionMux, starting = channelSubscriptionMuxStarting;
    mux?.cancelInFlight(); channelSubscriptionMuxStatusOff?.(); channelSubscriptionMuxStatusOff = undefined;
    channelSubscriptionMux = undefined; channelMuxOwnerPublicKeyHex = undefined;
    channelSubscriptionMuxGeneration += 1; channelSubscriptionMuxStarting = undefined; channelSubscriptionMuxStartOwner = undefined;
    channelCallersByClient.clear(); channelProtocolRelations.clear();
    const settled = starting?.catch(() => undefined);
    let current: typeof mux;
    return [
      { label: "stale mux start", run: async () => { current = mux ?? await settled; } },
      { label: "dispose subscriptions", run: async () => { current?.dispose(); } },
    ];
  }
  const channelRequests = new Map<string, { clientId: string; controller: AbortController }>();
  const channelRequestKey = (peerId: string, requestId: string) => `${peerId}:${requestId}`;
  const route = defineWorkerRequestRoute<Extract<CoordinatorClientRequest, { kind: "sat.operation" | "channel.operation" | "channel.cancel" }>>({
    kinds: ["sat.operation", "channel.operation", "channel.cancel"],
    policy: request => ({ scheduling: request.kind === "channel.cancel" ? "parallel" : "serial", validateEpoch: request.kind !== "channel.cancel" }),
    async execute(request, call) {
      if (request.kind === "sat.operation") return executeSatRequest(request);
      if (request.kind === "channel.cancel") {
        channelRequests.get(channelRequestKey(call.peerId, request.targetRequestId))?.controller.abort();
        return { requestId: call.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "ok" } };
      }
      return executeChannelRequest(request, call.peerId, call.signal);
    },
    prepare(request, call) {
      if (request.kind !== "channel.operation") return { signal: call.signal, dispose() { } };
      const key = channelRequestKey(call.peerId, call.requestId), controller = new AbortController();
      const abort = () => controller.abort(call.signal?.reason);
      if (call.signal?.aborted) abort(); else call.signal?.addEventListener("abort", abort, { once: true });
      channelRequests.set(key, { clientId: call.peerId, controller });
      return {
        signal: controller.signal, dispose() {
          call.signal?.removeEventListener("abort", abort);
          if (channelRequests.get(key)?.controller === controller) channelRequests.delete(key);
        }
      };
    },
  });
  return {
    release, route, channelRequests, channelRequestKey,
    get channelSubscriptionMux() { return channelSubscriptionMux; }, set channelSubscriptionMux(value: typeof channelSubscriptionMux) { channelSubscriptionMux = value; },
    get channelMuxOwnerPublicKeyHex() { return channelMuxOwnerPublicKeyHex; }, set channelMuxOwnerPublicKeyHex(value: typeof channelMuxOwnerPublicKeyHex) { channelMuxOwnerPublicKeyHex = value; },
    get channelSubscriptionMuxStatusOff() { return channelSubscriptionMuxStatusOff; }, set channelSubscriptionMuxStatusOff(value: typeof channelSubscriptionMuxStatusOff) { channelSubscriptionMuxStatusOff = value; },
    channelSubscriptionStatusSubscribers,
    get channelSubscriptionMuxStarting() { return channelSubscriptionMuxStarting; }, set channelSubscriptionMuxStarting(value: typeof channelSubscriptionMuxStarting) { channelSubscriptionMuxStarting = value; },
    get channelSubscriptionMuxStartOwner() { return channelSubscriptionMuxStartOwner; }, set channelSubscriptionMuxStartOwner(value: typeof channelSubscriptionMuxStartOwner) { channelSubscriptionMuxStartOwner = value; },
    get channelSubscriptionMuxGeneration() { return channelSubscriptionMuxGeneration; }, set channelSubscriptionMuxGeneration(value: typeof channelSubscriptionMuxGeneration) { channelSubscriptionMuxGeneration = value; },
    channelPublicSubscribers,
    channelPrivateSubscribers,
    channelProtocolRelations,
    channelPendingPings,
    channelHashRequests,
    channelWebrtcOffers,
    pruneChannelProtocolRelations,
    channelHashRequestKey,
    channelHashRequestByMessageId,
    channelWebrtcOfferKey,
    findChannelWebrtcOffer,
    pruneChannelPendingPings,
    scheduleChannelPendingPingCleanup,
    allowAutomaticPong,
    rememberChannelMessage,
    CHANNEL_PENDING_PING_TTL_MS,
    channelCallersByClient,
    executeSatRequest,
    executeSatRequestUnsafe,
    channelCallerPolicy,
    channelCallerId,
    isAllowedOwnerInboxSubscription,
    channelPublications,
    channelPublicMessageTimes,
    channelMonotonicNow,
    ensureMsfileBitfsBuyerSubscriptions,
    ensureMsfileBitfsSellerSubscriptions,
    clearMsfileBitfsSellerSubscriptions,
    ensureChannelSubscriptionMux,
    channelSeenMessageKey,
    publishChannelHashRequest,
    publishChannelHashRequestUnsafe,
    publishChannelPublicMessage,
    createCoordinatorChannelRuntime,
    idleChannelSubscriptionStatus,
    channelSubscriptionStatusBaseline,
    emitChannelSubscriptionStatus,
    emitChannelPublicMessage,
    emitChannelPrivateMessage,
    publishPrivateEnvelope,
    publishPrivateEnvelopeUnsafe,
    handleIncomingChannelPublish,
    executeOwnedChannelOperation,
    executeChannelRequest,
  };
}
