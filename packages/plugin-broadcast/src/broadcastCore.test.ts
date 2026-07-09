// packages/plugin-broadcast/src/broadcastCore.test.ts
// 广播 core 单测（v1）。
//
// 测试覆盖：
//   - 注册表：register / unregister / setActive / onActiveChange；
//   - core：subscribe union 重算 + 远端推送分发；
//   - envelope 编 / 解 + 验签（wire 顺序：[version, pubkey, channelId,
//     protocolId, clientMessageId, createdAtMs, bodyBytes]）；
//   - channelId → handler 路由；
//   - provider 远端断线 → state closed + nextReconnectAtMs 设值。
//
// v1 关键语义：
//   - publish 成功**不**回包业务字段；
//   - 推送事件是 2 元素 `[envelopeBytes, signatureBytes]`；
//   - 订阅者**不**做 publisher-vs-bound-owner 过滤：合法签名的任何
//     publisher 都可以触发本地分发。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cborDecode, cborEncode } from "@keymaster/contracts";
import type {
  BroadcastConnectOutcome,
  BroadcastCore,
  BroadcastProvider,
  BroadcastProviderHandle,
  BroadcastProviderOperations,
  BroadcastProviderSigner,
  KeyspaceService,
  ProviderBroadcastEvent,
  ProviderReplaceSubscriptionsInput,
  VaultService
} from "@keymaster/contracts";
import { BroadcastCoreImpl, type BroadcastCoreConfig } from "./broadcastCore.js";
import { verifyBroadcastEnvelope } from "./signer.js";

class FakeProvider implements BroadcastProvider {
  readonly id: string;
  readonly displayName: string;
  lastSigner: BroadcastProviderSigner | null = null;
  currentHandle: FakeOps | null = null;
  healthState: { isHealthy: boolean; lastError: string | null; lastConnectedAtMs: number } = {
    isHealthy: false,
    lastError: null,
    lastConnectedAtMs: 0
  };

  constructor(id: string) {
    this.id = id;
    this.displayName = id;
  }

  async bind(input: { signer: BroadcastProviderSigner }): Promise<BroadcastProviderHandle> {
    this.lastSigner = input.signer;
    const handle = new FakeOps(this);
    this.currentHandle = handle;
    this.healthState = {
      isHealthy: true,
      lastError: null,
      lastConnectedAtMs: Date.now()
    };
    return handle;
  }

  async shutdown(): Promise<void> {
    if (this.currentHandle) {
      this.currentHandle.close();
      this.currentHandle = null;
    }
  }

  health(): { isHealthy: boolean; lastError: string | null; lastConnectedAtMs: number } {
    return this.healthState;
  }
}

class FakeOps implements BroadcastProviderOperations {
  stateValue: "idle" | "connecting" | "bound" | "closed" = "bound";
  publishCalls = 0;
  publishArgs: { envelopeBytes: Uint8Array; signatureBytes: Uint8Array }[] = [];
  replaceCalls: ProviderReplaceSubscriptionsInput[] = [];
  broadcastHandlers: ((ev: ProviderBroadcastEvent) => void)[] = [];
  closeHandlers: (() => void)[] = [];
  closed = false;

  constructor(public readonly owner: FakeProvider) {}

  state() {
    return this.stateValue;
  }

  close() {
    this.closed = true;
    this.stateValue = "closed";
  }

  async publish(input: {
    envelopeBytes: Uint8Array;
    signatureBytes: Uint8Array;
  }): Promise<void> {
    this.publishCalls += 1;
    this.publishArgs.push(input);
  }

  async replaceSubscriptions(
    input: ProviderReplaceSubscriptionsInput
  ): Promise<void> {
    this.replaceCalls.push(input);
  }

  async listSubscriptions() {
    return { channelIds: this.replaceCalls[this.replaceCalls.length - 1]?.channelIds ?? [] };
  }

  subscribeBroadcasts(handler: (ev: ProviderBroadcastEvent) => void): () => void {
    this.broadcastHandlers.push(handler);
    return () => {
      this.broadcastHandlers = this.broadcastHandlers.filter((h) => h !== handler);
    };
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.push(handler);
    return () => {
      this.closeHandlers = this.closeHandlers.filter((h) => h !== handler);
    };
  }
}

function makeFakeVault(unlocked: boolean): VaultService {
  return {
    status: () => (unlocked ? "unlocked" : "locked"),
    onStatusChange: () => () => undefined,
    listKeys: async () => [],
    getKey: async () => undefined,
    withPrivateKey: async (_hex: string, fn: (m: { hex: string }) => Promise<unknown> | unknown) =>
      fn({ hex: "00".repeat(32) }),
    hasVault: async () => false,
    createVault: async () => undefined,
    createVaultWithInitialKey: async () => {
      throw new Error("not used");
    },
    createVaultWithImportedKey: async () => {
      throw new Error("not used");
    },
    unlock: async () => undefined,
    lock: async () => undefined,
    verifyPassword: async () => undefined,
    finalizeEmptyVaultAfterLastKeyDeletion: async () => undefined,
    recoverEmptyVaultToUninitialized: async () => undefined,
    importPrivateKey: async () => {
      throw new Error("not used");
    },
    generateKey: async () => {
      throw new Error("not used");
    },
    deleteKeyMaterial: async () => undefined,
    removeKey: async () => {
      throw new Error("not used");
    },
    exportPrivateKey: async () => {
      throw new Error("not used");
    },
    findByAddress: async () => undefined
  } as unknown as VaultService;
}

function makeFakeKeyspace(activeHex: string | null): KeyspaceService {
  return {
    active: () => ({ activePublicKeyHex: activeHex ?? undefined }),
    getKey: async (hex: string) =>
      hex === activeHex
        ? {
            publicKeyHex: hex,
            label: "test",
            capabilities: ["p2pkh"],
            createdAt: "2026-01-01T00:00:00Z"
          }
        : undefined,
    onActiveChange: () => () => undefined
  } as unknown as KeyspaceService;
}

/** 一个固定的、可验签的 secp256k1 公钥 / 私钥对（noble）。 */
import { secp256k1 } from "@noble/curves/secp256k1.js";

const PRIV_HEX = "11".repeat(32);
const PUB_HEX = bytesToHex(secp256k1.getPublicKey(hexToBytes(PRIV_HEX), true));

const PRIV_HEX_OTHER = "22".repeat(32);
const PUB_HEX_OTHER = bytesToHex(secp256k1.getPublicKey(hexToBytes(PRIV_HEX_OTHER), true));

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  }
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

interface CoreHarness {
  core: BroadcastCore;
  provider: FakeProvider;
  teardown(): Promise<void>;
}

async function makeCore(input?: { activeProvider?: boolean }): Promise<CoreHarness> {
  const cfg: BroadcastCoreConfig = {
    signerProvider: async () => ({
      publicKeyHex: PUB_HEX,
      privateKeyHex: PRIV_HEX,
      signChallenge: async () => "00".repeat(64)
    }),
    keyspace: makeFakeKeyspace(PUB_HEX),
    vault: makeFakeVault(true),
    reconnectDelayMs: 5_000
  };
  const core = BroadcastCoreImpl.create(cfg);
  const provider = new FakeProvider("hubcast");
  core.providers().register(provider);
  if (input?.activeProvider ?? true) {
    await core.providers().setActive("hubcast");
    const result = await core.connectForOwner(PUB_HEX);
    expect(result.kind).toBe("connected");
  }
  return {
    core,
    provider,
    teardown: async () => {
      await core.disconnect();
      await provider.shutdown();
    }
  };
}

/**
 * 构造一个 wire-shape 正确的 envelope + 配套签名。
 *
 * wire 顺序固定：[version, publisherPublicKey33, channelId, protocolId,
 * clientMessageId, createdAtMs, bodyBytes]。
 */
async function makeSignedEnvelope(input: {
  channelId: string;
  protocolId?: string;
  clientMessageId?: string;
  createdAtMs: number;
  bodyBytes: Uint8Array;
  privKeyHex: string;
  pubKeyHex: string;
}): Promise<{ envelopeBytes: Uint8Array; signatureBytes: Uint8Array }> {
  const pubBytes = hexToBytes(input.pubKeyHex);
  const envelopeBytes = cborEncode([
    1,
    pubBytes,
    input.channelId,
    input.protocolId ?? "demo",
    input.clientMessageId ?? "cmid",
    input.createdAtMs,
    input.bodyBytes
  ]);
  const digest = await import("@noble/hashes/sha2.js").then((m) =>
    m.sha256(envelopeBytes)
  );
  const sig = secp256k1.sign(digest, hexToBytes(input.privKeyHex), {
    prehash: false,
    format: "compact"
  });
  return { envelopeBytes, signatureBytes: sig };
}

describe("BroadcastCoreImpl", () => {
  let harness: CoreHarness | null = null;

  afterEach(async () => {
    if (harness) {
      await harness.teardown();
      harness = null;
    }
    vi.restoreAllMocks();
  });

  it("registers providers + enforces duplicate id", async () => {
    harness = await makeCore({ activeProvider: false });
    const reg = harness.core.providers();
    expect(reg.list().length).toBe(1);
    // 2026-07-08 001 硬切换：core 在 `register()` 阶段会按 userCleared /
    // 持久值决策自动 setActive；本次没有持久值且 userCleared=false →
    // 第一个 provider 注册后立即成为默认 active。
    expect(reg.activeSnapshot().providerId).toBe("hubcast");
    const dup = new FakeProvider("hubcast");
    expect(() => reg.register(dup)).toThrow(/already registered/);
    // 重复注册抛错后，原 active 保持不变；**不**回退到 null。
    expect(reg.activeSnapshot().providerId).toBe("hubcast");
    await reg.setActive("hubcast");
    expect(reg.activeSnapshot().providerId).toBe("hubcast");
    reg.unregister("hubcast");
    expect(reg.activeSnapshot().providerId).toBeNull();
  });

  it("publishes a signed envelope whose wire bytes match the v1 7-element order", async () => {
    harness = await makeCore();
    const msg = await harness.core.publish({
      channelId: "trading.btc-usd",
      protocolId: "trading.pair.v1",
      clientMessageId: "cmid-1",
      createdAtMs: 1_700_000_000_000,
      bodyBytes: new TextEncoder().encode("hello")
    });
    expect(msg.publisherPublicKeyHex).toBe(PUB_HEX);
    // v1 publish success 不回包业务字段
    expect((msg as unknown as Record<string, unknown>).receivedAtMs).toBeUndefined();
    const ops = harness.provider.currentHandle!;
    expect(ops.publishCalls).toBe(1);
    const sent = ops.publishArgs[0]!;
    // 断言 envelopeBytes 是 7 元素数组，且 index 1 是 publisherPublicKey
    const decoded = cborDecode(sent.envelopeBytes) as unknown[];
    expect(decoded.length).toBe(7);
    expect(decoded[0]).toBe(1); // envelopeVersion
    expect(decoded[1]).toBeInstanceOf(Uint8Array);
    expect((decoded[1] as Uint8Array).length).toBe(33);
    expect(bytesToHex(decoded[1] as Uint8Array)).toBe(PUB_HEX);
    expect(decoded[2]).toBe("trading.btc-usd");
    expect(decoded[3]).toBe("trading.pair.v1");
    expect(decoded[4]).toBe("cmid-1");
    expect(decoded[5]).toBe(1_700_000_000_000);
    expect(decoded[6]).toBeInstanceOf(Uint8Array);
    expect(sent.signatureBytes.length).toBe(64);
  });

  it("rejects publish when not ready", async () => {
    const cfg: BroadcastCoreConfig = {
      signerProvider: async () => null,
      keyspace: makeFakeKeyspace(null),
      vault: makeFakeVault(false),
      reconnectDelayMs: 5_000
    };
    const core = BroadcastCoreImpl.create(cfg);
    core.providers().register(new FakeProvider("hubcast"));
    await expect(
      core.publish({
        channelId: "x",
        protocolId: "y",
        clientMessageId: "z",
        createdAtMs: 1,
        bodyBytes: new Uint8Array([1])
      })
    ).rejects.toThrow(/not_ready/);
    await core.disconnect();
  });

  it("aggregates local subscriptions into a union and pushes to provider", async () => {
    harness = await makeCore();
    const seenA: string[] = [];
    const seenB: string[] = [];
    const offA = harness.core.subscribe({
      channelIds: ["ch.a", "ch.shared"],
      handler: (m) => seenA.push(m.channelId)
    });
    const offB = harness.core.subscribe({
      channelIds: ["ch.b", "ch.shared"],
      handler: (m) => seenB.push(m.channelId)
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(harness.provider.currentHandle?.replaceCalls.length).toBeGreaterThan(0);
    const last = harness.provider.currentHandle?.replaceCalls.at(-1);
    expect(last?.channelIds.slice().sort()).toEqual(["ch.a", "ch.b", "ch.shared"].sort());
    expect(harness.core.listSubscribedChannels().slice().sort()).toEqual(
      ["ch.a", "ch.b", "ch.shared"].sort()
    );
    offA();
    offB();
    await new Promise((r) => setTimeout(r, 0));
    expect(harness.core.listSubscribedChannels()).toEqual([]);
  });

  it("dispatches broadcasts that match a subscribed channel", async () => {
    harness = await makeCore();
    const received: { channel: string; body: string }[] = [];
    harness.core.subscribe({
      channelIds: ["ch.match"],
      handler: (m) => {
        received.push({
          channel: m.channelId,
          body: new TextDecoder().decode(m.bodyBytes)
        });
      }
    });
    await new Promise((r) => setTimeout(r, 0));
    const { envelopeBytes, signatureBytes } = await makeSignedEnvelope({
      channelId: "ch.match",
      createdAtMs: 1_700_000_000_000,
      bodyBytes: new TextEncoder().encode("payload"),
      privKeyHex: PRIV_HEX,
      pubKeyHex: PUB_HEX
    });
    const ev: ProviderBroadcastEvent = { envelopeBytes, signatureBytes };
    const ops = harness.provider.currentHandle;
    expect(ops).not.toBeNull();
    ops!.broadcastHandlers.forEach((h) => h(ev));
    expect(received.length).toBe(1);
    expect(received[0]).toEqual({ channel: "ch.match", body: "payload" });
  });

  it("provider-generic: core dispatches any verify-passing envelope to its exact-channel subscription regardless of publisher", async () => {
    // 这是一条 provider-generic 行为测试,**不**是 HubCast 真实链路的正例:
    //   - 真实 HubCast 服务端会在 publish 阶段拒绝
    //     `channelId` 前缀 != publisherPublicKeyHex 的请求,也会拒绝
    //     publisher != bound owner 的请求;
    //   - 这里手工构造的事件跳过了服务端那条闸门,直接模拟一个签
    //     名合法但 channelId 不带 `<pubkey>.` 前缀的 envelope;
    //   - 测试断言的语义是"core 只信 verify + 本地 union,不做
    //     publisher 身份过滤"——这条约束是 broadcast core provider-
    //     generic 抽象的一部分,属于 contract / 注释层面已被接受的
    //     偏差(见施工单 2026-07-06/002),不属于 HubCast 业务语义。
    harness = await makeCore();
    const received: { channel: string; publisher: string; body: string }[] = [];
    harness.core.subscribe({
      channelIds: ["ch.shared"],
      handler: (m) => {
        received.push({
          channel: m.channelId,
          publisher: m.publisherPublicKeyHex,
          body: new TextDecoder().decode(m.bodyBytes)
        });
      }
    });
    await new Promise((r) => setTimeout(r, 0));
    const { envelopeBytes, signatureBytes } = await makeSignedEnvelope({
      channelId: "ch.shared",
      createdAtMs: 1_700_000_000_001,
      bodyBytes: new TextEncoder().encode("from-other"),
      privKeyHex: PRIV_HEX_OTHER,
      pubKeyHex: PUB_HEX_OTHER
    });
    const ev: ProviderBroadcastEvent = { envelopeBytes, signatureBytes };
    harness.provider.currentHandle!.broadcastHandlers.forEach((h) => h(ev));
    expect(received.length).toBe(1);
    expect(received[0]!.channel).toBe("ch.shared");
    // bytesToHexUpper 给出大写 hex；noble 默认输出小写——断言前归一。
    expect(received[0]!.publisher.toLowerCase()).toBe(PUB_HEX_OTHER);
    expect(received[0]!.body).toBe("from-other");
  });

  it("drops broadcasts that fail verify", async () => {
    harness = await makeCore();
    const received: string[] = [];
    harness.core.subscribe({
      channelIds: ["ch.verify"],
      handler: (m) => received.push(m.channelId)
    });
    await new Promise((r) => setTimeout(r, 0));
    const { envelopeBytes, signatureBytes } = await makeSignedEnvelope({
      channelId: "ch.verify",
      createdAtMs: 1_700_000_000_000,
      bodyBytes: new Uint8Array([1, 2, 3]),
      privKeyHex: PRIV_HEX_OTHER, // 错误私钥
      pubKeyHex: PUB_HEX
    });
    const ev: ProviderBroadcastEvent = { envelopeBytes, signatureBytes };
    harness.provider.currentHandle!.broadcastHandlers.forEach((h) => h(ev));
    expect(received.length).toBe(0);
  });

  it("verifyBroadcastEnvelope rejects malformed signatures", () => {
    const envelopeBytes = new Uint8Array([1, 2, 3]);
    const sig = new Uint8Array(64); // 全零
    expect(
      verifyBroadcastEnvelope({
        envelopeBytes,
        signatureBytes: sig,
        publisherPublicKeyHex: PUB_HEX
      })
    ).toBe(false);
  });

  it("marks structurally offline and exposes state via inspect", async () => {
    harness = await makeCore();
    harness.core.markStructurallyOffline();
    const snap = harness.core.inspect();
    expect(snap.state).toBe("idle");
    expect(snap.ownerPublicKeyHex).toBeNull();
    expect(snap.lastError).toBeNull();
    expect(snap.nextReconnectAtMs).toBeNull();
  });

  it("sets nextReconnectAtMs and clears state when provider closes", async () => {
    harness = await makeCore();
    const ops = harness.provider.currentHandle!;
    expect(ops).not.toBeNull();
    ops.closeHandlers.forEach((h) => h());
    const snap = harness.core.inspect();
    expect(snap.state).toBe("closed");
    expect(snap.nextReconnectAtMs).not.toBeNull();
    expect(snap.nextReconnectAtMs!).toBeGreaterThan(Date.now());
  });

  it("connectForOwner returns structurallyOffline when signer is unavailable", async () => {
    const cfg: BroadcastCoreConfig = {
      signerProvider: async () => null,
      keyspace: makeFakeKeyspace(null),
      vault: makeFakeVault(false),
      reconnectDelayMs: 5_000
    };
    const core = BroadcastCoreImpl.create(cfg);
    core.providers().register(new FakeProvider("hubcast"));
    await core.providers().setActive("hubcast");
    const out: BroadcastConnectOutcome = await core.connectForOwner(PUB_HEX);
    expect(out.kind).toBe("structurallyOffline");
    if (out.kind === "structurallyOffline") {
      expect(out.reason).toBe("no_signer");
    }
    await core.disconnect();
  });

  it("connectForOwner returns structurallyOffline when no active provider", async () => {
    const cfg: BroadcastCoreConfig = {
      signerProvider: async () => ({
        publicKeyHex: PUB_HEX,
        privateKeyHex: PRIV_HEX,
        signChallenge: async () => "00".repeat(64)
      }),
      keyspace: makeFakeKeyspace(PUB_HEX),
      vault: makeFakeVault(true),
      reconnectDelayMs: 5_000
    };
    const core = BroadcastCoreImpl.create(cfg);
    const out: BroadcastConnectOutcome = await core.connectForOwner(PUB_HEX);
    expect(out.kind).toBe("structurallyOffline");
    if (out.kind === "structurallyOffline") {
      expect(out.reason).toBe("no_active_provider");
    }
    await core.disconnect();
  });

  it("decode envelope covers the v1 7-element order", () => {
    const envelopeBytes = cborEncode([
      1,
      hexToBytes(PUB_HEX),
      "ch.r",
      "p",
      "c",
      1234,
      new Uint8Array([9, 9, 9])
    ]);
    const raw = cborDecode(envelopeBytes);
    expect(Array.isArray(raw)).toBe(true);
    const arr = raw as unknown[];
    expect(arr.length).toBe(7);
    expect(arr[0]).toBe(1);
    expect(arr[1]).toBeInstanceOf(Uint8Array);
    expect((arr[1] as Uint8Array).length).toBe(33);
    expect(arr[2]).toBe("ch.r");
    expect(arr[3]).toBe("p");
    expect(arr[4]).toBe("c");
    expect(arr[5]).toBe(1234);
    expect(arr[6]).toBeInstanceOf(Uint8Array);
  });

  /* ============== 2026-07-08 001 硬切换:active provider 持久化/默认激活 ============== */

  it("auto-activates the only registered provider when nothing is persisted and user has not cleared", async () => {
    const mem = new Map<string, string>();
    const core = BroadcastCoreImpl.create({
      signerProvider: async () => null,
      keyspace: makeFakeKeyspace(PUB_HEX),
      vault: makeFakeVault(true),
      reconnectDelayMs: 5_000,
      storage: memLike(mem)
    });
    expect(core.getActiveProviderId()).toBeNull();
    core.providers().register(new FakeProvider("hubcast"));
    expect(core.getActiveProviderId()).toBe("hubcast");
    // storage 写入是 fire-and-forget 的异步副作用；轮询直到命中或超时。
    await waitFor(() => mem.get("keymaster.broadcast.activeProviderId") === "hubcast", 1000);
  });

  it("does NOT auto-activate after user explicitly cleared active", async () => {
    const mem = new Map<string, string>();
    const core = BroadcastCoreImpl.create({
      signerProvider: async () => null,
      keyspace: makeFakeKeyspace(PUB_HEX),
      vault: makeFakeVault(true),
      reconnectDelayMs: 5_000,
      storage: memLike(mem)
    });
    await core.setActiveProviderId(null);
    core.providers().register(new FakeProvider("hubcast"));
    expect(core.getActiveProviderId()).toBeNull();
  });

  it("restores persisted provider id when matching registered provider is found", async () => {
    const mem = new Map<string, string>([["keymaster.broadcast.activeProviderId", "hubcast"]]);
    const core = BroadcastCoreImpl.create({
      signerProvider: async () => null,
      keyspace: makeFakeKeyspace(PUB_HEX),
      vault: makeFakeVault(true),
      reconnectDelayMs: 5_000,
      storage: memLike(mem)
    });
    core.providers().register(new FakeProvider("hubcast"));
    expect(core.getActiveProviderId()).toBe("hubcast");
  });
});

/**
 * 测试内存 storage 适配器：等价于浏览器 localStorage 的最小子集。
 */
function memLike(map: Map<string, string>): {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
} {
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    }
  };
}

/**
 * 极简轮询 helper：在 timeoutMs 内轮询 predicate；命中立即 resolve。
 * 测试中 fire-and-forget 副作用的等待用。
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await new Promise<void>((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}
