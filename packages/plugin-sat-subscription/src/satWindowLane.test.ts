import { describe, expect, it, vi } from "vitest";
import { newActionResult, newPublish, newRequestId } from "sat-subscription-protocol/client";
import type { SatWindowLaneOperation } from "@keymaster/contracts";
import { createSatLibp2pTransport } from "./satLibp2pTransport.js";
import { SatWindowP2pLane } from "./satWindowLane.js";

vi.mock("./satLibp2pTransport.js", () => ({
  createSatLibp2pTransport: vi.fn()
}));

const OWNER_EPOCH = "epoch-1";
const SUPPLIER_KEY = "03" + "22".repeat(32);

interface FakeConnection {
  authenticatedPublicKeyHex: string;
  subscribeSspRequests(handler: (wire: Uint8Array) => Promise<Uint8Array>): () => void;
  requestSsp(wire: Uint8Array): Promise<Uint8Array>;
  requestSpi(wire: Uint8Array): Promise<Uint8Array>;
  close(): void;
  trigger(wire: Uint8Array): Promise<Uint8Array>;
  closed: boolean;
}

function fakeConnection(options: { firstPublish?: Uint8Array } = {}): FakeConnection {
  let handler: ((wire: Uint8Array) => Promise<Uint8Array>) | undefined;
  let earlyResponse: Promise<Uint8Array> | undefined;
  const value: FakeConnection = {
    authenticatedPublicKeyHex: SUPPLIER_KEY,
    closed: false,
    subscribeSspRequests(nextHandler) {
      handler = nextHandler;
      if (options.firstPublish) earlyResponse = nextHandler(options.firstPublish);
      return () => {
        if (handler === nextHandler) handler = undefined;
      };
    },
    requestSsp: async (wire) => wire.slice(),
    requestSpi: async (wire) => wire.slice(),
    close() { value.closed = true; },
    trigger(wire) {
      if (!handler) return Promise.reject(new Error("handler is not registered"));
      return handler(wire);
    }
  };
  Object.defineProperty(value, "earlyResponse", { get: () => earlyResponse });
  return value;
}

function connectOperation(input: Partial<Extract<SatWindowLaneOperation, { type: "connect" }>> = {}): Extract<SatWindowLaneOperation, { type: "connect" }> {
  return {
    type: "connect",
    supplierId: "primary",
    connectionId: input.connectionId ?? "connection-1",
    ownerSessionEpoch: OWNER_EPOCH,
    supplierGeneration: input.supplierGeneration ?? 1,
    supplierPublicKeyHex: SUPPLIER_KEY,
    multiaddrs: ["/ip4/127.0.0.1/tcp/9000"],
    ...input
  };
}

function requestOperation(input: Partial<Extract<SatWindowLaneOperation, { type: "requestSsp" }>> = {}): Extract<SatWindowLaneOperation, { type: "requestSsp" }> {
  return {
    type: "requestSsp",
    supplierId: "primary",
    connectionId: "connection-1",
    ownerSessionEpoch: OWNER_EPOCH,
    supplierGeneration: 1,
    wire: new Uint8Array([1]),
    ...input
  };
}

function closeOperation(input: Partial<Extract<SatWindowLaneOperation, { type: "close" }>> = {}): Extract<SatWindowLaneOperation, { type: "close" }> {
  return {
    type: "close",
    supplierId: "primary",
    connectionId: "connection-1",
    ownerSessionEpoch: OWNER_EPOCH,
    supplierGeneration: 1,
    ...input
  };
}

describe("SatWindowP2pLane", () => {
  it("keeps the four-part fence and makes an old close a no-op", async () => {
    const first = fakeConnection();
    const second = fakeConnection();
    vi.mocked(createSatLibp2pTransport)
      .mockReturnValueOnce({ connect: vi.fn(async () => first) } as never)
      .mockReturnValueOnce({ connect: vi.fn(async () => second) } as never);
    const lane = new SatWindowP2pLane();
    await lane.start({ host: {}, ownerSessionEpoch: OWNER_EPOCH, emit: () => undefined });
    await lane.handle(connectOperation(), new AbortController().signal);
    await lane.handle(connectOperation({ connectionId: "connection-2", supplierGeneration: 2 }), new AbortController().signal);

    expect(first.closed).toBe(true);
    await lane.handle(closeOperation(), new AbortController().signal);
    expect(second.closed).toBe(false);
    await expect(lane.handle(requestOperation({ connectionId: "connection-2", supplierGeneration: 2 }), new AbortController().signal)).resolves.toEqual(new Uint8Array([1]));
    await expect(lane.handle(requestOperation(), new AbortController().signal)).rejects.toMatchObject({ domain: "window-p2p", code: "ERR_STALE_CONNECTION" });
  });

  it("does not drop a Publish delivered while connect is flushing the adapter queue", async () => {
    const requestId = newRequestId();
    const publish = newPublish(requestId, "bsv8.inbox.test", new TextEncoder().encode("{}"));
    const connection = fakeConnection({ firstPublish: publish });
    vi.mocked(createSatLibp2pTransport).mockReturnValue({ connect: vi.fn(async () => connection) } as never);
    const events: Array<{ eventId: string; supplierId: string; connectionId: string; ownerSessionEpoch: string; supplierGeneration: number }> = [];
    const released: string[] = [];
    const lane = new SatWindowP2pLane();
    await lane.start({
      host: {},
      ownerSessionEpoch: OWNER_EPOCH,
      emit: (event) => {
        if (event && typeof event === "object" && (event as { type?: unknown }).type === "ssp.request") events.push(event as typeof events[number]);
      },
      releaseEvent: (eventId) => released.push(eventId),
    });
    await lane.handle(connectOperation(), new AbortController().signal);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    const response = newActionResult({ requestId, success: true, chargedAmount: "0", errorCode: "" });
    const inbound = (connection as FakeConnection & { earlyResponse?: Promise<Uint8Array> }).earlyResponse;
    await lane.handle({
      type: "respondSsp",
      supplierId: event.supplierId,
      connectionId: event.connectionId,
      ownerSessionEpoch: event.ownerSessionEpoch,
      supplierGeneration: event.supplierGeneration,
      eventId: event.eventId,
      wire: response
    }, new AbortController().signal);
    await expect(inbound).resolves.toEqual(response);
    expect(released).toEqual([event.eventId]);
  });

  it("rejects an operation that omits a connection fence", async () => {
    const lane = new SatWindowP2pLane();
    await lane.start({ host: {}, ownerSessionEpoch: OWNER_EPOCH, emit: () => undefined });
    await expect(lane.handle({ type: "requestSsp", supplierId: "primary", wire: new Uint8Array([1]) }, new AbortController().signal)).rejects.toMatchObject({ domain: "window-p2p", code: "ERR_INVALID_CONNECTION" });
  });
});
