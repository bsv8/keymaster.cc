import { describe, expect, it, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { encodeUvarintFrame } from "bitcoin-libp2p/stream";
import { peerIdFromPublicKeyBytes } from "bitcoin-libp2p/identity";
import { createFileQuote, type FileQuoteTerms, type Signer } from "go-bitfs";
import { BitfsWebRtcStreamRuntime, type BitfsWebRtcStreamEvent } from "./webrtcStreamRuntime.js";

class TestSigner implements Signer {
  constructor(private readonly byte: number) {}
  publicKey(): Uint8Array {
    return Uint8Array.from(secp256k1.getPublicKey(new Uint8Array(32).fill(this.byte), true));
  }
  async sign(request: Parameters<Signer["sign"]>[0]): Promise<Uint8Array> {
    return Uint8Array.from(secp256k1.sign(request.digest, new Uint8Array(32).fill(this.byte), { prehash: false, lowS: true, format: "der" }));
  }
}

const LOCAL_PUBLIC_KEY = new TestSigner(0x21).publicKey();
const REMOTE_PUBLIC_KEY = new TestSigner(0x44).publicKey();
const LOCAL_PEER_ID = peerIdFromPublicKeyBytes(LOCAL_PUBLIC_KEY);
const REMOTE_PEER_ID = peerIdFromPublicKeyBytes(REMOTE_PUBLIC_KEY);
const REMOTE_PUBLIC_KEY_HEX = toHex(REMOTE_PUBLIC_KEY);

class FakeStream extends EventTarget {
  readonly sent: Uint8Array[] = [];
  readonly sendResults: boolean[] = [];
  status: "open" | "closed" | "aborted" = "open";
  remoteWriteStatus: "writable" | "closed" = "writable";
  readableEnded = false;
  readBufferLength = 0;
  writeBufferLength = 0;
  writableNeedsDrain = false;
  aborted = false;
  closeGate?: Promise<void>;
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
  push(data: Uint8Array): void {
    const event = new Event("message");
    Object.defineProperty(event, "data", { value: data });
    this.dispatchEvent(event);
  }
}

class FakeConnection {
  aborted = false;
  closed = false;
  closeGate?: Promise<void>;
  readonly streams: FakeStream[] = [];
  constructor(readonly remotePeer = REMOTE_PEER_ID) {}
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

class FakeHost {
  handler?: (stream: FakeStream, connection: FakeConnection) => void;
  readonly peerId = LOCAL_PEER_ID;
  readonly handle = vi.fn(async (_protocol: string, handler: (stream: FakeStream, connection: FakeConnection) => void) => {
    this.handler = handler;
  });
  readonly unhandle = vi.fn(async () => undefined);
}

class FakeInterconnect {
  readonly routes = new Map<string, (envelope: unknown) => Promise<void> | void>();
  private readonly listeners = new Set<(event: {
    connection: FakeConnection;
    remotePeerId: typeof REMOTE_PEER_ID;
    connectionId: string;
    attemptId: string;
    role: "initiator" | "responder";
  }) => void>();
  readonly dialer = {
    dial: vi.fn(async (_node: unknown, input: {
      connectionId?: string;
      attemptId?: string;
      remotePeerId: typeof REMOTE_PEER_ID;
    }) => {
      const connection = new FakeConnection(input.remotePeerId);
      return {
        connection,
        connectionId: input.connectionId!,
        attemptId: input.attemptId!,
        remotePeerId: input.remotePeerId,
      };
    }),
  };
  register(connectionId: string, send: (envelope: unknown) => Promise<void> | void): () => void {
    this.routes.set(connectionId, send);
    return () => { this.routes.delete(connectionId); };
  }
  deliver(): void {}
  setStunServers(): void {}
  onConnection(listener: (event: {
    connection: FakeConnection;
    remotePeerId: typeof REMOTE_PEER_ID;
    connectionId: string;
    attemptId: string;
    role: "initiator" | "responder";
  }) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  emitConnection(event: {
    connection: FakeConnection;
    remotePeerId: typeof REMOTE_PEER_ID;
    connectionId: string;
    attemptId: string;
    role: "initiator" | "responder";
  }): void {
    for (const listener of this.listeners) listener(event);
  }
}

async function quoteFrame(): Promise<Uint8Array> {
  const terms: FileQuoteTerms = {
    seedHash: new Uint8Array(32).fill(0x11),
    buyerPublicKey: REMOTE_PUBLIC_KEY,
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
  const host = new FakeHost();
  const interconnect = new FakeInterconnect();
  const events: BitfsWebRtcStreamEvent[] = [];
  const runtime = new BitfsWebRtcStreamRuntime({
    interconnect: interconnect as never,
    host: host as never,
    stunServers: () => [],
    emit: event => { events.push(event); },
    ownerSessionEpoch: "epoch-1",
  });
  return { runtime, host, interconnect, events };
}

function entry(runtime: BitfsWebRtcStreamRuntime, sessionId: string): { connectionId: string; attemptId: string } {
  return (runtime as unknown as { sessions: Map<string, { connectionId: string; attemptId: string }> }).sessions.get(sessionId)!;
}

function offerInput(sessionId: string, webrtcSessionId: string) {
  return {
    sessionId,
    requestMessageId: `request-${sessionId}`,
    webrtcSessionId,
    peerPublicKeyHex: REMOTE_PUBLIC_KEY_HEX,
    offerSdp: "v=0",
    ownerSessionEpoch: "epoch-1",
  };
}

function connectionEvent(runtime: BitfsWebRtcStreamRuntime, sessionId: string, connection: FakeConnection) {
  const relation = entry(runtime, sessionId);
  return {
    connection,
    remotePeerId: REMOTE_PEER_ID,
    connectionId: relation.connectionId,
    attemptId: relation.attemptId,
    role: "responder" as const,
  };
}

describe("BitFS WebRTC stream runtime", () => {
  it("routes same-peer streams by connection identity", async () => {
    const { runtime, host, interconnect, events } = fixture();
    const first = runtime.acceptOffer(offerInput("session-a", "webrtc-a"));
    const second = runtime.acceptOffer(offerInput("session-b", "webrtc-b"));
    await vi.waitFor(() => expect((runtime as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(2));
    const connectionA = new FakeConnection();
    const connectionB = new FakeConnection();
    interconnect.emitConnection(connectionEvent(runtime, "session-a", connectionA));
    interconnect.emitConnection(connectionEvent(runtime, "session-b", connectionB));
    await vi.waitFor(() => expect(host.handler).toBeDefined());
    const streamA = new FakeStream();
    const streamB = new FakeStream();
    host.handler!(streamA, connectionA);
    host.handler!(streamB, connectionB);
    await expect(Promise.all([first, second])).resolves.toEqual([{ accepted: true }, { accepted: true }]);
    const frame = await quoteFrame();
    streamA.push(encodeUvarintFrame(frame));
    streamB.push(encodeUvarintFrame(frame));
    await vi.waitFor(() => expect(events.filter(event => event.type === "bitfs-webrtc-frame")).toHaveLength(2));
    expect(events.filter(event => event.type === "bitfs-webrtc-frame").map(event => event.sessionId).sort()).toEqual(["session-a", "session-b"]);
    await runtime.dispose();
  });

  it("keeps ambiguous streams pending and aborts them when sessions close", async () => {
    const { runtime, host, interconnect } = fixture();
    const first = runtime.acceptOffer(offerInput("session-a", "webrtc-a"));
    const second = runtime.acceptOffer(offerInput("session-b", "webrtc-b"));
    await vi.waitFor(() => expect((runtime as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(2));
    await vi.waitFor(() => expect(host.handler).toBeDefined());
    const connection = new FakeConnection();
    const stream = new FakeStream();
    host.handler!(stream, connection);
    expect(stream.aborted).toBe(false);
    await runtime.close("session-a");
    await expect(first).rejects.toThrow();
    expect(stream.aborted).toBe(true);
    await runtime.close("session-b");
    await expect(second).rejects.toThrow();
    expect(stream.aborted).toBe(true);
    await runtime.dispose();
  });

  it("aborts pending streams on dispose", async () => {
    const { runtime, host } = fixture();
    await vi.waitFor(() => expect(host.handler).toBeDefined());
    const stream = new FakeStream();
    host.handler!(stream, new FakeConnection());
    expect(stream.aborted).toBe(false);
    await runtime.dispose();
    expect(stream.aborted).toBe(true);
  });

  it("waits for repeated drain events while serializing outbound sends", async () => {
    const { runtime, interconnect } = fixture();
    const frame = await quoteFrame();
    await runtime.createOffer({
      sessionId: "session-a",
      requestMessageId: "request-a",
      webrtcSessionId: "webrtc-a",
      peerPublicKeyHex: REMOTE_PUBLIC_KEY_HEX,
      firstFrame: frame,
      ownerSessionEpoch: "epoch-1",
    });
    const dialResult = await vi.waitFor(() => {
      const result = interconnect.dialer.dial.mock.results[0]?.value as Promise<{ connection: FakeConnection }> | undefined;
      if (result == null) throw new Error("dial not started");
      return result;
    });
    const connection = (await dialResult).connection;
    await vi.waitFor(() => expect(connection.streams).toHaveLength(1));
    const stream = connection.streams[0]!;
    stream.sendResults.push(false, false, true);
    const first = runtime.send("session-a", frame);
    const second = runtime.send("session-a", frame);
    await vi.waitFor(() => expect(stream.sent).toHaveLength(2));
    expect(stream.writableNeedsDrain).toBe(true);
    stream.releaseDrain();
    await vi.waitFor(() => expect(stream.sent).toHaveLength(3));
    stream.releaseDrain();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    await runtime.dispose();
  });

  it("bounds teardown when stream and connection close never settle", async () => {
    const { runtime, interconnect } = fixture();
    const frame = await quoteFrame();
    await runtime.createOffer({
      sessionId: "session-a",
      requestMessageId: "request-a",
      webrtcSessionId: "webrtc-a",
      peerPublicKeyHex: REMOTE_PUBLIC_KEY_HEX,
      firstFrame: frame,
      ownerSessionEpoch: "epoch-1",
    });
    const result = await (interconnect.dialer.dial.mock.results[0]!.value as Promise<{ connection: FakeConnection }>);
    const connection = result.connection;
    await vi.waitFor(() => expect(connection.streams).toHaveLength(1));
    connection.closeGate = new Promise<void>(() => undefined);
    connection.streams[0]!.closeGate = new Promise<void>(() => undefined);
    const startedAt = Date.now();
    await runtime.dispose();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(connection.aborted).toBe(true);
    expect(connection.streams[0]!.aborted).toBe(true);
  });
});

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
