import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoordinatorBootstrapSnapshot, SessionCoordinatorClient, WindowP2pExecutorLaneContext, WindowP2pExecutorLaneRegistry } from "@keymaster/contracts";
import { WindowP2pExecutor } from "./windowExecutor.js";

const mocks = vi.hoisted(() => ({
  createHost: vi.fn(),
  webRTCDirect: vi.fn(() => ({ name: "webrtc-direct" })),
  webSockets: vi.fn(() => ({ name: "websockets" }))
}));

vi.mock("bitcoin-libp2p/libp2p", () => ({ createHost: mocks.createHost }));
vi.mock("@libp2p/webrtc", () => ({ webRTCDirect: mocks.webRTCDirect }));
vi.mock("@libp2p/websockets", () => ({ webSockets: mocks.webSockets }));

const OWNER_A = "02" + "11".repeat(32);
const OWNER_B = "03" + "22".repeat(32);

function makeFixture(input: { attach?: (context: WindowP2pExecutorLaneContext) => Promise<void> } = {}) {
  const host = { stop: vi.fn(async () => undefined) };
  const snapshot: CoordinatorBootstrapSnapshot = {
    vaultStatus: "unlocked" as const,
    activePublicKeyHex: OWNER_A,
    sessionEpoch: "epoch-a",
    keyspaceGeneration: 1,
    taskSnapshots: [],
    scheduleSettings: {} as CoordinatorBootstrapSnapshot["scheduleSettings"]
  };
  const acquire = vi.fn(async (_owner: string, _port: MessagePort) => ({
    status: "ok" as const,
    value: {
      leaseId: "lease-a",
      sessionEpoch: snapshot.sessionEpoch,
      activePublicKeyHex: snapshot.activePublicKeyHex
    }
  }));
  const release = vi.fn(async (_leaseId: string) => ({ status: "ok" as const }));
  const coordinator = {
    getBootstrapSnapshot: () => snapshot,
    windowP2pExecutorAcquire: acquire,
    windowP2pExecutorRelease: release
  } as unknown as SessionCoordinatorClient;
  const laneRegistry = {
    attach: vi.fn(input.attach ?? (async () => undefined)),
    detach: vi.fn(async () => undefined),
    dispatch: vi.fn(),
    register: vi.fn(() => () => undefined)
  } as unknown as WindowP2pExecutorLaneRegistry;
  mocks.createHost.mockResolvedValue(host);
  return { host, snapshot, acquire, release, coordinator, laneRegistry };
}

describe("WindowP2pExecutor lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("owns one Host and closes it on stop, lock and unload", async () => {
    const fixture = makeFixture();
    const executor = new WindowP2pExecutor({ coordinator: fixture.coordinator, laneRegistry: fixture.laneRegistry });

    await expect(executor.start()).resolves.toBe(true);
    expect(mocks.createHost).toHaveBeenCalledTimes(1);
    expect(fixture.laneRegistry.attach).toHaveBeenCalledTimes(1);

    await executor.reconcileSession({ ...fixture.snapshot, vaultStatus: "locked", activePublicKeyHex: undefined });
    expect(fixture.host.stop).toHaveBeenCalledTimes(1);
    expect(fixture.release).toHaveBeenCalledWith("lease-a");

    await executor.dispose();
    expect(executor.isDisposed).toBe(true);
    expect(fixture.host.stop).toHaveBeenCalledTimes(1);
  });

  it("stops the old Host before taking over a new owner epoch", async () => {
    const fixture = makeFixture();
    const secondHost = { stop: vi.fn(async () => undefined) };
    mocks.createHost.mockResolvedValueOnce(fixture.host).mockResolvedValueOnce(secondHost);
    const executor = new WindowP2pExecutor({ coordinator: fixture.coordinator, laneRegistry: fixture.laneRegistry });

    await expect(executor.start()).resolves.toBe(true);
    fixture.snapshot.activePublicKeyHex = OWNER_B;
    fixture.snapshot.sessionEpoch = "epoch-b";
    fixture.acquire.mockImplementationOnce(async () => ({
      status: "ok" as const,
      value: { leaseId: "lease-b", sessionEpoch: "epoch-b", activePublicKeyHex: OWNER_B }
    }));

    await expect(executor.reconcileSession()).resolves.toBe(true);
    expect(fixture.host.stop).toHaveBeenCalledTimes(1);
    expect(secondHost.stop).not.toHaveBeenCalled();
    expect(mocks.createHost).toHaveBeenCalledTimes(2);
    await executor.dispose();
    expect(secondHost.stop).toHaveBeenCalledTimes(1);
  });

  it("does not publish ready or retain a Host when stop wins during lane attach", async () => {
    let releaseAttach!: () => void;
    const attachGate = new Promise<void>((resolve) => { releaseAttach = resolve; });
    const fixture = makeFixture({ attach: () => attachGate });
    const executor = new WindowP2pExecutor({ coordinator: fixture.coordinator, laneRegistry: fixture.laneRegistry });

    const starting = executor.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await executor.stop();
    releaseAttach();

    await expect(starting).resolves.toBe(false);
    expect(fixture.host.stop).toHaveBeenCalledTimes(1);
    expect(fixture.release).toHaveBeenCalledWith("lease-a");
  });

  it("pre-reserves inbound SSP Wire bytes and releases them after Worker acknowledgement", async () => {
    let workerPort: MessagePort | undefined;
    let laneContext: WindowP2pExecutorLaneContext | undefined;
    const fixture = makeFixture({
      attach: async (context) => { laneContext = context; },
    });
    fixture.acquire.mockImplementation(async (_owner: string, port: MessagePort) => {
      workerPort = port;
      return {
        status: "ok" as const,
        value: {
          leaseId: "lease-a",
          sessionEpoch: fixture.snapshot.sessionEpoch,
          activePublicKeyHex: fixture.snapshot.activePublicKeyHex,
        },
      };
    });
    const workerMessages: unknown[] = [];
    const executor = new WindowP2pExecutor({ coordinator: fixture.coordinator, laneRegistry: fixture.laneRegistry });
    // MessageChannel 的 port2 是 Worker 侧；这里只记录 Window 发出的
    // ready/event，随后由测试模拟 Worker 的 release。
    const start = executor.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    workerPort?.start();
    workerPort!.onmessage = (event: MessageEvent) => workerMessages.push(event.data);
    await expect(start).resolves.toBe(true);
    expect(laneContext).toBeDefined();

    const events = Array.from({ length: 32 }, (_, index) => ({
      type: "ssp.request" as const,
      eventId: `event-${index}`,
      supplierId: "supplier-a",
      connectionId: "connection-a",
      ownerSessionEpoch: fixture.snapshot.sessionEpoch,
      supplierGeneration: 1,
      wire: new Uint8Array(1024 * 1024),
    }));
    await Promise.all(events.map((event) => laneContext!.emit(event)));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(workerMessages.filter((message) => (message as { type?: string }).type === "event")).toHaveLength(32);

    const timedOut = Promise.resolve(laneContext!.emit({
      type: "ssp.request",
      eventId: "event-timeout",
      supplierId: "supplier-a",
      connectionId: "connection-a",
      ownerSessionEpoch: fixture.snapshot.sessionEpoch,
      supplierGeneration: 1,
      wire: new Uint8Array(1024 * 1024),
    }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(workerMessages.filter((message) => (message as { type?: string }).type === "event")).toHaveLength(32);

    // lane timeout 释放的是尚未获得 bridge admission 的 waiter；该事件
    // 不能在稍后 event-0 释放时“复活”并发送给 Worker。
    laneContext!.releaseEvent!("event-timeout");
    await expect(timedOut).rejects.toMatchObject({ code: "ERR_INBOUND_EVENT_RELEASED" });
    expect(workerMessages.filter((message) => (message as { type?: string }).type === "event")).toHaveLength(32);

    let thirdResolved = false;
    const third = Promise.resolve(laneContext!.emit({
      type: "ssp.request",
      eventId: "event-33",
      supplierId: "supplier-a",
      connectionId: "connection-a",
      ownerSessionEpoch: fixture.snapshot.sessionEpoch,
      supplierGeneration: 1,
      wire: new Uint8Array(1024 * 1024),
    })).then(() => { thirdResolved = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(thirdResolved).toBe(false);
    workerPort!.postMessage({ type: "event-release", leaseId: "lease-a", eventId: "event-0" });
    await third;
    expect(thirdResolved).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(workerMessages.filter((message) => (message as { type?: string }).type === "event")).toHaveLength(33);

    // 已经发送但 lane 后续超时/停止的事件会向 Worker 发送 cancel，避免
    // Worker 端仍处理一条已经被 lane 判定失效的旧事件。
    laneContext!.releaseEvent!("event-1");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(workerMessages).toContainEqual(expect.objectContaining({ type: "event-cancel", eventId: "event-1" }));
    await executor.dispose();
  });

  it("transfers direct Uint8Array lane responses with an exact buffer", async () => {
    const fixture = makeFixture();
    const resultWire = new Uint8Array([9, 8, 7, 6, 5]);
    fixture.laneRegistry.dispatch = vi.fn(async () => resultWire.subarray(1, 4));
    let workerPort: MessagePort | undefined;
    fixture.acquire.mockImplementation(async (_owner: string, port: MessagePort) => {
      workerPort = port;
      return {
        status: "ok" as const,
        value: {
          leaseId: "lease-a",
          sessionEpoch: fixture.snapshot.sessionEpoch,
          activePublicKeyHex: fixture.snapshot.activePublicKeyHex,
        },
      };
    });
    const messages: MessageEvent[] = [];
    const executor = new WindowP2pExecutor({ coordinator: fixture.coordinator, laneRegistry: fixture.laneRegistry });
    await expect(executor.start()).resolves.toBe(true);
    workerPort!.onmessage = (event: MessageEvent) => messages.push(event);
    workerPort!.start();
    workerPort!.postMessage({
      type: "request",
      leaseId: "lease-a",
      requestId: "request-direct-wire",
      operation: { type: "lane", laneId: "sat-subscription", operation: { type: "requestSsp" } },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const response = messages.find((event) => event.data?.type === "response")?.data as { result?: unknown } | undefined;
    expect(response?.result).toBeInstanceOf(Uint8Array);
    expect(response?.result).toEqual(new Uint8Array([8, 7, 6]));
    expect((response?.result as Uint8Array).buffer.byteLength).toBe(3);
    await executor.dispose();
  });
});
