// WebRTC service 的 Channel 私信接线测试。

import { describe, expect, it, vi } from "vitest";
import type { ChannelRuntime, KeyspaceService, NoticeRecord, NoticeRegistry } from "@keymaster/contracts";
import { newMessageID, newSessionID } from "bsv8-channel-protocol";
import { newOffer, parseBodyValue } from "bsv8-channel-protocol/webrtc-signal";
import { createMemoryWebrtcConfigStore } from "./webrtcConfig.js";
import {
  createWebrtcService,
  type DataChannelLike,
  type MediaStreamLike,
  type RTCPeerConnectionLike,
  type WebrtcEnvironment
} from "./webrtcService.js";

const OWNER = "02" + "a".repeat(64);

const TARGET = "03" + "b".repeat(64);

const OTHER = "02" + "c".repeat(64);

function makeKeyspace(ownerPublicKeyHex = OWNER): KeyspaceService {
  return { active: () => ({ activePublicKeyHex: ownerPublicKeyHex }) } as unknown as KeyspaceService;
}

function makeMutableKeyspace(initialOwner = OWNER): { keyspace: KeyspaceService; setOwner(ownerPublicKeyHex: string): void } {
  type ActiveKeyChangedState = Parameters<KeyspaceService["onActiveKeyChanged"]>[0];
  let ownerPublicKeyHex = initialOwner;
  const listeners = new Set<(state: ActiveKeyChangedState) => void>();
  const keyspace = {
    active: () => ({ activePublicKeyHex: ownerPublicKeyHex }),
    onActiveKeyChanged: (handler: (state: ActiveKeyChangedState) => void) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    }
  } as unknown as KeyspaceService;
  return {
    keyspace,
    setOwner(nextOwnerPublicKeyHex) {
      ownerPublicKeyHex = nextOwnerPublicKeyHex;
      for (const listener of listeners) {
        listener({ activePublicKeyHex: nextOwnerPublicKeyHex } as ActiveKeyChangedState);
      }
    }
  };
}

function makeStream(): MediaStreamLike {
  let live = true;
  return {
    stop: () => { live = false; },
    isLive: () => live,
    native: undefined
  };
}

interface TestPeer {
  api: RTCPeerConnectionLike;
  remoteDescription: RTCSessionDescriptionInit | null;
}

function makePeer(): TestPeer {
  const peer: TestPeer = { api: undefined as never, remoteDescription: null };
  const dataChannel = {
    label: "test",
    readyState: "open" as const,
    send: () => undefined,
    close: () => undefined,
    onOpen: () => undefined,
    onMessage: () => undefined,
    onClose: () => undefined,
    onError: () => undefined
  };
  peer.api = {
    connectionState: "new",
    setLocalDescription: async () => undefined,
    setRemoteDescription: async (description) => { peer.remoteDescription = description; },
    createOffer: async () => ({ type: "offer", sdp: "v=0\r\nm=audio 9 RTP/AVP 0" }),
    createAnswer: async () => ({ type: "answer", sdp: "v=0\r\nm=audio 9 RTP/AVP 0" }),
    addIceCandidate: async () => undefined,
    onIceCandidate: () => undefined,
    onIceGatheringStateChange: () => undefined,
    onConnectionStateChange: () => undefined,
    onTrack: () => undefined,
    onDataChannel: () => undefined,
    replaceLocalStream: () => undefined,
    createDataChannel: () => dataChannel,
    close: () => undefined
  };
  return peer;
}

interface TransferTestDataChannel extends DataChannelLike {
  readonly sent: string[];
  emitOpen(): void;
  emitMessage(data: string): void;
  emitClose(): void;
  forward?: (data: string) => void;
}

interface TransferTestPeer extends TestPeer {
  dataChannel: TransferTestDataChannel;
  emitRemoteDataChannel(): void;
  closed: number;
}

function makeTransferPeer(): TransferTestPeer {
  let state: TransferTestDataChannel["readyState"] = "connecting";
  let openCb: (() => void) | undefined;
  let messageCb: ((data: string | ArrayBuffer | ArrayBufferView) => void) | undefined;
  let closeCb: (() => void) | undefined;
  let errorCb: ((err: unknown) => void) | undefined;
  let dataChannelCb: ((channel: DataChannelLike) => void) | undefined;
  const sent: string[] = [];
  const dataChannel: TransferTestDataChannel = {
    label: "transfer",
    get readyState() { return state; },
    sent,
    send(data) {
      if (typeof data !== "string") throw new Error("test_only_string_wire");
      sent.push(data);
      dataChannel.forward?.(data);
    },
    close() {
      if (state === "closed") return;
      state = "closed";
      closeCb?.();
    },
    onOpen(cb) { openCb = cb; },
    onMessage(cb) { messageCb = cb; },
    onClose(cb) { closeCb = cb; },
    onError(cb) { errorCb = cb; },
    emitOpen() {
      state = "open";
      openCb?.();
    },
    emitMessage(data) { messageCb?.(data); },
    emitClose() { dataChannel.close(); },
    forward: undefined
  };
  const peer: TransferTestPeer = {
    api: undefined as never,
    remoteDescription: null,
    dataChannel,
    closed: 0,
    emitRemoteDataChannel() { dataChannelCb?.(dataChannel); }
  };
  peer.api = {
    connectionState: "new",
    setLocalDescription: async () => undefined,
    setRemoteDescription: async (description) => { peer.remoteDescription = description; },
    createOffer: async () => ({ type: "offer", sdp: "v=0\r\nm=application 9 DTLS/SCTP 5000" }),
    createAnswer: async () => ({ type: "answer", sdp: "v=0\r\nm=application 9 DTLS/SCTP 5000" }),
    addIceCandidate: async () => undefined,
    onIceCandidate: () => undefined,
    onIceGatheringStateChange: () => undefined,
    onConnectionStateChange: () => undefined,
    onTrack: () => undefined,
    onDataChannel: (cb) => { dataChannelCb = cb; },
    replaceLocalStream: () => undefined,
    createDataChannel: () => dataChannel,
    close: () => { peer.closed += 1; dataChannel.close(); }
  };
  void errorCb;
  return peer;
}

interface TestEnvironment extends WebrtcEnvironment {
  mediaCalls: MediaStreamConstraints[];
}

function makeEnvironment(
  peers: TestPeer[],
  options: {
    peerFactory?: () => TestPeer;
    hashSha256?: (bytes: Uint8Array) => Promise<string>;
    delay?: (ms: number) => Promise<void>;
  } = {}
): TestEnvironment {
  const mediaCalls: MediaStreamConstraints[] = [];
  return {
    createPeerConnection: () => {
      const peer = options.peerFactory?.() ?? makePeer();
      peers.push(peer);
      return peer.api;
    },
    getUserMedia: async (constraints) => {
      mediaCalls.push(constraints);
      return makeStream();
    },
    generateSessionId: () => newSessionID(),
    hashSha256: options.hashSha256,
    now: () => Date.now(),
    delay: options.delay ?? (async () => undefined),
    mediaCalls
  };
}

function makeChannel(ready = true, ownerPublicKeyHex = OWNER): ChannelRuntime & {
  published: Array<{ recipientPublicKeyHex: string; protocol: string; content: unknown }>;
  hashRequests: Array<{ hash: string; locator: "webrtc-sdp" }>;
  hashRequestMessages: Array<{ hash: string; locator: "webrtc-sdp"; messageId: string }>;
  deliver: (content: unknown, publisherPublicKeyHex?: string, protocol?: string) => void;
  deliverForOwner: (
    ownerPublicKeyHex: string,
    content: unknown,
    publisherPublicKeyHex?: string,
    protocol?: string
  ) => void;
  deliverHashRequest: (
    content: { hash: string; locators: Array<{ kind: "webrtc-sdp" }> },
    publisherPublicKeyHex?: string,
    messageId?: string
  ) => void;
} {
  let privateHandler: ((event: Parameters<NonNullable<ChannelRuntime["subscribePrivate"]>>[0]) => void) | undefined;
  let publicHandler: ((event: Parameters<NonNullable<ChannelRuntime["subscribe"]>>[0]) => void) | undefined;
  const published: Array<{ recipientPublicKeyHex: string; protocol: string; content: unknown }> = [];
  const hashRequests: Array<{ hash: string; locator: "webrtc-sdp" }> = [];
  const hashRequestMessages: Array<{ hash: string; locator: "webrtc-sdp"; messageId: string }> = [];
  const deliverForOwner = (
    recipientOwnerPublicKeyHex: string,
    content: unknown,
    publisherPublicKeyHex = TARGET,
    protocol = "bsv8.webrtc.signal.v1"
  ): void => {
    privateHandler?.({
      channel: `bsv8.inbox.${recipientOwnerPublicKeyHex}`,
      publisherPublicKeyHex,
      messageId: "incoming-private-message",
      protocol,
      content: content as never
    });
  };
  return {
    isReady: () => ready,
    publish: vi.fn(async () => ({ messageId: "public-message" })),
    publishHashRequest: vi.fn(async (input) => {
      hashRequests.push(input);
      const messageId = newMessageID();
      hashRequestMessages.push({ ...input, messageId });
      return { messageId };
    }),
    publishPrivate: vi.fn(async (input) => {
      published.push(input);
      return { messageId: "private-message" };
    }),
    subscriptionSet: vi.fn(async (channels: string[]) => ({ channels })),
    subscribe: (handler) => {
      publicHandler = handler;
      return () => { publicHandler = undefined; };
    },
    subscribePrivate: (handler) => {
      privateHandler = handler;
      return () => { privateHandler = undefined; };
    },
    published,
    hashRequests,
    hashRequestMessages,
    deliver: (content, publisherPublicKeyHex = TARGET, protocol = "bsv8.webrtc.signal.v1") => {
      deliverForOwner(ownerPublicKeyHex, content, publisherPublicKeyHex, protocol);
    },
    deliverForOwner,
    deliverHashRequest: (content, publisherPublicKeyHex = TARGET, messageId = newMessageID()) => publicHandler?.({
      channel: "bsv8.hash.request.v1",
      publisherPublicKeyHex,
      messageId,
      content
    })
  };
}

function makeNoticeRegistry(): { registry: NoticeRegistry; records: Map<string, NoticeRecord> } {
  const records = new Map<string, NoticeRecord>();
  const registry: NoticeRegistry = {
    upsert: vi.fn((record) => { records.set(record.id, record); }),
    dismiss: vi.fn((id) => { records.delete(id); }),
    list: vi.fn(() => [...records.values()]),
    subscribe: vi.fn(() => () => undefined),
    removeBySourcePluginId: vi.fn((sourcePluginId) => {
      for (const [id, record] of records) {
        if (record.sourcePluginId === sourcePluginId) records.delete(id);
      }
    })
  };
  return { registry, records };
}

describe("createWebrtcService", () => {
  it("uses Channel readiness as service readiness", () => {
    const channel = makeChannel(true);
    const service = createWebrtcService({
      channel,
      keyspace: makeKeyspace(),
      configStore: createMemoryWebrtcConfigStore()
    });
    expect(service.isReady()).toBe(true);
    service.dispose();
  });

  it("reports not ready while Channel is unavailable", () => {
    const service = createWebrtcService({
      channel: makeChannel(false),
      keyspace: makeKeyspace(),
      configStore: createMemoryWebrtcConfigStore()
    });
    expect(service.isReady()).toBe(false);
    service.dispose();
  });

  it("blocks audio/video calls until a formal call rendezvous protocol exists", async () => {
    const channel = makeChannel();
    const peers: TestPeer[] = [];
    const environment = makeEnvironment(peers);
    const service = createWebrtcService({
      channel,
      keyspace: makeKeyspace(),
      configStore: createMemoryWebrtcConfigStore(),
      env: environment
    });

    await expect(service.startCall({ targetPublicKeyHex: TARGET, mode: "audio" })).rejects.toThrow("call_protocol_unavailable");
    expect(environment.mediaCalls).toHaveLength(0);
    expect(channel.published).toHaveLength(0);
    expect(service.snapshot().lastError).toBe("call_protocol_unavailable");
    service.dispose();
  });

  it("ignores a direct media offer without a matching call rendezvous request", async () => {
    const channel = makeChannel();
    const peers: TestPeer[] = [];
    const environment = makeEnvironment(peers);
    const service = createWebrtcService({
      channel,
      keyspace: makeKeyspace(),
      configStore: createMemoryWebrtcConfigStore(),
      env: environment
    });

    channel.deliver(newOffer(newMessageID(), newSessionID(), "v=0\r\nm=audio 9 RTP/AVP 0"));
    await Promise.resolve();
    expect(service.snapshot().phase).toBe("idle");
    expect(environment.mediaCalls).toHaveLength(0);
    expect(peers).toHaveLength(0);
    service.dispose();
  });

  it("does not request media permission when a call request or offer is received", async () => {
    const channel = makeChannel();
    const peers: TestPeer[] = [];
    const environment = makeEnvironment(peers);
    const service = createWebrtcService({
      channel,
      keyspace: makeKeyspace(),
      configStore: createMemoryWebrtcConfigStore(),
      env: environment
    });
    const requestMessageId = newMessageID();
    const sessionId = newSessionID();
    channel.deliver({ type: "keymaster.webrtc.call.request", session_id: sessionId, mode: "audio" }, TARGET, "bsv8.message.v1");
    channel.deliver(newOffer(requestMessageId, sessionId, "v=0\r\nm=audio 9 RTP/AVP 0"));
    expect(environment.mediaCalls).toHaveLength(0);
    expect(service.snapshot().phase).toBe("idle");
    await expect(service.acceptIncoming()).rejects.toThrow("call_protocol_unavailable");
    expect(environment.mediaCalls).toHaveLength(0);
    service.dispose();
  });

  it("requires contact admission and explicit confirmation before publishing Hash", async () => {
    const channel = makeChannel();
    let resolveHashRequest!: (value: { messageId: string }) => void;
    const hashRequestResult = new Promise<{ messageId: string }>((resolve) => {
      resolveHashRequest = resolve;
    });
    vi.mocked(channel.publishHashRequest).mockImplementation(async (input) => {
      channel.hashRequests.push(input);
      return hashRequestResult;
    });
    const peers: TestPeer[] = [];
    const notices = makeNoticeRegistry();
    const service = createWebrtcService({
      channel,
      keyspace: makeKeyspace(),
      configStore: createMemoryWebrtcConfigStore(),
      env: makeEnvironment(peers),
      noticeRegistry: notices.registry,
      isTransferSenderAllowed: async (publicKeyHex) => publicKeyHex === TARGET
    });
    const sessionId = newSessionID();
    const requestMessageId = newMessageID();
    const hash = "c".repeat(64);

    channel.deliver({
      type: "keymaster.webrtc.transfer.request",
      session_id: sessionId,
      hash,
      kind: "file",
      byte_length: 3,
      file_name: "a.txt",
      mime_type: "text/plain"
    }, TARGET, "bsv8.message.v1");
    await vi.waitFor(() => expect(notices.records.has(`webrtc-transfer-${sessionId}`)).toBe(true));
    expect(channel.hashRequests).toHaveLength(0);
    expect(peers).toHaveLength(0);

    channel.deliver(
      newOffer(requestMessageId, sessionId, "v=0\r\nm=application 9 DTLS/SCTP 5000"),
      TARGET,
      "bsv8.webrtc.signal.v1"
    );
    await Promise.resolve();
    expect(peers).toHaveLength(0);

    const acceptPromise = service.acceptIncomingTransfer(sessionId);
    await vi.waitFor(() => expect(channel.hashRequests).toHaveLength(1));
    expect(peers).toHaveLength(0);
    resolveHashRequest({ messageId: requestMessageId });
    await acceptPromise;
    await vi.waitFor(() => expect(peers).toHaveLength(1));
    await vi.waitFor(() => expect(channel.published.some((item) => {
      try { return parseBodyValue(item.content as never).signal.type === "answer"; } catch { return false; }
    })).toBe(true));
    service.dispose();
  });

  it.each(["success", "failure"] as const)(
    "旧 owner 的 Hash %s 结果不得清除新 owner 的同 session 请求或接受占位",
    async (outcome) => {
      const mutable = makeMutableKeyspace(OWNER);
      const channel = makeChannel(true, OWNER);
      const notices = makeNoticeRegistry();
      const hashResults: Array<{
        resolve: (value: { messageId: string }) => void;
        reject: (reason: Error) => void;
      }> = [];
      vi.mocked(channel.publishHashRequest).mockImplementation(async (input) => {
        channel.hashRequests.push(input);
        return new Promise<{ messageId: string }>((resolve, reject) => {
          hashResults.push({ resolve, reject });
        });
      });
      const service = createWebrtcService({
        channel,
        keyspace: mutable.keyspace,
        configStore: createMemoryWebrtcConfigStore(),
        env: makeEnvironment([]),
        noticeRegistry: notices.registry,
        isTransferSenderAllowed: () => true
      });
      const sessionId = newSessionID();
      const oldHash = "a".repeat(64);
      const newHash = "b".repeat(64);

      channel.deliver({
        type: "keymaster.webrtc.transfer.request",
        session_id: sessionId,
        hash: oldHash,
        kind: "file",
        byte_length: 1
      }, TARGET, "bsv8.message.v1");
      await vi.waitFor(() => expect(notices.records.has(`webrtc-transfer-${sessionId}`)).toBe(true));
      const oldNotice = notices.records.get(`webrtc-transfer-${sessionId}`);
      const staleAccept = oldNotice?.actions.find((action) => action.id === "accept-transfer");
      const staleReject = oldNotice?.actions.find((action) => action.id === "reject-transfer");
      expect(staleAccept).toBeDefined();
      expect(staleReject).toBeDefined();

      // 直接执行旧通知的接受动作，确保闭包捕获的是旧 request，而不是只捕获 sessionId。
      const oldAcceptance = staleAccept!.run();
      await vi.waitFor(() => expect(hashResults).toHaveLength(1));

      mutable.setOwner(OTHER);
      channel.deliverForOwner(OTHER, {
        type: "keymaster.webrtc.transfer.request",
        session_id: sessionId,
        hash: newHash,
        kind: "file",
        byte_length: 1
      }, TARGET, "bsv8.message.v1");
      await vi.waitFor(() => expect(notices.records.has(`webrtc-transfer-${sessionId}`)).toBe(true));

      // 旧 owner 的通知动作仍可能被 UI 异步执行，但只能作用于旧请求对象。
      await staleReject!.run();
      expect(notices.records.has(`webrtc-transfer-${sessionId}`)).toBe(true);

      const newAcceptance = service.acceptIncomingTransfer(sessionId);
      await vi.waitFor(() => expect(hashResults).toHaveLength(2));

      if (outcome === "success") {
        hashResults[0]!.resolve({ messageId: "old-hash-request" });
      } else {
        hashResults[0]!.reject(new Error("old_hash_publish_failed"));
      }
      if (outcome === "success") {
        await expect(oldAcceptance).rejects.toThrow("transfer_owner_changed");
      } else {
        await expect(oldAcceptance).rejects.toThrow("old_hash_publish_failed");
      }

      // B 的接受占位仍在：旧回调不能清掉 B 的 token 让第三个请求抢占 Hash Publish。
      const thirdSessionId = newSessionID();
      channel.deliverForOwner(OTHER, {
        type: "keymaster.webrtc.transfer.request",
        session_id: thirdSessionId,
        hash: "c".repeat(64),
        kind: "file",
        byte_length: 1
      }, TARGET, "bsv8.message.v1");
      await vi.waitFor(() => expect(notices.records.has(`webrtc-transfer-${thirdSessionId}`)).toBe(true));
      await expect(service.acceptIncomingTransfer(thirdSessionId)).rejects.toThrow("busy_local");
      expect(channel.hashRequests).toHaveLength(2);

      hashResults[1]!.resolve({ messageId: "new-hash-request" });
      await newAcceptance;
      expect(notices.records.has(`webrtc-transfer-${sessionId}`)).toBe(false);
      service.dispose();
    }
  );

  it("完成双端文件传输：准入、确认、Hash、offer/answer、分片校验和完成确认", async () => {
    const channelA = makeChannel(true, OWNER);
    const channelB = makeChannel(true, TARGET);
    const peersA: TransferTestPeer[] = [];
    const peersB: TransferTestPeer[] = [];
    const noNegotiationTimeout = async (ms: number): Promise<void> => {
      if (ms !== 15_000) return;
      await new Promise<void>(() => undefined);
    };
    const serviceA = createWebrtcService({
      channel: channelA,
      keyspace: makeKeyspace(OWNER),
      configStore: createMemoryWebrtcConfigStore(),
      env: makeEnvironment(peersA, { peerFactory: makeTransferPeer, delay: noNegotiationTimeout }),
      isTransferSenderAllowed: () => true
    });
    const noticesB = makeNoticeRegistry();
    const serviceB = createWebrtcService({
      channel: channelB,
      keyspace: makeKeyspace(TARGET),
      configStore: createMemoryWebrtcConfigStore(),
      env: makeEnvironment(peersB, { peerFactory: makeTransferPeer }),
      noticeRegistry: noticesB.registry,
      isTransferSenderAllowed: (publicKeyHex) => publicKeyHex === OWNER
    });
    const cursorA = { value: 0 };
    const cursorB = { value: 0 };
    const relayPrivate = (
      from: ReturnType<typeof makeChannel>,
      to: ReturnType<typeof makeChannel>,
      publisherPublicKeyHex: string,
      cursor: { value: number }
    ): void => {
      while (cursor.value < from.published.length) {
        const item = from.published[cursor.value]!;
        cursor.value += 1;
        to.deliver(item.content, publisherPublicKeyHex, item.protocol);
      }
    };
    const file = new Blob(["abc"], { type: "text/plain" });
    const sendPromise = serviceA.sendFile({ targetPublicKeyHex: TARGET, file });
    await vi.waitFor(() => expect(channelA.published).toHaveLength(1));
    const request = channelA.published[0]!.content as {
      type: string;
      session_id: string;
      hash: string;
      kind: string;
      byte_length: number;
    };
    expect(request).toMatchObject({
      type: "keymaster.webrtc.transfer.request",
      kind: "file",
      byte_length: 3,
      hash: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    });
    relayPrivate(channelA, channelB, OWNER, cursorA);
    await vi.waitFor(() => expect(noticesB.records.has(`webrtc-transfer-${request.session_id}`)).toBe(true));
    expect(channelB.hashRequests).toHaveLength(0);

    const acceptPromise = serviceB.acceptIncomingTransfer(request.session_id);
    await vi.waitFor(() => expect(channelB.hashRequestMessages).toHaveLength(1));
    const hashRequest = channelB.hashRequestMessages[0]!;
    channelA.deliverHashRequest(
      { hash: hashRequest.hash, locators: [{ kind: "webrtc-sdp" }] },
      TARGET,
      hashRequest.messageId
    );
    await acceptPromise;
    await vi.waitFor(() => expect(peersA).toHaveLength(1));
    relayPrivate(channelA, channelB, OWNER, cursorA);
    await vi.waitFor(() => expect(channelB.published).toHaveLength(1));
    relayPrivate(channelB, channelA, TARGET, cursorB);
    await vi.waitFor(() => expect(peersB).toHaveLength(1));

    const senderChannel = peersA[0]!.dataChannel;
    const receiverChannel = peersB[0]!.dataChannel;
    senderChannel.forward = (data) => receiverChannel.emitMessage(data);
    receiverChannel.forward = (data) => senderChannel.emitMessage(data);
    peersB[0]!.emitRemoteDataChannel();
    receiverChannel.emitOpen();
    senderChannel.emitOpen();

    await sendPromise;
    expect(senderChannel.sent.map((item) => JSON.parse(item).type)).toEqual([
      "transfer_begin",
      "transfer_chunk",
      "transfer_end"
    ]);
    expect(receiverChannel.sent.map((item) => JSON.parse(item).type)).toEqual(["transfer_complete"]);
    expect(peersA[0]!.closed).toBeGreaterThan(0);
    expect(peersB[0]!.closed).toBeGreaterThan(0);
    serviceA.dispose();
    serviceB.dispose();
  });

  it("在出站 Hash 前同步占用 transfer 槽，第二次发送立即失败", async () => {
    let resolveHash!: (value: string) => void;
    const hashGate = new Promise<string>((resolve) => { resolveHash = resolve; });
    let hashCalls = 0;
    const peers: TestPeer[] = [];
    const channel = makeChannel();
    const service = createWebrtcService({
      channel,
      keyspace: makeKeyspace(),
      configStore: createMemoryWebrtcConfigStore(),
      env: makeEnvironment(peers, {
        hashSha256: async () => {
          hashCalls += 1;
          return hashGate;
        }
      })
    });
    const file = new Blob(["first"]);
    const first = service.sendFile({ targetPublicKeyHex: TARGET, file });
    await vi.waitFor(() => expect(hashCalls).toBe(1));
    await expect(service.sendFile({ targetPublicKeyHex: TARGET, file: new Blob(["second"]) }))
      .rejects.toThrow("busy_local");
    expect(channel.published).toHaveLength(0);
    service.dispose();
    resolveHash("a".repeat(64));
    await expect(first).rejects.toThrow("service_disposed");
  });

  it("出站 Hash 期间切换 owner 会使旧发送失效且不发布请求", async () => {
    let resolveHash!: (value: string) => void;
    const hashGate = new Promise<string>((resolve) => { resolveHash = resolve; });
    let hashCalls = 0;
    const mutable = makeMutableKeyspace();
    const channel = makeChannel();
    const service = createWebrtcService({
      channel,
      keyspace: mutable.keyspace,
      configStore: createMemoryWebrtcConfigStore(),
      env: makeEnvironment([], {
        hashSha256: async () => {
          hashCalls += 1;
          return hashGate;
        }
      })
    });
    const sending = service.sendFile({ targetPublicKeyHex: TARGET, file: new Blob(["owner-fence"]) });
    await vi.waitFor(() => expect(hashCalls).toBe(1));
    mutable.setOwner(OTHER);
    resolveHash("b".repeat(64));
    await expect(sending).rejects.toThrow("transfer_owner_changed");
    expect(channel.published).toHaveLength(0);
    service.dispose();
  });

  it("通讯录准入查询完成后若 service 已 dispose，不得生成 notice 或 pending", async () => {
    let resolveAdmission!: (allowed: boolean) => void;
    let admissionCalls = 0;
    let admissionSignal: AbortSignal | undefined;
    const admissionGate = new Promise<boolean>((resolve) => { resolveAdmission = resolve; });
    const notices = makeNoticeRegistry();
    const channel = makeChannel();
    const service = createWebrtcService({
      channel,
      keyspace: makeKeyspace(),
      configStore: createMemoryWebrtcConfigStore(),
      noticeRegistry: notices.registry,
      isTransferSenderAllowed: async (_publicKeyHex, signal) => {
        admissionCalls += 1;
        admissionSignal = signal;
        return admissionGate;
      }
    });
    channel.deliver({
      type: "keymaster.webrtc.transfer.request",
      session_id: newSessionID(),
      hash: "d".repeat(64),
      kind: "file",
      byte_length: 1
    }, TARGET, "bsv8.message.v1");
    await vi.waitFor(() => expect(admissionCalls).toBe(1));
    service.dispose();
    expect(admissionSignal?.aborted).toBe(true);
    resolveAdmission(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(notices.registry.upsert).not.toHaveBeenCalled();
    expect(notices.records).toHaveLength(0);
  });

  it("通讯录准入查询完成后若 owner 已切换，不得生成 notice 或 pending", async () => {
    let resolveAdmission!: (allowed: boolean) => void;
    let admissionCalls = 0;
    let admissionSignal: AbortSignal | undefined;
    const admissionGate = new Promise<boolean>((resolve) => { resolveAdmission = resolve; });
    const mutable = makeMutableKeyspace();
    const notices = makeNoticeRegistry();
    const channel = makeChannel();
    const service = createWebrtcService({
      channel,
      keyspace: mutable.keyspace,
      configStore: createMemoryWebrtcConfigStore(),
      noticeRegistry: notices.registry,
      isTransferSenderAllowed: async (_publicKeyHex, signal) => {
        admissionCalls += 1;
        admissionSignal = signal;
        return admissionGate;
      }
    });
    channel.deliver({
      type: "keymaster.webrtc.transfer.request",
      session_id: newSessionID(),
      hash: "e".repeat(64),
      kind: "file",
      byte_length: 1
    }, TARGET, "bsv8.message.v1");
    await vi.waitFor(() => expect(admissionCalls).toBe(1));
    mutable.setOwner(OTHER);
    expect(admissionSignal?.aborted).toBe(true);
    resolveAdmission(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(notices.registry.upsert).not.toHaveBeenCalled();
    expect(notices.records).toHaveLength(0);
    service.dispose();
  });

  it("限制不同发送者同时进行的通讯录准入查询数量", async () => {
    const admissionGates: Array<(allowed: boolean) => void> = [];
    const admissionCalls: string[] = [];
    const notices = makeNoticeRegistry();
    const channel = makeChannel();
    const service = createWebrtcService({
      channel,
      keyspace: makeKeyspace(),
      configStore: createMemoryWebrtcConfigStore(),
      noticeRegistry: notices.registry,
      isTransferSenderAllowed: (publicKeyHex) => {
        admissionCalls.push(publicKeyHex);
        return new Promise<boolean>((resolve) => { admissionGates.push(resolve); });
      }
    });
    for (let index = 0; index < 9; index += 1) {
      const sender = `${index % 2 === 0 ? "02" : "03"}${index.toString(16).padStart(2, "0")}${"f".repeat(62)}`;
      channel.deliver({
        type: "keymaster.webrtc.transfer.request",
        session_id: newSessionID(),
        hash: index.toString(16).padStart(64, "0"),
        kind: "file",
        byte_length: 1
      }, sender, "bsv8.message.v1");
    }
    await vi.waitFor(() => expect(admissionCalls).toHaveLength(8));
    expect(new Set(admissionCalls).size).toBe(8);
    for (const resolve of admissionGates) resolve(false);
    service.dispose();
  });
});
