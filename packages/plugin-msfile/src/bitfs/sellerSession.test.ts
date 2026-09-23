// BitFS 卖方会话管理器：容量、入站严格解析、persist-before-send 顺序、
// 空闲超时与 generation 撤销。

import { afterEach, describe, expect, it, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { createFileQuote, type FileQuoteTerms, type Signer } from "go-bitfs";
import {
  BitfsSellerSessionManager,
  type BitfsSellerProtocolPort,
  type BitfsSellerProtocolResult,
  type BitfsSellerStreamTransport,
} from "./sellerSession.js";

const SEED_HASH = new Uint8Array(32).fill(0x11);
const SELLER_PUBLIC_KEY_HEX = "02" + "22".repeat(32);

class TestSigner implements Signer {
  constructor(private readonly byte: number) {}
  publicKey(): Uint8Array {
    const privateBytes = new Uint8Array(32).fill(this.byte);
    return Uint8Array.from(secp256k1.getPublicKey(privateBytes, true));
  }
  async sign(request: Parameters<Signer["sign"]>[0]): Promise<Uint8Array> {
    const privateBytes = new Uint8Array(32).fill(this.byte);
    return Uint8Array.from(secp256k1.sign(request.digest, privateBytes, { prehash: false, lowS: true, format: "der" }));
  }
}

async function quoteFrame(): Promise<Uint8Array> {
  const terms: FileQuoteTerms = {
    seedHash: SEED_HASH,
    buyerPublicKey: new TestSigner(0x44).publicKey(),
    seedPriceSatoshis: 1n,
    fullBlockPriceSatoshis: 2n,
    fileSizeBytes: 3n,
    quoteExpiresAtUnixSeconds: 9_999n,
    supportedArbiterPublicKeys: [new TestSigner(0x33).publicKey()],
    recommendedFilename: "fixture.bin",
  };
  return (await createFileQuote(new TestSigner(0x22), terms)).bytes();
}

function fixture(overrides: Partial<ConstructorParameters<typeof BitfsSellerSessionManager>[0]> = {}) {
  const opened: Array<{ sessionId: string; addresses: string[]; publicKeyHex: string; expectedPeerId: string; firstFrame: Uint8Array }> = [];
  const sent: Array<{ sessionId: string; frame: Uint8Array }> = [];
  const closed: Array<{ sessionId: string; reason?: string }> = [];
  const counts: number[] = [];
  const transport: BitfsSellerStreamTransport = {
    async open(input) { opened.push({ ...input, firstFrame: input.firstFrame.slice() }); },
    async send(sessionId, frame) { sent.push({ sessionId, frame: frame.slice() }); },
    async close(sessionId, reason) { closed.push({ sessionId, reason }); },
  };
  const onFrame = vi.fn(async (): Promise<BitfsSellerProtocolResult> => ({ type: "none" }));
  const protocol: BitfsSellerProtocolPort = { ready: true, onFrame };
  let current = true;
  const manager = new BitfsSellerSessionManager({
    transport,
    protocol,
    nowMs: () => 1_000,
    idleTimeoutMs: () => 60_000,
    maxSessions: () => 1,
    onActiveSessionsChanged: (count) => counts.push(count),
    isCurrent: () => current,
    ...overrides,
  });
  return { manager, opened, sent, closed, counts, onFrame, setCurrent: (value: boolean) => { current = value; } };
}

const START = {
  sessionId: "session-1",
  addresses: ["/dns4/buyer.example/tcp/443/tls/ws/p2p/peer"],
  publicKeyHex: SELLER_PUBLIC_KEY_HEX,
  expectedPeerId: "peer",
  quoteBytes: new Uint8Array([1, 2, 3]),
  seedHashHex: "11".repeat(32),
};

afterEach(() => {
  vi.useRealTimers();
});

describe("BitFS 卖方会话管理器", () => {
  it("start 发送已持久化报价，容量满时拒绝新会话", async () => {
    const { manager, opened, counts } = fixture();
    await expect(manager.start({ ...START, quoteBytes: new Uint8Array([9, 9]) })).resolves.toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ sessionId: "session-1", publicKeyHex: SELLER_PUBLIC_KEY_HEX });
    expect(opened[0]!.firstFrame).toEqual(new Uint8Array([9, 9]));
    expect(manager.activeCount()).toBe(1);
    await expect(manager.start({ ...START, sessionId: "session-2" })).resolves.toBe(false);
    expect(opened).toHaveLength(1);
    expect(counts).toEqual([1]);
  });

  it("入站非规范字节关闭会话且不进入协议端口", async () => {
    const { manager, closed, onFrame } = fixture();
    await manager.start(START);
    await manager.handleFrame({ sessionId: "session-1", frame: new Uint8Array([0xff, 0x00]) });
    expect(onFrame).not.toHaveBeenCalled();
    expect(closed).toEqual([{ sessionId: "session-1", reason: "malformed_wire" }]);
    expect(manager.activeCount()).toBe(0);
  });

  it("合法入站帧经协议端口后按顺序发送出站帧", async () => {
    const { manager, sent, onFrame } = fixture();
    onFrame.mockResolvedValueOnce({ type: "send", frames: [new Uint8Array([7]), new Uint8Array([8])] });
    await manager.start(START);
    await manager.handleFrame({ sessionId: "session-1", frame: await quoteFrame() });
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(sent.map((entry) => Array.from(entry.frame))).toEqual([[7], [8]]);
    expect(manager.activeCount()).toBe(1);
  });

  it("协议端口要求关闭时结束会话", async () => {
    const { manager, closed, onFrame } = fixture();
    onFrame.mockResolvedValueOnce({ type: "close", reason: "seller_pool_amount_unavailable" });
    await manager.start(START);
    await manager.handleFrame({ sessionId: "session-1", frame: await quoteFrame() });
    expect(closed).toEqual([{ sessionId: "session-1", reason: "seller_pool_amount_unavailable" }]);
  });

  it("空闲超时关闭连接但不影响其它状态", async () => {
    vi.useFakeTimers();
    const { manager, closed } = fixture({ idleTimeoutMs: () => 1_000 });
    await manager.start(START);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(closed).toEqual([{ sessionId: "session-1", reason: "idle_timeout" }]);
    expect(manager.activeCount()).toBe(0);
  });

  it("generation 撤销后迟到帧不进入协议端口", async () => {
    const { manager, onFrame } = fixture();
    await manager.start(START);
    manager.clear();
    expect(manager.activeCount()).toBe(0);
    await manager.handleFrame({ sessionId: "session-1", frame: await quoteFrame() });
    expect(onFrame).not.toHaveBeenCalled();
  });

  it("transport 打开失败时清理会话并保持未售出状态", async () => {
    const { manager, counts, setCurrent } = fixture();
    const failing: BitfsSellerStreamTransport = {
      async open() { throw new Error("dial failed"); },
      async send() {},
      async close() {},
    };
    const failingManager = new BitfsSellerSessionManager({
      transport: failing,
      protocol: { ready: true, onFrame: vi.fn(async () => ({ type: "none" }) as const) },
      nowMs: () => 1_000,
      idleTimeoutMs: () => 60_000,
      maxSessions: () => 1,
      onActiveSessionsChanged: (count) => counts.push(count),
      isCurrent: () => true,
    });
    await expect(failingManager.start(START)).rejects.toThrow(/dial failed/u);
    expect(failingManager.activeCount()).toBe(0);
    expect(counts).toEqual([1, 0]);
    setCurrent(false);
    await expect(manager.start(START)).resolves.toBe(false);
  });
});
