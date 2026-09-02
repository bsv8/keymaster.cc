import { describe, expect, it, vi } from "vitest";
import { newActionResult, newPublish, newRequestId, newSubscribe } from "sat-subscription-protocol/client";
import { encodeUvarintFrame } from "bitcoin-libp2p/stream";
import { createSatLibp2pTransport, SatLibp2pConnection } from "./satLibp2pTransport.js";

const mocks = vi.hoisted(() => ({
  authenticateConnection: vi.fn()
}));

vi.mock("bitcoin-libp2p/libp2p", () => ({ authenticateConnection: mocks.authenticateConnection }));

/** 只实现 SDK framing reader 使用的 Stream 事件边界。 */
class FakeStream {
  readonly id = "fake-stream";
  readonly protocol = "/ssp/1.0.0";
  readonly direction = "outbound" as const;
  readonly status = "open" as const;
  readonly readStatus = "readable" as const;
  readonly writeStatus = "writable" as const;
  readonly remoteReadStatus = "readable" as const;
  readonly remoteWriteStatus = "writable" as const;
  readonly timeline = { open: Date.now() };
  readonly log = {} as never;
  readonly maxReadBufferLength = 1024 * 1024;
  readonly maxWriteBufferLength = 1024 * 1024;
  readonly inactivityTimeout = 0;
  readonly writableNeedsDrain = false;
  readonly readableEnded = false;
  readonly readBufferLength = 0;
  readonly writeBufferLength = 0;
  readonly sent: Uint8Array[] = [];
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();
  private ended = false;

  addEventListener(type: string, listener: (event: Event) => void): void {
    const set = this.listeners.get(type) ?? new Set<(event: Event) => void>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(bytes: Uint8Array): boolean {
    this.sent.push(bytes.slice());
    return true;
  }

  push(bytes: Uint8Array): void {
    if (this.ended) return;
    const event = Object.assign(new Event("message"), { data: bytes.slice() });
    for (const listener of this.listeners.get("message") ?? []) listener(event);
  }

  close(): Promise<void> {
    this.ended = true;
    for (const listener of this.listeners.get("remoteCloseWrite") ?? []) listener(new Event("remoteCloseWrite"));
    return Promise.resolve();
  }

  abort(): void {
    this.ended = true;
    for (const listener of this.listeners.get("close") ?? []) listener(new Event("close"));
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not reached");
}

describe("SatSubscription libp2p adapter", () => {
  it("uses SDK uvarint framing for concurrent responses and inbound Publish", async () => {
    const stream = new FakeStream();
    const connection = {
      newStream: vi.fn(async () => stream),
      close: vi.fn(async () => undefined)
    } as unknown as ConstructorParameters<typeof SatLibp2pConnection>[0]["connection"];
    const adapter = new SatLibp2pConnection({
      connection,
      supplierPublicKeyHex: "03" + "22".repeat(32),
      maxWireBytes: 1 << 20,
      requestTimeoutMs: 2_000
    });
    let releaseInbound!: () => void;
    const inboundGate = new Promise<void>((resolve) => { releaseInbound = resolve; });
    const inboundRequestId = newRequestId();
    const inboundResponse = newActionResult({ requestId: inboundRequestId, success: true, chargedAmount: "0", errorCode: "" });
    const off = adapter.subscribeSspRequests(async (wire) => {
      expect(wire).toBeInstanceOf(Uint8Array);
      await inboundGate;
      return inboundResponse;
    });

    const requestIdA = newRequestId();
    const requestIdB = newRequestId();
    const pendingA = adapter.requestSsp(newSubscribe(requestIdA, "topic"));
    const pendingB = adapter.requestSsp(newSubscribe(requestIdB, "topic"));
    await waitFor(() => stream.sent.length === 2);

    const inbound = newPublish(inboundRequestId, "topic", new TextEncoder().encode("{}"));
    const responseB = newActionResult({ requestId: requestIdB, success: true, chargedAmount: "0.125", errorCode: "" });
    const responseA = newActionResult({ requestId: requestIdA, success: true, chargedAmount: "0.25", errorCode: "" });
    // 同一批数据包含入站 Publish 和一个乱序 response；handler 等待时，
    // reader 仍必须先完成 request B 的 response 关联。
    const inboundFrame = encodeUvarintFrame(inbound);
    const responseBFrame = encodeUvarintFrame(responseB);
    const batch = new Uint8Array(inboundFrame.byteLength + responseBFrame.byteLength);
    batch.set(inboundFrame);
    batch.set(responseBFrame, inboundFrame.byteLength);
    stream.push(batch);
    await expect(pendingB).resolves.toEqual(responseB);
    expect(stream.sent).toHaveLength(2);

    releaseInbound();
    await waitFor(() => stream.sent.length === 3);
    stream.push(encodeUvarintFrame(responseA));
    await expect(pendingA).resolves.toEqual(responseA);

    expect(stream.sent[2]).toEqual(encodeUvarintFrame(inboundResponse));
    off();
    adapter.close();
  });

  it("keeps an inbound Publish received before handler registration", async () => {
    const stream = new FakeStream();
    const connection = {
      newStream: vi.fn(async () => stream),
      close: vi.fn(async () => undefined)
    } as unknown as ConstructorParameters<typeof SatLibp2pConnection>[0]["connection"];
    const adapter = new SatLibp2pConnection({
      connection,
      supplierPublicKeyHex: "03" + "22".repeat(32),
      maxWireBytes: 1 << 20,
      requestTimeoutMs: 2_000,
      resourceLimits: { maxPendingIncomingPerLane: 1 }
    });
    await adapter.start();
    const requestId = newRequestId();
    const publish = newPublish(requestId, "topic", new TextEncoder().encode("{}"));
    stream.push(encodeUvarintFrame(publish));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const response = newActionResult({ requestId, success: true, chargedAmount: "0", errorCode: "" });
    adapter.subscribeSspRequests(async () => response);
    await waitFor(() => stream.sent.some((value) => equalBytes(value, encodeUvarintFrame(response))));
    adapter.close();
  });

  it("fails closed when SSP pending or writer frame limits are reached", async () => {
    const stream = new FakeStream();
    const connection = {
      newStream: vi.fn(async () => stream),
      close: vi.fn(async () => undefined)
    } as unknown as ConstructorParameters<typeof SatLibp2pConnection>[0]["connection"];
    const adapter = new SatLibp2pConnection({
      connection,
      supplierPublicKeyHex: "03" + "22".repeat(32),
      maxWireBytes: 1 << 20,
      requestTimeoutMs: 2_000,
      resourceLimits: { maxPendingSspPerSupplier: 1, maxWriterQueuedFrames: 1 }
    });
    const first = adapter.requestSsp(newSubscribe(newRequestId(), "topic"));
    await waitFor(() => stream.sent.length === 1);
    await expect(adapter.requestSsp(newSubscribe(newRequestId(), "topic"))).rejects.toMatchObject({ sentBoundary: "not-sent" });
    adapter.close();
    await expect(first).rejects.toMatchObject({ sentBoundary: "unknown" });
  });

  it("keeps SPI in-flight accounting independent from SSP stream reset", async () => {
    const stream = new FakeStream();
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => { releaseStream = resolve; });
    const newStream = vi.fn(async () => {
      await streamGate;
      return stream;
    });
    const connection = {
      newStream,
      close: vi.fn(async () => undefined)
    } as unknown as ConstructorParameters<typeof SatLibp2pConnection>[0]["connection"];
    const adapter = new SatLibp2pConnection({
      connection,
      supplierPublicKeyHex: "03" + "22".repeat(32),
      maxWireBytes: 1 << 20,
      requestTimeoutMs: 2_000,
      resourceLimits: { maxPendingSpiPerSupplier: 1 }
    });
    const first = adapter.requestSpi(new Uint8Array([1]));
    await waitFor(() => newStream.mock.calls.length === 1);
    await expect(adapter.requestSpi(new Uint8Array([2]))).rejects.toMatchObject({ sentBoundary: "not-sent" });
    adapter.close();
    releaseStream();
    await expect(first).rejects.toMatchObject({ sentBoundary: "not-sent" });
  });

  it("reports SPI failures before send as not-sent and send failures as unknown", async () => {
    const noStreamConnection = {
      newStream: vi.fn(async () => { throw new Error("stream open failed"); }),
      close: vi.fn(async () => undefined)
    } as unknown as ConstructorParameters<typeof SatLibp2pConnection>[0]["connection"];
    const noStreamAdapter = new SatLibp2pConnection({
      connection: noStreamConnection,
      supplierPublicKeyHex: "03" + "22".repeat(32),
      maxWireBytes: 1 << 20,
      requestTimeoutMs: 2_000
    });
    await expect(noStreamAdapter.requestSpi(new Uint8Array([1]))).rejects.toMatchObject({ sentBoundary: "not-sent" });

    const stream = new FakeStream();
    stream.send = () => { throw new Error("send failed"); };
    const sendConnection = {
      newStream: vi.fn(async () => stream),
      close: vi.fn(async () => undefined)
    } as unknown as ConstructorParameters<typeof SatLibp2pConnection>[0]["connection"];
    const sendAdapter = new SatLibp2pConnection({
      connection: sendConnection,
      supplierPublicKeyHex: "03" + "22".repeat(32),
      maxWireBytes: 1 << 20,
      requestTimeoutMs: 2_000
    });
    await expect(sendAdapter.requestSpi(new Uint8Array([1]))).rejects.toMatchObject({ sentBoundary: "unknown" });
  });

  it("fails closed on the first connected address when identity pin authentication fails", async () => {
    const firstConnection = { close: vi.fn(async () => undefined) };
    const secondConnection = { close: vi.fn(async () => undefined) };
    const dial = vi.fn()
      .mockResolvedValueOnce(firstConnection)
      .mockResolvedValueOnce(secondConnection);
    mocks.authenticateConnection.mockReset();
    mocks.authenticateConnection.mockImplementationOnce(() => {
      throw new Error("peer identity does not match the configured pin");
    });
    const transport = createSatLibp2pTransport({
      host: { dial } as never,
      requestTimeoutMs: 2_000
    });

    await expect(transport.connect({
      supplierPublicKeyHex: "03" + "22".repeat(32),
      multiaddrs: ["/ip4/127.0.0.1/tcp/9000", "/ip4/127.0.0.1/tcp/9001"]
    })).rejects.toMatchObject({
      domain: "sat-transport",
      code: "ERR_SAT_IDENTITY_PIN",
      sentBoundary: "unknown"
    });
    expect(dial).toHaveBeenCalledTimes(1);
    expect(firstConnection.close).toHaveBeenCalledTimes(1);
    expect(secondConnection.close).not.toHaveBeenCalled();
  });
});

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
