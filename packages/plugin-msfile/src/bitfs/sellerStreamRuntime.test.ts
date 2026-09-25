// Window 侧 BitFS stream runtime：拨号、首帧、入站事件、远端关闭与本地关闭。
// 测试通过 dial 接缝替换已认证拨号；真实身份 pin 由 authenticatedDial 覆盖。

import { describe, expect, it, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { encodeUvarintFrame } from "bitcoin-libp2p/stream";
import { peerIdFromPublicKeyBytes } from "bitcoin-libp2p/identity";
import { createFileQuote, type FileQuoteTerms, type Signer } from "go-bitfs";
import { BitfsStreamRuntime, type BitfsStreamEvent } from "./sellerStreamRuntime.js";

class TestSigner implements Signer {
  constructor(private readonly byte: number) {}
  publicKey(): Uint8Array {
    return Uint8Array.from(secp256k1.getPublicKey(new Uint8Array(32).fill(this.byte), true));
  }
  async sign(request: Parameters<Signer["sign"]>[0]): Promise<Uint8Array> {
    return Uint8Array.from(secp256k1.sign(request.digest, new Uint8Array(32).fill(this.byte), { prehash: false, lowS: true, format: "der" }));
  }
}

const BUYER_PUBLIC_KEY_HEX = toHex(new TestSigner(0x44).publicKey());

class FakeStream extends EventTarget {
  readonly sent: Uint8Array[] = [];
  readonly sendResults: boolean[] = [];
  closed = false;
  aborted = false;
  writableNeedsDrain = false;
  closeGate?: Promise<void>;
  /** 分帧层读取的最小 Stream 状态字段。 */
  status = "open";
  remoteWriteStatus = "writable";
  readableEnded = false;
  readBufferLength = 0;
  writeBufferLength = 0;
  send(data: Uint8Array): boolean {
    this.sent.push(data.slice());
    const result = this.sendResults.shift() ?? true;
    this.writableNeedsDrain = !result;
    return result;
  }
  releaseDrain(): void {
    this.writableNeedsDrain = false;
    this.dispatchEvent(new Event("drain"));
  }
  async close(): Promise<void> {
    if (this.closeGate != null) await this.closeGate;
    this.closed = true;
    this.status = "closed";
    this.writableNeedsDrain = false;
    this.dispatchEvent(new Event("close"));
  }
  abort(error?: Error): void {
    this.aborted = true;
    this.status = "aborted";
    this.writableNeedsDrain = false;
    const event = new Event("close");
    if (error !== undefined) Object.defineProperty(event, "error", { value: error });
    this.dispatchEvent(event);
  }
  /** 模拟远端发来一个已分帧 chunk。 */
  pushChunk(chunk: Uint8Array): void {
    const event = new Event("message");
    Object.defineProperty(event, "data", { value: chunk });
    this.dispatchEvent(event);
  }
  /** 模拟远端正常半关闭。 */
  remoteClose(): void {
    this.remoteWriteStatus = "closed";
    this.dispatchEvent(new Event("remoteCloseWrite"));
    this.dispatchEvent(new Event("close"));
  }
}

class FakeConnection {
  aborted = false;
  closed = false;
  closeGate?: Promise<void>;
  readonly streams: FakeStream[] = [];
  async newStream(): Promise<FakeStream> {
    const stream = new FakeStream();
    this.streams.push(stream);
    return stream;
  }
  abort(): void { this.aborted = true; }
  async close(): Promise<void> {
    if (this.closeGate != null) await this.closeGate;
    this.closed = true;
  }
}

async function quoteFrame(): Promise<Uint8Array> {
  const terms: FileQuoteTerms = {
    seedHash: new Uint8Array(32).fill(0x11),
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

function fixture() {
  const connection = new FakeConnection();
  const events: BitfsStreamEvent[] = [];
  const runtime = new BitfsStreamRuntime({
    host: { dial: async () => connection as never },
    emit: (event) => { events.push(event); },
    ownerSessionEpoch: "epoch-1",
    dial: async () => connection as never,
  });
  return { runtime, connection, events };
}

describe("BitFS 卖方 stream runtime", () => {
  it("拨号后打开 BitFS stream 并发送报价首帧", async () => {
    const { runtime, connection } = fixture();
    const frame = await quoteFrame();
    await runtime.open({
      sessionId: "session-1",
      addresses: ["/dns4/buyer.example/tcp/443/tls/ws/p2p/peer"],
      publicKeyHex: BUYER_PUBLIC_KEY_HEX,
      expectedPeerId: expectedPeerIdFor(BUYER_PUBLIC_KEY_HEX),
      firstFrame: frame,
    });
    expect(connection.streams).toHaveLength(1);
    expect(connection.streams[0]!.sent).toEqual([encodeUvarintFrame(frame)]);
    await runtime.dispose();
  });

  it("串行发送并在每次真实 drain 周期后继续", async () => {
    const { runtime, connection } = fixture();
    const frame = await quoteFrame();
    await runtime.open({
      sessionId: "session-1",
      addresses: ["/dns4/buyer.example/tcp/443/tls/ws/p2p/peer"],
      publicKeyHex: BUYER_PUBLIC_KEY_HEX,
      expectedPeerId: expectedPeerIdFor(BUYER_PUBLIC_KEY_HEX),
      firstFrame: frame,
    });
    const stream = connection.streams[0]!;
    stream.sendResults.push(false, false, true);
    const first = runtime.send("session-1", frame);
    const second = runtime.send("session-1", frame);
    await vi.waitFor(() => expect(stream.sent).toHaveLength(2));
    expect(stream.writableNeedsDrain).toBe(true);
    stream.releaseDrain();
    await vi.waitFor(() => expect(stream.sent).toHaveLength(3));
    expect(stream.writableNeedsDrain).toBe(true);
    stream.releaseDrain();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(stream.sent).toHaveLength(3);
    await runtime.dispose();
  });

  it("关闭会中止等待 drain 的发送", async () => {
    const { runtime, connection } = fixture();
    const frame = await quoteFrame();
    await runtime.open({
      sessionId: "session-1",
      addresses: ["/dns4/buyer.example/tcp/443/tls/ws/p2p/peer"],
      publicKeyHex: BUYER_PUBLIC_KEY_HEX,
      expectedPeerId: expectedPeerIdFor(BUYER_PUBLIC_KEY_HEX),
      firstFrame: frame,
    });
    const stream = connection.streams[0]!;
    stream.sendResults.push(false);
    const pending = runtime.send("session-1", frame);
    await vi.waitFor(() => expect(stream.writableNeedsDrain).toBe(true));
    await runtime.close("session-1", "worker_closed");
    await expect(pending).rejects.toThrow();
    expect(stream.aborted).toBe(true);
  });

  it("teardown 在底层 close 不返回时仍有上限", async () => {
    const { runtime, connection } = fixture();
    const frame = await quoteFrame();
    await runtime.open({
      sessionId: "session-1",
      addresses: ["/dns4/buyer.example/tcp/443/tls/ws/p2p/peer"],
      publicKeyHex: BUYER_PUBLIC_KEY_HEX,
      expectedPeerId: expectedPeerIdFor(BUYER_PUBLIC_KEY_HEX),
      firstFrame: frame,
    });
    connection.closeGate = new Promise<void>(() => undefined);
    connection.streams[0]!.closeGate = new Promise<void>(() => undefined);
    const startedAt = Date.now();
    await runtime.dispose();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(connection.aborted).toBe(true);
    expect(connection.streams[0]!.aborted).toBe(true);
  });

  it("入站 Artifact 以 exact 字节发回 Worker，远端关闭上报会话结束", async () => {
    const { runtime, connection, events } = fixture();
    const frame = await quoteFrame();
    await runtime.open({
      sessionId: "session-1",
      addresses: ["/dns4/buyer.example/tcp/443/tls/ws/p2p/peer"],
      publicKeyHex: BUYER_PUBLIC_KEY_HEX,
      expectedPeerId: expectedPeerIdFor(BUYER_PUBLIC_KEY_HEX),
      firstFrame: frame,
    });
    connection.streams[0]!.pushChunk(encodeUvarintFrame(frame));
    await vi.waitFor(() => expect(events.some((event) => event.type === "bitfs-seller-frame")).toBe(true));
    const inbound = events.find((event) => event.type === "bitfs-seller-frame");
    expect(inbound).toMatchObject({ sessionId: "session-1", ownerSessionEpoch: "epoch-1" });
    expect(Array.from((inbound as { frame: Uint8Array }).frame)).toEqual(Array.from(frame));

    connection.streams[0]!.remoteClose();
    await vi.waitFor(() => expect(events.some((event) => event.type === "bitfs-seller-session-closed")).toBe(true));
    expect(connection.aborted).toBe(true);
    expect(connection.closed).toBe(true);
  });

  it("PeerId 与公钥不一致时拒绝拨号", async () => {
    const { runtime, connection } = fixture();
    await expect(runtime.open({
      sessionId: "session-1",
      addresses: ["/dns4/buyer.example/tcp/443/tls/ws/p2p/peer"],
      publicKeyHex: BUYER_PUBLIC_KEY_HEX,
      expectedPeerId: "12D3KooWNotTheRequester",
      firstFrame: await quoteFrame(),
    })).rejects.toThrow(/PeerId/u);
    expect(connection.streams).toHaveLength(0);
  });

  it("本地 close 不重复上报会话结束", async () => {
    const { runtime, connection, events } = fixture();
    await runtime.open({
      sessionId: "session-1",
      addresses: ["/dns4/buyer.example/tcp/443/tls/ws/p2p/peer"],
      publicKeyHex: BUYER_PUBLIC_KEY_HEX,
      expectedPeerId: expectedPeerIdFor(BUYER_PUBLIC_KEY_HEX),
      firstFrame: await quoteFrame(),
    });
    await runtime.close("session-1", "worker_closed");
    expect(events.filter((event) => event.type === "bitfs-seller-session-closed")).toHaveLength(0);
    expect(connection.closed).toBe(true);
    await runtime.close("session-1", "worker_closed");
  });
});

function expectedPeerIdFor(publicKeyHex: string): string {
  const bytes = new Uint8Array(publicKeyHex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(publicKeyHex.slice(index * 2, index * 2 + 2), 16);
  // 与生产同一派生入口；避免测试复制 PeerId 编码。
  return peerIdFromPublicKeyBytes(bytes).toString();
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
