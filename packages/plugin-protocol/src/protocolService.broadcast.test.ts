// packages/plugin-protocol/src/protocolService.broadcast.test.ts
// 广播协议族单元测试。
//
// 这里不再走完整 transport 链路，而是直接调用 ProtocolServiceImpl 的
// 广播私有入口，验证：
//   - broadcast.publish：入参校验 + core.publish 转发；
//   - broadcast.subscription_set：replace 语义 + core 订阅挂载；
//   - broadcast.subscription_list：返回 caller 侧订阅集合；
//   - broadcast.message_received：按 caller origin 下推；
//   - endSession：清理 caller 订阅，避免跨会话残留。

import { beforeEach, describe, expect, it } from "vitest";
import {
  type BroadcastCore,
  type BroadcastMessage,
  type BroadcastPublishInput,
  type BroadcastSubscribeInput,
  type BroadcastUnsubscribe,
  type ConnectSessionRecord,
  type ProtocolEventMessage,
  type ProtocolResultMessage,
  type VaultService
} from "@keymaster/contracts";
import { ProtocolServiceImpl, type ProtocolServiceDeps } from "./protocolService.js";

const TEST_PRIV_HEX = "0000000000000000000000000000000000000000000000000000000000000001";
const TEST_PUB_HEX = "0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798";
const ORIGIN = "https://abc.com";
const SESSION_ID = "sess-test-1";

interface FakeWindow {
  postMessage: (msg: unknown, origin: string) => void;
  closed: boolean;
  messages: { msg: unknown; origin: string }[];
}

function makeFakeOpener(): FakeWindow {
  const messages: { msg: unknown; origin: string }[] = [];
  return {
    postMessage(msg: unknown, origin: string) {
      messages.push({ msg, origin });
    },
    closed: false,
    messages
  };
}

function makeVaultStub(): VaultService {
  return {
    status: () => "unlocked" as const,
    async createActiveKeyCrypto() {
      return { hex: TEST_PRIV_HEX } as { hex: string };
    },
    async withMasterKey(masterKey: unknown, fn: (k: unknown) => unknown) {
      return fn(masterKey);
    },
    unlock: async () => ({ status: "accepted" as const }),
    lock: async () => ({ status: "accepted" as const }),
    isInitialized: () => true,
    importRuntime: async () => {},
    exportRuntimeBootstrap: async () => ({
      ownerPublicKeyHex: TEST_PUB_HEX,
      ownerLabel: "test",
      privateKeyHex: TEST_PRIV_HEX,
      capabilities: [],
      createdAt: Date.now()
    }),
    onStatusChange: () => () => {}
  } as unknown as VaultService;
}

const FAKE_SESSION: ConnectSessionRecord = {
  sessionId: SESSION_ID,
  origin: ORIGIN,
  ownerPublicKeyHex: TEST_PUB_HEX,
  ownerLabel: "test",
  claimsSnapshot: {},
  createdAt: 0,
  lastUsedAt: 0,
  revokedAt: null
};

function makeMemoryStorage(): {
  getConnectSession: (id: string) => Promise<ConnectSessionRecord | null>;
  putConnectSession: (rec: ConnectSessionRecord) => Promise<void>;
} {
  const sessions = new Map<string, ConnectSessionRecord>([[SESSION_ID, FAKE_SESSION]]);
  return {
    async getConnectSession(id) {
      return sessions.get(id) ?? null;
    },
    async putConnectSession(rec) {
      sessions.set(rec.sessionId, rec);
    }
  };
}

interface PostedMessage {
  msg: ProtocolResultMessage | ProtocolEventMessage;
  origin: string;
}

/**
 * BroadcastCore 假实现：让测试能观察 publish / subscribe 入参，
 * 并且手动模拟 core 推送 BroadcastMessage。
 */
class FakeBroadcastCore implements BroadcastCore {
  publishCalls: BroadcastPublishInput[] = [];
  subscribeCalls: BroadcastSubscribeInput[] = [];
  private subscribers: Array<(msg: BroadcastMessage) => void> = [];

  providers(): never {
    throw new Error("not used");
  }
  async connectForOwner(): Promise<never> {
    throw new Error("not used");
  }
  async disconnect(): Promise<void> {}
  markStructurallyOffline(): void {}
  setNextReconnectAtMs(): void {}
  getNextReconnectAtMs(): null {
    return null;
  }
  isReady(): boolean {
    return true;
  }
  async publish(input: BroadcastPublishInput): Promise<BroadcastMessage> {
    this.publishCalls.push(input);
    return {
      channelId: input.channelId,
      protocolId: input.protocolId,
      clientMessageId: input.clientMessageId,
      createdAtMs: input.createdAtMs,
      bodyBytes: input.bodyBytes,
      publisherPublicKeyHex: TEST_PUB_HEX
    };
  }
  subscribe(input: BroadcastSubscribeInput): BroadcastUnsubscribe {
    this.subscribeCalls.push(input);
    if (input.handler) this.subscribers.push(input.handler);
    return () => {
      this.subscribers = this.subscribers.filter((s) => s !== input.handler);
    };
  }
  listSubscribedChannels(): string[] {
    return [];
  }
  inspect() {
    return {
      state: "bound" as const,
      providerId: "fake",
      ownerPublicKeyHex: TEST_PUB_HEX,
      lastError: null,
      subscribedChannels: [],
      nextReconnectAtMs: null
    };
  }
  onStateChange(): BroadcastUnsubscribe {
    return () => {};
  }
  currentHandle(): null {
    return null;
  }
  setActiveProviderId(): Promise<void> {
    return Promise.resolve();
  }
  getActiveProviderId(): string | null {
    return "fake";
  }

  /** 测试辅助：模拟 core 向所有 subscriber 推送一条消息。 */
  pushFake(msg: BroadcastMessage): void {
    for (const h of this.subscribers) h(msg);
  }
}

type BroadcastTestService = {
  setVaultLockState(vaultLocked: boolean): void;
  startSession(): void;
  endSession(): void;
  executeBroadcastPublish(rec: unknown): Promise<unknown>;
  executeBroadcastSubscriptionSet(rec: unknown): Promise<unknown>;
  executeBroadcastSubscriptionList(rec: unknown): Promise<unknown>;
};

function makeDeps(core: BroadcastCore, posted: PostedMessage[]): ProtocolServiceDeps {
  return {
    vault: makeVaultStub(),
    keyspace: {
      active: () => ({ activePublicKeyHex: TEST_PUB_HEX, activeKeyspaceId: "k1" }),
      getKey: async () => ({ publicKeyHex: TEST_PUB_HEX })
    } as unknown as ProtocolServiceDeps["keyspace"],
    storageDb: makeMemoryStorage() as unknown as ProtocolServiceDeps["storageDb"],
    broadcastCore: core,
    postResult: (target, origin, msg) => {
      posted.push({ msg, origin });
      (target as unknown as FakeWindow).messages.push({ msg, origin });
    }
  };
}

function makeRequest(
  source: FakeWindow,
  origin: string,
  method: "broadcast.publish" | "broadcast.subscription_set" | "broadcast.subscription_list",
  params: unknown,
  id: string
): unknown {
  return {
    recordId: id,
    transportRequestId: id,
    source: source as unknown as Window,
    origin,
    method,
    params,
    phase: "queued",
    decision: "pending",
    status: "pending",
    enteredPhaseAt: Date.now(),
    autoApproved: false,
    connectSessionId: SESSION_ID,
    ownerPublicKeyHex: TEST_PUB_HEX,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    finishedAt: 0,
    errorCode: "",
    errorMessage: ""
  };
}

function countEventMessages(opener: FakeWindow): number {
  return opener.messages.filter((m) => (m.msg as { type?: string }).type === "event").length;
}

function findEventByType(opener: FakeWindow, eventType: string): ProtocolEventMessage | undefined {
  return opener.messages.find((m) => {
    const msg = m.msg as { type?: string; event?: string };
    return msg.type === "event" && msg.event === eventType;
  })?.msg as ProtocolEventMessage | undefined;
}

function findPostedResult(posted: PostedMessage[], id: string): ProtocolResultMessage | undefined {
  return posted.find((m) => {
    const msg = m.msg as { type?: string; id?: string };
    return msg.type === "result" && msg.id === id;
  })?.msg as ProtocolResultMessage | undefined;
}

describe("protocolService broadcast.*（施工单 2026-07-08 001）", () => {
  let core: FakeBroadcastCore;
  let service: BroadcastTestService;
  let opener: FakeWindow;
  let posted: PostedMessage[];

  beforeEach(() => {
    core = new FakeBroadcastCore();
    opener = makeFakeOpener();
    posted = [];
    service = new ProtocolServiceImpl({
      ...makeDeps(core, posted),
      resolveOpener: () => opener as unknown as Window
    }) as unknown as BroadcastTestService;
    service.setVaultLockState(false);
    service.startSession();
  });

  it("broadcast.publish: invalid channelId 会直接返回错误，不触发 core.publish", async () => {
    const rec = makeRequest(
      opener,
      ORIGIN,
      "broadcast.publish",
      {
        connectSessionId: SESSION_ID,
        channelId: "",
        protocolId: "x",
        clientMessageId: "c",
        createdAtMs: 1,
        bodyBase64: ""
      },
      "r1"
    );

    await expect(service.executeBroadcastPublish(rec)).rejects.toBeDefined();
    expect(core.publishCalls).toHaveLength(0);
  });

  it("broadcast.publish: valid 请求会转发到 core.publish 并返回结果", async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    const rec = makeRequest(
      opener,
      ORIGIN,
      "broadcast.publish",
      {
        connectSessionId: SESSION_ID,
        channelId: "ch-1",
        protocolId: "pricecast.bsv_price.v1",
        clientMessageId: "cmid-1",
        createdAtMs: 100,
        bodyBase64: "AQIDBA=="
      },
      "r-pub"
    );

    const result = (await service.executeBroadcastPublish(rec)) as {
      channelId: string;
      protocolId: string;
      clientMessageId: string;
      createdAtMs: number;
      bodyBase64: string;
      publisherPublicKeyHex: string;
    };

    expect(result.channelId).toBe("ch-1");
    expect(result.bodyBase64).toBe("AQIDBA==");
    expect(core.publishCalls).toHaveLength(1);
    expect(core.publishCalls[0]?.channelId).toBe("ch-1");
    expect(core.publishCalls[0]?.bodyBytes).toEqual(body);
    expect(findPostedResult(posted, "r-pub")).toBeUndefined();
  });

  it("broadcast.subscription_set: replace 语义会覆盖 caller 当前订阅", async () => {
    const first = makeRequest(
      opener,
      ORIGIN,
      "broadcast.subscription_set",
      { connectSessionId: SESSION_ID, channelIds: ["ch-a", "ch-b"] },
      "r1"
    );
    const second = makeRequest(
      opener,
      ORIGIN,
      "broadcast.subscription_set",
      { connectSessionId: SESSION_ID, channelIds: ["ch-c"] },
      "r2"
    );

    const firstResult = (await service.executeBroadcastSubscriptionSet(first)) as {
      channelIds: string[];
    };
    const secondResult = (await service.executeBroadcastSubscriptionSet(second)) as {
      channelIds: string[];
    };

    expect(firstResult.channelIds).toEqual(["ch-a", "ch-b"]);
    expect(secondResult.channelIds).toEqual(["ch-c"]);
    expect(core.subscribeCalls).toHaveLength(2);
    expect(core.subscribeCalls[0]?.channelIds).toEqual(["ch-a", "ch-b"]);
    expect(core.subscribeCalls[1]?.channelIds).toEqual(["ch-c"]);
  });

  it("broadcast.subscription_list: 返回当前 caller 的订阅集合", async () => {
    await service.executeBroadcastSubscriptionSet(
      makeRequest(
        opener,
        ORIGIN,
        "broadcast.subscription_set",
        { connectSessionId: SESSION_ID, channelIds: ["ch-x"] },
        "r-set"
      )
    );

    const result = (await service.executeBroadcastSubscriptionList(
      makeRequest(
        opener,
        ORIGIN,
        "broadcast.subscription_list",
        { connectSessionId: SESSION_ID },
        "r-list"
      )
    )) as { channelIds: string[] };

    expect(result.channelIds).toEqual(["ch-x"]);
  });

  it("broadcast.message_received 会按 caller origin 下推，不使用 '*'", async () => {
    await service.executeBroadcastSubscriptionSet(
      makeRequest(
        opener,
        ORIGIN,
        "broadcast.subscription_set",
        { connectSessionId: SESSION_ID, channelIds: ["pricecast-channel"] },
        "r-setup"
      )
    );

    const before = countEventMessages(opener);
    core.pushFake({
      channelId: "pricecast-channel",
      protocolId: "pricecast.bsv_price.v1",
      clientMessageId: "cmid-1",
      createdAtMs: 1000,
      bodyBytes: new Uint8Array([1, 2, 3, 4]),
      publisherPublicKeyHex: TEST_PUB_HEX
    });

    const after = countEventMessages(opener);
    expect(after).toBe(before + 1);

    const event = findEventByType(opener, "broadcast.message_received");
    expect(event).toBeDefined();
    if (!event) throw new Error("expected broadcast.message_received event");
    expect(opener.messages.at(-1)?.origin).toBe(ORIGIN);
    expect(event.data).toMatchObject({
      message: {
        channelId: "pricecast-channel",
        publisherPublicKeyHex: TEST_PUB_HEX,
        bodyBase64: "AQIDBA=="
      }
    });
  });

  it("endSession 会清理 caller 订阅，避免跨会话残留", async () => {
    await service.executeBroadcastSubscriptionSet(
      makeRequest(
        opener,
        ORIGIN,
        "broadcast.subscription_set",
        { connectSessionId: SESSION_ID, channelIds: ["x"] },
        "r-setup"
      )
    );

    core.pushFake({
      channelId: "x",
      protocolId: "p",
      clientMessageId: "c",
      createdAtMs: 1,
      bodyBytes: new Uint8Array(),
      publisherPublicKeyHex: TEST_PUB_HEX
    });
    const before = countEventMessages(opener);

    service.endSession();

    core.pushFake({
      channelId: "x",
      protocolId: "p",
      clientMessageId: "c-2",
      createdAtMs: 2,
      bodyBytes: new Uint8Array(),
      publisherPublicKeyHex: TEST_PUB_HEX
    });

    expect(countEventMessages(opener)).toBe(before);
  });
});
