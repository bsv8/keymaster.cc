import { afterEach, describe, expect, it, vi } from "vitest";
import { COORDINATOR_RPC_CAPABILITY, COORDINATOR_TOPIC_STREAM_CAPABILITY, KEYSPACE_SERVICE_CAPABILITY, DEVICE_KEY_PREFIX, KEYMASTER_SESSION_KEY, type CoordinatorLocalStorageRequest, type CoordinatorLocalStorageResponse, type CoordinatorTopicEvent, type DeviceRecordV1, type KeymasterSessionV1, type SessionCoordinatorClient } from "@keymaster/contracts";
import { vaultPlugin, vaultSetup, VAULT_CAPABILITY } from "@keymaster/plugin-vault";
import { createKeymasterPluginHost as createPluginHost } from "@keymaster/runtime";
import { StorageRpcProxy } from "@keymaster/platform-storage";
import { createCoordinatorClient as createRawCoordinatorClient } from "./keymasterSessionCoordinatorClient.js";
import type { LocalStorageBridgeRequest } from "@keymaster/platform-storage/coordinator";
import { createWindowApp, definePlugin, WebLoomError, type HandlerCallContext, type ServiceReference, type WindowApp } from "webloom-framework";
import { startSharedWorkerAppForTesting, type SharedWorkerScopeLike } from "webloom-framework/testing";

type TopicWaiter = { resolve: (event: CoordinatorTopicEvent | undefined) => void; signal: AbortSignal; onAbort: () => void };

class TopicQueue {
  private readonly values: CoordinatorTopicEvent[] = [];
  private readonly waiters: TopicWaiter[] = [];

  push(event: CoordinatorTopicEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(event);
      return;
    }
    this.values.push(event);
  }

  next(signal: AbortSignal): Promise<CoordinatorTopicEvent | undefined> {
    const value = this.values.shift();
    if (value) return Promise.resolve(value);
    if (signal.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const waiter: TopicWaiter = {
        resolve,
        signal,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          resolve(undefined);
        },
      };
      this.waiters.push(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    });
  }
}

const activeHubs = new Set<Hub>();

async function nextMacrotask(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

class Hub {
  private readonly globalScope: SharedWorkerScopeLike = { onconnect: null };
  private readonly topicQueues = new Set<TopicQueue>();
  private readonly workerApp;

  constructor() {
    const workerPlugin = definePlugin({
      id: "keymaster-test-coordinator",
      runtime: "shared-worker",
      provides: [COORDINATOR_RPC_CAPABILITY, COORDINATOR_TOPIC_STREAM_CAPABILITY] as const,
      startup: "required" as const,
      setup: (ctx) => {
        ctx.handle(COORDINATOR_RPC_CAPABILITY, (request) => ({
          sessionEpoch: "shared-epoch",
          ack: { status: "ok" },
          operationResult: {
            authorityInstanceId: "authority:hub",
            sessionEpoch: "shared-epoch",
            vaultStatus: "locked",
            keyspaceGeneration: 0,
            taskSnapshots: [],
            scheduleSettings: { assetHoldingsIntervalMs: 900_000 },
            ...(request.kind === "session.open" ? {
              sessionBinding: { peerGeneration: 1, sessionEpoch: "shared-epoch", leaseId: request.leaseId },
            } : {}),
          },
        }));
        ctx.handle(COORDINATOR_TOPIC_STREAM_CAPABILITY, (_request, call) => {
          const queue = new TopicQueue();
          this.topicQueues.add(queue);
          return {
            [Symbol.asyncIterator]: () => ({
              next: async () => {
                const event = await queue.next(call.signal);
                if (!event) {
                  this.topicQueues.delete(queue);
                  return { done: true as const, value: undefined };
                }
                return { done: false as const, value: event };
              },
              return: async () => {
                this.topicQueues.delete(queue);
                return { done: true as const, value: undefined };
              },
            }),
          };
        });
      },
    });
    this.workerApp = startSharedWorkerAppForTesting({
      id: "keymaster-coordinator",
      plugins: [workerPlugin],
      expose: [COORDINATOR_RPC_CAPABILITY, COORDINATOR_TOPIC_STREAM_CAPABILITY],
      globalScope: this.globalScope,
    });
    activeHubs.add(this);
  }

  createPort(): MessagePort {
    const channel = new MessageChannel();
    queueMicrotask(() => this.globalScope.onconnect?.({ ports: [channel.port2] }));
    return channel.port1;
  }

  async broadcast(event: unknown): Promise<void> {
    for (const queue of this.topicQueues) queue.push(event as CoordinatorTopicEvent);
    await nextMacrotask();
    await nextMacrotask();
  }

  async dispose(): Promise<void> {
    activeHubs.delete(this);
    await this.workerApp.dispose("test hub disposed");
  }
}

type TestPostMessage = {
  (message: any, transfer?: any): unknown;
  mockImplementation(implementation: (...args: any[]) => unknown): TestPostMessage;
};

function createTestMessagePort(
  initialImplementation?: TestPostMessage,
  options: { autoReady?: boolean } = {},
) {
  const calls = new Map<string, { mode: "unary" | "stream"; serviceInstanceId: string; nextSequence: number; request?: Record<string, unknown> }>();
  const runtimeMessageListeners = new Set<(event: MessageEvent) => void>();
  let runtimeMessageErrorListener: ((event: MessageEvent) => void) | null = null;
  let manuallyDisabled = false;
  let implementation: (message: any, transfer?: readonly Transferable[]) => unknown = initialImplementation ?? (() => undefined);
  // WebLoom 0.4.3 的每条跨 realm 消息都必须带 endpoint binding；这个
  // fake port 只模拟 Worker wire，不再依赖旧版缺少 binding 的宽松解码。
  const remoteBinding = {
    runtimeInstanceId: "test-coordinator-worker",
    connectionId: "connection:test-coordinator-worker",
  } as const;

  const capabilityKind = (message: Record<string, unknown>): "unary" | "stream" => message.mode === "stream" ? "stream" : "unary";
  const toLegacyOutbound = (message: unknown): unknown => {
    if (!message || typeof message !== "object") return message;
    const value = message as Record<string, any>;
    if (value.type === "webloom.runtime.v1.call") {
      const mode = capabilityKind(value);
      const request = value.request && typeof value.request === "object" ? value.request as Record<string, unknown> : {};
      calls.set(value.callId as string, { mode, serviceInstanceId: value.serviceInstanceId as string, nextSequence: 1, request });
      const requestKind = request.kind;
      const kind = mode === "stream"
        ? "subscribe"
        : requestKind === "session.open" ? "hello" : requestKind === "session.activity" ? "activity" : requestKind;
      return { ...request, requestId: value.callId, kind };
    }
    if (value.type === "webloom.runtime.v1.cancel") {
      return { kind: "cancel", requestId: value.callId, targetRequestId: value.callId };
    }
    return value;
  };

  const dispatchInbound = (raw: unknown): void => {
    if (runtimeMessageListeners.size === 0) return;
    const emit = (event: MessageEvent): void => { for (const listener of [...runtimeMessageListeners]) listener(event); };
    if (raw && typeof raw === "object" && typeof (raw as { type?: unknown }).type === "string" && (raw as { type: string }).type.startsWith("webloom.runtime.v1.")) {
      const message = raw as Record<string, unknown>;
      emit({ data: { ...message, binding: message.binding ?? remoteBinding } } as MessageEvent);
      return;
    }
    if (raw && typeof raw === "object" && typeof (raw as { requestId?: unknown }).requestId === "string") {
      const value = raw as { requestId: string; sessionEpoch?: string; ack?: unknown; operationResult?: unknown };
      const call = calls.get(value.requestId);
      if (!call) return;
      if (call.mode === "stream") {
        emit({ data: { type: "webloom.runtime.v1.result", protocolVersion: "webloom.runtime.v1", binding: remoteBinding, callId: value.requestId, serviceInstanceId: call.serviceInstanceId, streamReady: true } } as MessageEvent);
        const baselines = value.operationResult && typeof value.operationResult === "object" && Array.isArray((value.operationResult as { baselines?: unknown[] }).baselines)
          ? (value.operationResult as { baselines: unknown[] }).baselines
          : [];
        for (const baseline of baselines) {
          const snapshot = baseline && typeof baseline === "object" ? (baseline as { snapshot?: unknown }).snapshot : undefined;
          if (!snapshot) continue;
          emit({ data: { type: "webloom.runtime.v1.next", protocolVersion: "webloom.runtime.v1", binding: remoteBinding, callId: value.requestId, serviceInstanceId: call.serviceInstanceId, sequence: call.nextSequence++, item: snapshot } } as MessageEvent);
        }
        return;
      }
      const operationResult = call.request?.kind === "session.open"
        && value.operationResult && typeof value.operationResult === "object"
        && !("sessionBinding" in (value.operationResult as Record<string, unknown>))
        ? {
            ...(value.operationResult as Record<string, unknown>),
            // Explicit test-only adapter for pre-binding fake Worker replies.
            // Production parsing remains strict and rejects this shape.
            sessionBinding: {
              peerGeneration: 1,
              sessionEpoch: value.sessionEpoch ?? (value.operationResult as { sessionEpoch?: string }).sessionEpoch ?? "e",
              leaseId: call.request.leaseId,
            },
          }
        : value.operationResult;
      emit({ data: { type: "webloom.runtime.v1.result", protocolVersion: "webloom.runtime.v1", binding: remoteBinding, callId: value.requestId, serviceInstanceId: call.serviceInstanceId, result: { sessionEpoch: value.sessionEpoch ?? "e", ack: value.ack ?? { status: "ok" }, ...(operationResult === undefined ? {} : { operationResult }) } } } as MessageEvent);
      return;
    }
    const stream = [...calls.values()].find((call) => call.mode === "stream");
    if (!stream) return;
    const callId = [...calls.entries()].find(([, call]) => call === stream)?.[0];
    if (!callId) return;
    emit({ data: { type: "webloom.runtime.v1.next", protocolVersion: "webloom.runtime.v1", binding: remoteBinding, callId, serviceInstanceId: stream.serviceInstanceId, sequence: stream.nextSequence++, item: raw } } as MessageEvent);
  };

  const postMessage = ((message: unknown, transfer?: readonly Transferable[]) => {
    if (message && typeof message === "object") {
      const type = (message as { type?: unknown }).type;
      if (typeof type === "string" && type.startsWith("webloom.runtime.v1.") && type !== "webloom.runtime.v1.call" && type !== "webloom.runtime.v1.cancel") return undefined;
    }
    return implementation(toLegacyOutbound(message), transfer);
  }) as TestPostMessage;
  postMessage.mockImplementation = (next) => { implementation = next; return postMessage; };

  const port = {
    start: vi.fn(),
    postMessage,
    close: vi.fn(),
    get onmessage(): ((event: MessageEvent) => void) | null {
      if (manuallyDisabled || runtimeMessageListeners.size === 0) return null;
      return (event: MessageEvent) => dispatchInbound(event.data);
    },
    set onmessage(value: ((event: MessageEvent) => void) | null) {
      manuallyDisabled = value === null;
    },
    onmessageerror: null as ((event: MessageEvent) => void) | null,
    addEventListener: vi.fn((type: string, listener: (event: MessageEvent) => void) => {
      if (type === "message") {
        runtimeMessageListeners.add(listener);
        manuallyDisabled = false;
        if (options.autoReady !== false) {
          queueMicrotask(() => dispatchInbound({
            type: "webloom.runtime.v1.snapshot",
            protocolVersion: "webloom.runtime.v1",
            runtimeId: "keymaster-coordinator",
            runtimeKind: "shared-worker",
            runtimeInstanceId: "test-coordinator-worker",
            revision: 1,
            state: "ready",
            units: [],
            services: [
              { kind: "rpc", capabilityId: COORDINATOR_RPC_CAPABILITY.id, contractVersion: COORDINATOR_RPC_CAPABILITY.version, serviceInstanceId: "test-coordinator-rpc", attributes: {} },
              { kind: "stream", capabilityId: COORDINATOR_TOPIC_STREAM_CAPABILITY.id, contractVersion: COORDINATOR_TOPIC_STREAM_CAPABILITY.version, serviceInstanceId: "test-coordinator-events", attributes: {} },
            ],
          }));
        }
      }
      if (type === "messageerror") runtimeMessageErrorListener = listener;
    }),
    removeEventListener: vi.fn((type: string, listener: (event: MessageEvent) => void) => {
      if (type === "message") runtimeMessageListeners.delete(listener);
      if (type === "messageerror" && runtimeMessageErrorListener === listener) runtimeMessageErrorListener = null;
    }),
  };
  return port;
}

const activeClients = new Set<ReturnType<typeof createRawCoordinatorClient>>();
const activeWindowApps = new Set<Promise<WindowApp>>();
const clientWindowApps = new WeakMap<ReturnType<typeof createRawCoordinatorClient>, Promise<WindowApp>>();

function ensureTestWindowApp(client: ReturnType<typeof createRawCoordinatorClient>): Promise<WindowApp> {
  const existing = clientWindowApps.get(client);
  if (existing) return existing;
  const appPromise = createWindowApp({
    id: `coordinator-test-window-${activeClients.size + 1}`,
    plugins: [client.createWindowStoragePlugin()],
  }).then((app) => {
    client.setWindowApp(app);
    return app;
  });
  clientWindowApps.set(client, appPromise);
  activeWindowApps.add(appPromise);
  return appPromise;
}

/** 测试工厂显式装配页面 Runtime，保持生产 client 的 WindowApp 前置约束。 */
function createCoordinatorClient(options?: Parameters<typeof createRawCoordinatorClient>[0]): ReturnType<typeof createRawCoordinatorClient> {
  const client = createRawCoordinatorClient(options);
  const connect = client.connect.bind(client);
  client.connect = async () => {
    await ensureTestWindowApp(client);
    return connect();
  };
  activeClients.add(client);
  return client;
}

afterEach(async () => {
  for (const client of activeClients) client.shutdown();
  for (const appPromise of activeWindowApps) {
    await appPromise.then((app) => app.dispose("test client disposed"), () => undefined);
  }
  activeClients.clear();
  activeWindowApps.clear();
  await Promise.all([...activeHubs].map((hub) => hub.dispose()));
});

class BridgeMemoryStorage {
  private readonly values = new Map<string, string>();

  get length(): number { return this.values.size; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

const bridgeLockTails = new Map<string, Promise<void>>();
const bridgeLocks = {
  request: async <T>(
    name: string,
    optionsOrCallback: (() => Promise<T>) | { signal?: AbortSignal },
    maybeCallback?: () => Promise<T>,
  ) => {
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
    if (!callback) throw new Error("Web Locks callback is missing");
    const previous = bridgeLockTails.get(name) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    bridgeLockTails.set(name, tail);
    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (bridgeLockTails.get(name) === tail) bridgeLockTails.delete(name);
    }
  }
};

function bridgeDeviceRecord(label: string): DeviceRecordV1 {
  return { format: "keymaster.device", version: 1, displayName: label, location: { providerId: "local" } };
}

function bridgeSession(activeBucketId?: string): KeymasterSessionV1 {
  return {
    format: "keymaster.session",
    version: 1,
    sessionId: "0123456789abcdef0123456789abcdef",
    ...(activeBucketId === undefined ? {} : { activeBucketId }),
  };
}

function seedDeviceBinding(storage: BridgeMemoryStorage, current: { bucketId: string; label: string }): void {
  storage.setItem(`${DEVICE_KEY_PREFIX}${current.bucketId}`, JSON.stringify(bridgeDeviceRecord(current.label)));
  storage.setItem(KEYMASTER_SESSION_KEY, JSON.stringify(bridgeSession(current.bucketId)));
}

type LocalBridgeClientInternals = {
  handleLocalStorageCapabilityRequest(request: CoordinatorLocalStorageRequest, call: HandlerCallContext): Promise<CoordinatorLocalStorageResponse>;
  localStorageBridgeLease: { bucketId?: string; leaseId: string; bucketGeneration: number } | null;
  sessionBinding: { peerGeneration: number; sessionEpoch: string; leaseId: string } | null;
  pendingSessionBinding: { peerGeneration: number; sessionEpoch: string; leaseId: string } | null;
  applyTopicEvent(event: CoordinatorTopicEvent): void;
};

type LocalBridgeTestPort = {
  onmessage: ((event: MessageEvent) => void) | null;
  start(): void;
  close(): void;
  postMessage(message: unknown): void;
};

function localBridgeRequestWithoutTransportFields(
  request: LocalStorageBridgeRequest,
  fallbackBinding: { peerGeneration: number; sessionEpoch: string; leaseId: string },
): CoordinatorLocalStorageRequest {
  const value = request as LocalStorageBridgeRequest & { authorityInstanceId?: unknown; leaseId?: unknown; peerGeneration?: number; sessionEpoch?: string; signal?: unknown };
  const { authorityInstanceId: _authorityInstanceId, leaseId: _leaseId, signal: _signal, ...businessRequest } = value;
  return {
    ...businessRequest,
    peerGeneration: value.peerGeneration ?? fallbackBinding.peerGeneration,
    sessionEpoch: value.sessionEpoch ?? fallbackBinding.sessionEpoch,
    leaseId: typeof value.leaseId === "string" ? value.leaseId : fallbackBinding.leaseId,
  } as CoordinatorLocalStorageRequest;
}

function createLocalBridgeTestPort(internals: LocalBridgeClientInternals, app: WindowApp): LocalBridgeTestPort {
  let closed = false;
  const published = app.state().services.find((service) => service.capabilityId === "keymaster.coordinator.local-storage");
  if (!published) throw new Error("Local storage capability reference was not published");
  const reference: ServiceReference = {
    ...published,
    runtime: app.runtimeKind,
    runtimeInstanceId: app.runtimeInstanceId,
  };
  const port: LocalBridgeTestPort = {
    onmessage: null,
    start() {},
    close() { closed = true; },
    postMessage(message) {
      if (closed || !message || typeof message !== "object") return;
      const envelope = message as { requestId?: string; request?: LocalStorageBridgeRequest; type?: string; bucketId?: string; bucketGeneration?: number };
      if (envelope.type === "lease") {
        const lease = internals.localStorageBridgeLease;
        if (lease && Number.isSafeInteger(envelope.bucketGeneration)) {
          internals.localStorageBridgeLease = {
            ...lease,
            ...(envelope.bucketId === undefined ? { bucketId: undefined } : { bucketId: envelope.bucketId }),
            bucketGeneration: envelope.bucketGeneration as number,
          };
        }
        return;
      }
      if (!envelope.requestId || !envelope.request) return;
      const controller = new AbortController();
      const call = {
        signal: controller.signal,
        deadlineAt: Date.now() + 30_000,
        reference,
        origin: "local" as const,
      } satisfies HandlerCallContext;
      const lease = internals.localStorageBridgeLease;
      const fallbackBinding = internals.sessionBinding ?? internals.pendingSessionBinding ?? {
        peerGeneration: 1,
        sessionEpoch: "boot",
        leaseId: lease?.leaseId ?? "local-storage-test",
      };
      void internals.handleLocalStorageCapabilityRequest(localBridgeRequestWithoutTransportFields(envelope.request, fallbackBinding), call).then(
        (response) => port.onmessage?.({ data: { requestId: envelope.requestId, ok: true, response } } as MessageEvent),
        (error: unknown) => port.onmessage?.({ data: { requestId: envelope.requestId, ok: false, error: { code: (error as { code?: string }).code, message: error instanceof Error ? error.message : String(error) } } } as MessageEvent),
      );
    },
  };
  return port;
}

function installBridgeGlobals(storage: BridgeMemoryStorage): () => void {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: bridgeLocks } });
  return () => {
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
  };
}

/** 测试侧直读正式 IndexedDB 真值，验证 Local 桶对象不再进入 localStorage。 */
function readIndexedDbBucketRecord(bucketId: string, path: string): Promise<{ bytes?: Uint8Array } | undefined> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("keymaster.local", 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("objects")) database.createObjectStore("objects");
    };
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("objects", "readonly");
      const get = transaction.objectStore("objects").get([bucketId, path]);
      get.onsuccess = () => { database.close(); resolve(get.result as { bytes?: Uint8Array } | undefined); };
      get.onerror = () => { database.close(); reject(get.error ?? new Error("IndexedDB get failed")); };
    };
  });
}

function localStorageKeys(storage: BridgeMemoryStorage): string[] {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key) keys.push(key);
  }
  return keys;
}

async function openTestLocalBridge(storage: BridgeMemoryStorage, current: { bucketId: string; label: string }): Promise<{
  client: ReturnType<typeof createCoordinatorClient>;
  workerPort: LocalBridgeTestPort;
  authorityInstanceId: string;
  leaseId: string;
}> {
  seedDeviceBinding(storage, current);
  const client = createCoordinatorClient({ clientId: "local-bridge-test" });
  const internals = client as unknown as LocalBridgeClientInternals;
  const windowApp = await ensureTestWindowApp(client);
  const workerPort = createLocalBridgeTestPort(internals, windowApp);
  const lease = internals.localStorageBridgeLease;
  if (!lease) throw new Error("Local bridge test lease was not created");
  const authorityInstanceId = "authority:local-bridge-test";
  workerPort.start();
  expect(internals.localStorageBridgeLease).toMatchObject({ bucketId: current.bucketId, bucketGeneration: 1, leaseId: lease.leaseId });
  return { client, workerPort, authorityInstanceId, leaseId: lease.leaseId };
}

function sendBridgeRequest(workerPort: LocalBridgeTestPort, requestId: string, request: LocalStorageBridgeRequest | Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve) => {
    workerPort.onmessage = (event) => resolve(event.data);
    workerPort.postMessage({ requestId, request });
  });
}

describe("KeymasterSessionCoordinatorClient", () => {
  it("directly assembles the real Coordinator client with the Vault plugin", async () => {
    const hub = new Hub();
    const Constructor = vi.fn(() => ({ port: hub.createPort() }) as unknown as SharedWorker);
    const original = globalThis.SharedWorker;
    globalThis.SharedWorker = Constructor;
    try {
      // This assignment is intentional: a client API rename/removal must fail
      // typechecking before Vault's independently compiled facade can drift.
      const client: SessionCoordinatorClient = createCoordinatorClient({ clientId: "vault-assembly" });
      await client.connect();

      const host = createPluginHost({
        runtime: "window-main",
        disableConfigPersistence: true,
        coordinatorForPlugin: () => client,
        runtimeUnitImplementationRegistry: {
          get: (pluginId, unitId) => pluginId === vaultPlugin.id && unitId === vaultPlugin.units?.[0]?.id
            ? vaultSetup
            : undefined,
        },
      });
      await host.register(vaultPlugin);

      expect(host.state("vault").kind).toBe("enabled");
      expect(host.capabilities.has(VAULT_CAPABILITY)).toBe(true);
      expect(host.capabilities.has(KEYSPACE_SERVICE_CAPABILITY)).toBe(true);
    } finally {
      globalThis.SharedWorker = original;
    }
  });

  it("fails closed when SharedWorker is unavailable", async () => {
    const original = globalThis.SharedWorker;
    // @ts-expect-error test shim
    globalThis.SharedWorker = undefined;
    try { await expect(createCoordinatorClient({ reconnectIntervalMs: 1 }).connect()).rejects.toThrow("SharedWorker"); }
    finally { globalThis.SharedWorker = original; }
  });

  it("passes Storage binary payloads through postMessage transferables", async () => {
    let receivedLength = -1;
    const postMessage = vi.fn((message: any, transfer: ArrayBuffer[] = []) => {
      if (message.kind === "storage.data") {
        const cloned = structuredClone(message, { transfer });
        receivedLength = cloned.data.input.content.bytes.byteLength;
      }
      const operationResult = message.kind === "hello"
        ? { authorityInstanceId: "authority:test", sessionEpoch: "e", vaultStatus: "locked", keyspaceGeneration: 0, taskSnapshots: [], scheduleSettings: { assetHoldingsIntervalMs: 1 } }
        : {};
      queueMicrotask(() => port.onmessage?.({ data: { requestId: message.requestId, sessionEpoch: "e", ack: { status: "ok" }, operationResult } } as MessageEvent));
    });
    const port = createTestMessagePort(postMessage);
    const worker = { port } as unknown as SharedWorker;
    const original = globalThis.SharedWorker;
    globalThis.SharedWorker = vi.fn(() => worker);
    try {
      const client = createCoordinatorClient(); await client.connect();
      const bytes = new Uint8Array([1, 2, 3]).buffer;
      await client.storageData({ type: "put", grantId: "g", input: { path: "x", content: { $type: "binary", bytes } } }, [bytes]);
      expect(receivedLength).toBe(3);
      expect(bytes.byteLength).toBe(0);
    } finally { globalThis.SharedWorker = original; }
  });

  it("uses the module URL constructor and a session-scoped Worker name", async () => {
    const port = createTestMessagePort();
    port.postMessage.mockImplementation((message: unknown) => { const request = message as { requestId: string }; queueMicrotask(() => port.onmessage?.({ data: { requestId: request.requestId, sessionEpoch: "e", ack: { status: "ok" }, operationResult: { authorityInstanceId: "authority:test", sessionEpoch: "e", vaultStatus: "locked", keyspaceGeneration: 0, taskSnapshots: [], scheduleSettings: { assetHoldingsIntervalMs: 1 } } } } as MessageEvent)); });
    const worker = { port } as unknown as SharedWorker;
    const Constructor = vi.fn(() => worker);
    const original = globalThis.SharedWorker;
    globalThis.SharedWorker = Constructor;
    try {
      const client = createCoordinatorClient();
      await client.connect();
      expect(Constructor).toHaveBeenCalledWith(expect.anything(), {
        name: expect.stringMatching(/^keymaster-coordinator-dev:([0-9a-f]{32}|default)$/u),
        type: "module"
      });
    }
    finally { globalThis.SharedWorker = original; }
  });

  it("only uses a fixed SharedWorker name when the host explicitly requests one", async () => {
    const port = createTestMessagePort();
    port.postMessage.mockImplementation((message: unknown) => {
      const request = message as { requestId: string };
      queueMicrotask(() => port.onmessage?.({ data: { requestId: request.requestId, sessionEpoch: "e", ack: { status: "ok" }, operationResult: { authorityInstanceId: "authority:test", sessionEpoch: "e", vaultStatus: "locked", keyspaceGeneration: 0, taskSnapshots: [], scheduleSettings: { assetHoldingsIntervalMs: 1 } } } } as MessageEvent));
    });
    const Constructor = vi.fn(() => ({ port }) as unknown as SharedWorker);
    const original = globalThis.SharedWorker;
    globalThis.SharedWorker = Constructor;
    try {
      const client = createCoordinatorClient({ workerName: "custom-worker" });
      await client.connect();
      expect(Constructor).toHaveBeenCalledWith(expect.any(URL), {
        name: "custom-worker",
        type: "module"
      });
    } finally {
      globalThis.SharedWorker = original;
    }
  });

  it("connects two clients to one Worker hub and fans out state events", async () => {
    const hub = new Hub();
    const Constructor = vi.fn(() => ({ port: hub.createPort() }) as unknown as SharedWorker);
    const original = globalThis.SharedWorker;
    globalThis.SharedWorker = Constructor;
    try {
      const a = createCoordinatorClient({ clientId: "a" });
      const b = createCoordinatorClient({ clientId: "b" });
      await Promise.all([a.connect(), b.connect()]);
      expect(a.getBootstrapSnapshot().vaultStatus).toBe("locked");
      expect(b.getBootstrapSnapshot().sessionEpoch).toBe("shared-epoch");
      const observed: string[] = [];
      b.subscribeTopic("session.state", (event: any) => observed.push(event.vaultStatus));
      await hub.broadcast({ topic: "session.state", sessionRevision: 1, type: "session.state.changed", cause: "unlock", sessionEpoch: "unlocked-epoch", vaultStatus: "unlocked", activePublicKeyHex: "a".repeat(64), selectedPublicKeyHex: "a".repeat(64), keyspaceGeneration: 1 });
      expect(b.getBootstrapSnapshot().vaultStatus).toBe("unlocked");
      expect(b.getBootstrapSnapshot().selectedPublicKeyHex).toBe("a".repeat(64));
      expect(observed).toContain("unlocked");
      a.disconnect();
      expect(b.getIsConnected()).toBe(true);
    } finally {
      globalThis.SharedWorker = original;
    }
  });

  it("adopts a later session epoch so subsequent commands do not use a stale epoch", async () => {
    const hub = new Hub();
    const Constructor = vi.fn(() => ({ port: hub.createPort() }) as unknown as SharedWorker);
    const original = globalThis.SharedWorker;
    globalThis.SharedWorker = Constructor;
    try {
      const client = createCoordinatorClient({ clientId: "epoch-transition" });
      await client.connect();

      await hub.broadcast({
        topic: "session.state",
        type: "session.state.changed",
        sessionRevision: 1,
        cause: "unlock",
        sessionEpoch: "unlocked-epoch",
        vaultStatus: "unlocked",
        activePublicKeyHex: "a".repeat(64),
        keyspaceGeneration: 1
      });
      await hub.broadcast({
        topic: "session.state",
        type: "session.state.changed",
        sessionRevision: 2,
        cause: "lock",
        sessionEpoch: "locked-epoch",
        vaultStatus: "locked",
        activePublicKeyHex: null,
        keyspaceGeneration: 2
      });

      expect(client.getBootstrapSnapshot()).toMatchObject({
        sessionEpoch: "locked-epoch",
        vaultStatus: "locked"
      });
    } finally {
      globalThis.SharedWorker = original;
    }
  });

  it("保留旧 Worker 活动最终 I/O 的 recovery-required 状态，并接受后续清除", async () => {
    const hub = new Hub();
    const original = globalThis.SharedWorker;
    globalThis.SharedWorker = vi.fn(() => ({ port: hub.createPort() }) as unknown as SharedWorker);
    try {
      const client = createCoordinatorClient({ clientId: "authority-recovery" });
      await client.connect();
      const base = {
        topic: "session.state" as const,
        type: "session.state.changed" as const,
        cause: "bootstrap" as const,
        sessionEpoch: "epoch-1",
        vaultStatus: "locked" as const,
        activePublicKeyHex: null,
        keyspaceGeneration: 1,
      };
      await hub.broadcast({
        ...base,
        sessionRevision: 1,
        authorityRecovery: {
          status: "recovery-required" as const,
          reason: "active-final-io-leases" as const,
          authorityBuildId: "worker-build-old",
          activeIoLeaseCount: 2,
          activeIoOperations: { read: 1, write: 1 },
          handoverGeneration: 7,
        },
      });
      expect(client.getBootstrapSnapshot().authorityRecovery).toMatchObject({
        status: "recovery-required",
        activeIoLeaseCount: 2,
        handoverGeneration: 7,
      });

      await hub.broadcast({
        ...base,
        sessionRevision: 2,
        authorityRecovery: {
          status: "recovery-required" as const,
          reason: "active-final-io-leases" as const,
          authorityBuildId: "worker-build-forged",
          activeIoLeaseCount: 2,
          // 读写计数与总数不一致，客户端必须丢弃这条伪造诊断。
          activeIoOperations: { read: 0, write: 1 },
          handoverGeneration: 8,
        },
      });
      // Session 事件整体非法时客户端进入断线安全态，不能继续信任旧诊断。
      expect(client.getBootstrapSnapshot().authorityRecovery).toBeUndefined();

      await hub.broadcast({ ...base, sessionRevision: 3, sessionEpoch: "epoch-2" });
      expect(client.getBootstrapSnapshot().authorityRecovery).toBeUndefined();
    } finally {
      globalThis.SharedWorker = original;
    }
  });

  it("does not notify session listeners for duplicate or stale session revisions", async () => {
    const hub = new Hub();
    const original = globalThis.SharedWorker;
    globalThis.SharedWorker = vi.fn(() => ({ port: hub.createPort() }) as unknown as SharedWorker);
    try {
      const client = createCoordinatorClient({ clientId: "session-revision-gate" });
      await client.connect();
      const events: unknown[] = [];
      client.subscribeTopic("session.state", (event) => events.push(event));
      const accepted = {
        topic: "session.state" as const,
        type: "session.state.changed" as const,
        sessionRevision: 2,
        sessionEpoch: "epoch-2",
        cause: "activate-key" as const,
        vaultStatus: "unlocked" as const,
        activePublicKeyHex: "c".repeat(64),
        keyspaceGeneration: 2,
      };
      await hub.broadcast(accepted);
      await hub.broadcast(accepted);
      await hub.broadcast({ ...accepted, sessionRevision: 1, sessionEpoch: "stale-epoch", activePublicKeyHex: "d".repeat(64) });

      expect(events).toEqual([accepted]);
      expect(client.getBootstrapSnapshot()).toMatchObject({ sessionEpoch: "epoch-2", activePublicKeyHex: "c".repeat(64), keyspaceGeneration: 2 });
    } finally {
      globalThis.SharedWorker = original;
    }
  });

  it("routes background.snapshot only to the background topic listener", async () => {
    const hub = new Hub();
    const Constructor = vi.fn(() => ({ port: hub.createPort() }) as unknown as SharedWorker);
    const original = globalThis.SharedWorker;
    globalThis.SharedWorker = Constructor;
    try {
      const client = createCoordinatorClient({ clientId: "domain-isolation" });
      await client.connect();
      const vaultEvents: unknown[] = [];
      const backgroundEvents: unknown[] = [];
      client.subscribeTopic("session.state", (event) => vaultEvents.push(event));
      client.subscribeTopic("background.snapshot", (event) => backgroundEvents.push(event));

      await hub.broadcast({
        topic: "background.snapshot",
        type: "background.snapshot.changed",
        backgroundSnapshotRevision: 1,
        sessionEpoch: "shared-epoch",
        snapshots: []
      });

      expect(backgroundEvents).toHaveLength(1);
      expect(vaultEvents).toHaveLength(0);
    } finally {
      globalThis.SharedWorker = original;
    }
  });

  it("applies topic baselines returned by subscribe before exposing the client", async () => {
    const port = createTestMessagePort();
    port.postMessage.mockImplementation((message: unknown) => {
      const request = message as { requestId: string; kind: string };
      const operationResult = request.kind === "subscribe"
        ? {
            topics: ["session.state"],
            baselines: [{
              topic: "session.state",
              baselineRevision: 7,
              sessionEpoch: "baseline-epoch",
              snapshot: {
                topic: "session.state",
                type: "session.state.changed",
                sessionRevision: 7,
                cause: "bootstrap",
                sessionEpoch: "baseline-epoch",
                vaultStatus: "unlocked",
                activePublicKeyHex: "b".repeat(64),
                keyspaceGeneration: 1
              }
            }]
          }
        : { authorityInstanceId: "authority:test", sessionEpoch: "boot-epoch", vaultStatus: "locked", keyspaceGeneration: 0, taskSnapshots: [], scheduleSettings: { assetHoldingsIntervalMs: 1 } };
      queueMicrotask(() => port.onmessage?.({ data: { requestId: request.requestId, sessionEpoch: "baseline-epoch", ack: { status: "ok" }, operationResult } } as MessageEvent));
    });
    const original = globalThis.SharedWorker;
    globalThis.SharedWorker = vi.fn(() => ({ port }) as unknown as SharedWorker);
    try {
      const client = createCoordinatorClient();
      await client.connect();
      expect(client.getBootstrapSnapshot()).toMatchObject({ vaultStatus: "unlocked", activePublicKeyHex: "b".repeat(64), sessionEpoch: "baseline-epoch" });
    } finally { globalThis.SharedWorker = original; }
  });

  it("binds plugin intent events to the current Worker authority and revision", async () => {
    const authority = "authority:client-test";
    const port = createTestMessagePort();
    port.postMessage.mockImplementation((message: unknown) => {
      const request = message as { requestId: string; kind: string; command?: unknown };
      let operationResult: unknown;
      if (request.kind === "hello") {
        operationResult = {
          authorityInstanceId: authority,
          sessionEpoch: "e",
          vaultStatus: "locked",
          keyspaceGeneration: 0,
          taskSnapshots: [],
          scheduleSettings: { assetHoldingsIntervalMs: 1 },
          pluginIntent: { revision: 1, desiredEnabled: { alpha: false }, desiredRevision: { alpha: 1 } },
        };
      } else if (request.kind === "subscribe") {
        operationResult = {
          topics: ["plugin.intent"],
          baselines: [{
            topic: "plugin.intent",
            baselineRevision: 1,
            sessionEpoch: "e",
            snapshot: {
              topic: "plugin.intent",
              type: "plugin.intent.changed",
              authorityInstanceId: authority,
              pluginIntentRevision: 1,
              sessionEpoch: "e",
              snapshot: { revision: 1, desiredEnabled: { alpha: false }, desiredRevision: { alpha: 1 } },
            },
          }],
        };
      } else if (request.kind === "plugin.intent.snapshot") {
        operationResult = { revision: 2, desiredEnabled: { alpha: true }, desiredRevision: { alpha: 2 } };
      } else if (request.kind === "plugin.intent.submit") {
        operationResult = {
          status: "accepted",
          commandId: (request.command as { commandId: string }).commandId,
          persisted: true,
          snapshot: { revision: 3, desiredEnabled: { alpha: true }, desiredRevision: { alpha: 3 } },
        };
      } else {
        operationResult = {};
      }
      queueMicrotask(() => port.onmessage?.({ data: { requestId: request.requestId, sessionEpoch: "e", ack: { status: "ok" }, operationResult } } as MessageEvent));
    });
    const original = globalThis.SharedWorker;
    globalThis.SharedWorker = vi.fn(() => ({ port }) as unknown as SharedWorker);
    try {
      const client = createCoordinatorClient({ clientId: "intent-client" });
      await client.connect();
      expect(client.getBootstrapSnapshot()).toMatchObject({
        authorityInstanceId: authority,
        pluginIntent: { revision: 1, desiredEnabled: { alpha: false } },
      });

      const events: unknown[] = [];
      client.subscribeTopic("plugin.intent", (event) => events.push(event));
      port.onmessage?.({ data: {
        topic: "plugin.intent",
        type: "plugin.intent.changed",
        authorityInstanceId: authority,
        pluginIntentRevision: 2,
        sessionEpoch: "e",
        snapshot: { revision: 2, desiredEnabled: { alpha: true }, desiredRevision: { alpha: 2 } },
      } } as MessageEvent);
      port.onmessage?.({ data: {
        topic: "plugin.intent",
        type: "plugin.intent.changed",
        authorityInstanceId: "authority:old",
        pluginIntentRevision: 99,
        sessionEpoch: "e",
        snapshot: { revision: 99, desiredEnabled: { alpha: false }, desiredRevision: { alpha: 99 } },
      } } as MessageEvent);
      await nextMacrotask();
      await nextMacrotask();
      expect(events).toHaveLength(1);
      expect(client.getBootstrapSnapshot().pluginIntent?.revision).toBe(2);

      const result = await client.pluginIntentSubmit({
        commandId: "intent-command:1",
        authorityInstanceId: authority,
        expectedRevision: 2,
        pluginId: "alpha",
        desiredEnabled: true,
      });
      expect(result).toMatchObject({ status: "accepted", commandId: "intent-command:1" });
      expect(client.getBootstrapSnapshot().pluginIntent?.revision).toBe(3);
    } finally { globalThis.SharedWorker = original; }
  });

  it("按 authority 和单调 revision 合并 Worker 运行单元快照", async () => {
    const hub = new Hub();
    const original = globalThis.SharedWorker;
    globalThis.SharedWorker = vi.fn(() => ({ port: hub.createPort() }) as unknown as SharedWorker);
    try {
      const client = createCoordinatorClient({ clientId: "worker-unit-snapshot-client" });
      await client.connect();
      const events: unknown[] = [];
      client.subscribeTopic("worker.units", (event) => events.push(event));
      const unit = {
        productId: "p2pkh",
        unitId: "p2pkh.coordinator-worker",
        runtime: "shared-worker" as const,
        scopeKind: "owner-session" as const,
        instanceId: "worker-unit:1",
        state: "ready" as const,
        snapshotRevision: 2,
        serviceIds: ["p2pkh.asset-service"],
        taskIds: ["p2pkh.transactions-sync"],
        ownerPublicKeyHex: "a".repeat(64),
        sessionEpoch: "shared-epoch",
      };
      const accepted = {
        topic: "worker.units" as const,
        type: "coordinator.worker-units.changed" as const,
        authorityInstanceId: "authority:hub",
        workerUnitRevision: 2,
        sessionEpoch: "shared-epoch",
        units: [unit],
      };
      await hub.broadcast(accepted);
      await hub.broadcast({ ...accepted, units: [{ ...unit, instanceId: "worker-unit:stale" }] });
      await hub.broadcast({ ...accepted, authorityInstanceId: "authority:old", workerUnitRevision: 99 });

      expect(events).toEqual([accepted]);
      expect(client.getBootstrapSnapshot()).toMatchObject({
        authorityInstanceId: "authority:hub",
        coordinatorWorkerUnitSnapshotRevision: 2,
        coordinatorWorkerUnits: [expect.objectContaining({ instanceId: "worker-unit:1" })],
      });
    } finally { globalThis.SharedWorker = original; }
  });

  it("按 sessionEpoch 防止 Worker 单元快照跨世代乱序覆盖", async () => {
    const hub = new Hub();
    const original = globalThis.SharedWorker;
    globalThis.SharedWorker = vi.fn(() => ({ port: hub.createPort() }) as unknown as SharedWorker);
    try {
      const client = createCoordinatorClient({ clientId: "worker-unit-session-fence" });
      await client.connect();
      const events: unknown[] = [];
      client.subscribeTopic("worker.units", (event) => events.push(event));
      const oldUnit = {
        productId: "storage",
        unitId: "storage.coordinator-worker",
        runtime: "shared-worker" as const,
        scopeKind: "storage" as const,
        instanceId: "worker-unit:old",
        state: "ready" as const,
        snapshotRevision: 1,
        serviceIds: ["storage.runtime-controller"],
        taskIds: [],
      };
      const oldEvent = {
        topic: "worker.units" as const,
        type: "coordinator.worker-units.changed" as const,
        authorityInstanceId: "authority:hub",
        workerUnitRevision: 1,
        sessionEpoch: "shared-epoch",
        units: [oldUnit],
      };
      await hub.broadcast(oldEvent);

      const nextEvent = {
        ...oldEvent,
        workerUnitRevision: 2,
        sessionEpoch: "next-session",
        units: [{
          ...oldUnit,
          productId: "p2pkh",
          unitId: "p2pkh.coordinator-worker",
          scopeKind: "owner-session" as const,
          instanceId: "worker-unit:next",
          snapshotRevision: 2,
          serviceIds: ["p2pkh.asset-service"],
          taskIds: ["p2pkh.transactions-sync"],
          ownerPublicKeyHex: "a".repeat(64),
          sessionEpoch: "next-session",
        }],
      };
      // 运行单元事件先到时必须等待 session.state，而不能覆盖旧世代。
      await hub.broadcast(nextEvent);
      expect(client.getBootstrapSnapshot().coordinatorWorkerUnits).toEqual([oldUnit]);

      await hub.broadcast({
        topic: "session.state" as const,
        type: "session.state.changed" as const,
        sessionRevision: 1,
        cause: "lock" as const,
        sessionEpoch: "next-session",
        vaultStatus: "locked" as const,
        activePublicKeyHex: null,
        keyspaceGeneration: 2,
      });
      expect(client.getBootstrapSnapshot()).toMatchObject({
        sessionEpoch: "next-session",
        coordinatorWorkerUnits: [expect.objectContaining({ instanceId: "worker-unit:next" })],
      });

      // 新世代已经确认后，迟到的旧世代即使 revision 更大也只能暂存，
      // 不能改写当前页面状态或触发运行单元监听器。
      await hub.broadcast({ ...oldEvent, workerUnitRevision: 99, units: [{ ...oldUnit, instanceId: "worker-unit:late-old" }] });
      expect(events).toHaveLength(2);
      expect(client.getBootstrapSnapshot().coordinatorWorkerUnits).toEqual(expect.arrayContaining([
        expect.objectContaining({ instanceId: "worker-unit:next" }),
      ]));
    } finally { globalThis.SharedWorker = original; }
  });

  it("clears an unlocked snapshot on transport timeout before reconnect", async () => {
    const port = createTestMessagePort();
    port.postMessage.mockImplementation((message: unknown) => { const request = message as { requestId: string }; if (request.requestId) queueMicrotask(() => port.onmessage?.({ data: { requestId: request.requestId, sessionEpoch: "e", ack: { status: "ok" }, operationResult: { authorityInstanceId: "authority:test", sessionEpoch: "e", vaultStatus: "unlocked", activePublicKeyHex: "a".repeat(64), keyspaceGeneration: 1, authorityRecovery: { status: "recovery-required", reason: "active-final-io-leases", authorityBuildId: "old-worker", activeIoLeaseCount: 1, activeIoOperations: { read: 0, write: 1 }, handoverGeneration: 1 }, taskSnapshots: [], scheduleSettings: { assetHoldingsIntervalMs: 1 } } } } as MessageEvent)); });
    const original = globalThis.SharedWorker;
    globalThis.SharedWorker = vi.fn(() => ({ port }) as unknown as SharedWorker);
    try {
      const client = createCoordinatorClient({ requestTimeoutMs: 5, reconnectIntervalMs: 1000 });
      await client.connect();
      expect(client.getBootstrapSnapshot().vaultStatus).toBe("unlocked");
      expect(client.getBootstrapSnapshot().authorityRecovery?.status).toBe("recovery-required");
      port.onmessage = null;
      await expect(client.backgroundRunNow("missing")).resolves.toMatchObject({ status: "transport-error", retryable: false });
      // Transport loss does not erase the last truthful snapshot; callers use
      // getIsConnected()/getConnectionState() to distinguish it from live state.
      expect(client.getBootstrapSnapshot().vaultStatus).toBe("unlocked");
      expect(client.getBootstrapSnapshot().authorityRecovery).toBeUndefined();
      expect(client.getConnectionState()).toBe("recoverable");
    } finally { globalThis.SharedWorker = original; }
  });

  it("normalizes every public command/value facade on transport loss", async () => {
    const port = createTestMessagePort();
    port.postMessage.mockImplementation((message: unknown) => {
      const request = message as { requestId: string; kind: string };
      if (request.kind === "hello" || request.kind === "subscribe") {
        queueMicrotask(() => port.onmessage?.({ data: { requestId: request.requestId, sessionEpoch: "e", ack: { status: "ok" }, operationResult: { authorityInstanceId: "authority:test", sessionEpoch: "e", vaultStatus: "locked", keyspaceGeneration: 0, taskSnapshots: [], scheduleSettings: { assetHoldingsIntervalMs: 1 } } } } as MessageEvent));
      }
    });
    const original = globalThis.SharedWorker;
    globalThis.SharedWorker = vi.fn(() => ({ port }) as unknown as SharedWorker);
    try {
      const client = createCoordinatorClient({ requestTimeoutMs: 5, reconnectIntervalMs: 1000 });
      await client.connect();
      await expect(client.unlock("pw")).resolves.toMatchObject({ status: "transport-error" });
      await expect(client.vaultOperation({ type: "listKeys" })).resolves.toMatchObject({ status: "transport-error" });
      await expect(client.crypto({ type: "deriveP2pkhAddress", network: "main" })).resolves.toMatchObject({ ack: { status: "transport-error" } });
      expect(client.getRecoverableDiagnostics().length).toBeGreaterThan(0);
    } finally { globalThis.SharedWorker = original; }
  });

  it("does not turn a local DTO validation error into a Coordinator disconnect", async () => {
    const hub = new Hub();
    const original = globalThis.SharedWorker;
    globalThis.SharedWorker = vi.fn(() => ({ port: hub.createPort() }) as unknown as SharedWorker);
    try {
      const client = createCoordinatorClient({ clientId: "local-dto-validation" });
      await client.connect();
      const result = await client.channelOperation({
        type: "private-publish",
        ownerPublicKeyHex: "a".repeat(64),
        caller: { kind: "plugin", pluginId: "contacts" },
        recipientPublicKeyHex: "b".repeat(64),
        protocol: "bsv8.message.v1",
        // 生产 DTO parser 必须拒绝 undefined；这是页面侧业务对象修复前
        // 会触发的路径，失败不代表 SharedWorker 已断开。
        content: undefined,
      } as any);
      expect(result).toMatchObject({ status: "transport-error", retryable: false, dispatchStatus: "not-dispatched" });
      expect(result.status).toBe("transport-error");
      if (result.status === "transport-error") {
        expect(result.message).toMatch(/request validation|invalid value/iu);
      }
      expect(client.getIsConnected()).toBe(true);
    } finally { globalThis.SharedWorker = original; }
  });

  it("reports an actionable error when SharedWorker.onerror fires before ready", async () => {
    // No ready snapshot is emitted: this models the raw browser worker error
    // path, where WebLoom only reports `disconnected` and does not expose
    // ErrorEvent.message to the client.
    const port = createTestMessagePort(undefined, { autoReady: false });
    const worker = { port, onerror: null as ((event: Event) => void) | null } as unknown as SharedWorker;
    const original = globalThis.SharedWorker;
    globalThis.SharedWorker = vi.fn(() => worker);
    let client: ReturnType<typeof createCoordinatorClient> | undefined;
    try {
      client = createCoordinatorClient({ requestTimeoutMs: 1_000, reconnectIntervalMs: 1_000 });
      const connecting = client.connect();
      await nextMacrotask();
      worker.onerror?.({ type: "error" } as ErrorEvent);
      await expect(connecting).rejects.toThrow(
        "Coordinator SharedWorker failed before publishing a ready Runtime snapshot; inspect the Worker console",
      );
      expect(client.getIsConnected()).toBe(false);
    } finally {
      client?.shutdown();
      globalThis.SharedWorker = original;
    }
  });

  it("preserves a structured WebLoom runtime-error wire message", async () => {
    // This is distinct from the raw SharedWorker.onerror path above: a
    // WebLoom runtime-error message does carry a structured diagnostic.
    const port = createTestMessagePort();
    const worker = { port } as unknown as SharedWorker;
    const original = globalThis.SharedWorker;
    globalThis.SharedWorker = vi.fn(() => worker);
    let client: ReturnType<typeof createCoordinatorClient> | undefined;
    try {
      client = createCoordinatorClient({ requestTimeoutMs: 1_000, reconnectIntervalMs: 1_000 });
      const connecting = client.connect();
      await nextMacrotask();
      port.onmessage?.({ data: {
        type: "webloom.runtime.v1.runtime-error",
        protocolVersion: "webloom.runtime.v1",
        code: "runtime_initialization_failed",
        message: "ReferenceError: window is not defined at @react-refresh",
        phase: "validate",
      } } as MessageEvent);
      await expect(connecting).rejects.toThrow(/window is not defined|@react-refresh/u);
    } finally {
      client?.shutdown();
      globalThis.SharedWorker = original;
    }
  });

  it("notifies the Coordinator to cancel an in-flight Channel request", async () => {
    const sent: Array<{ kind?: string; requestId?: string; targetRequestId?: string }> = [];
    const postMessage = vi.fn((message: { kind?: string; requestId?: string; targetRequestId?: string }) => {
        sent.push(message);
        if (message.kind === "hello" || message.kind === "subscribe") {
          queueMicrotask(() => port.onmessage?.({
            data: {
              requestId: message.requestId,
              sessionEpoch: "channel-epoch",
              ack: { status: "ok" },
              operationResult: message.kind === "subscribe" ? { topics: [], baselines: [] } : {
                authorityInstanceId: "authority:channel-test",
                sessionEpoch: "channel-epoch",
                vaultStatus: "unlocked",
                activePublicKeyHex: "a".repeat(64),
                keyspaceGeneration: 1,
                taskSnapshots: [],
                scheduleSettings: { assetHoldingsIntervalMs: 1 },
              },
            },
          } as MessageEvent));
        }
        if (message.kind === "channel.cancel") {
          queueMicrotask(() => port.onmessage?.({
            data: { requestId: message.requestId, sessionEpoch: "channel-epoch", ack: { status: "ok" } },
          } as MessageEvent));
        }
      });
    const port = createTestMessagePort(postMessage);
    const original = globalThis.SharedWorker;
    globalThis.SharedWorker = vi.fn(() => ({ port }) as unknown as SharedWorker);
    try {
      const client = createCoordinatorClient({ clientId: "channel-cancel-client", requestTimeoutMs: 10, reconnectIntervalMs: 1_000 });
      await client.connect();
      const controller = new AbortController();
      const operation = client.channelOperation({
        type: "subscription-set",
        ownerPublicKeyHex: "a".repeat(64),
        caller: { kind: "plugin", pluginId: "webrtc" },
        channels: ["bsv8.test.channel"],
      }, controller.signal);
      await vi.waitFor(() => expect(sent.find((message) => message.kind === "channel.operation")).toBeDefined());
      const channelRequest = sent.find((message) => message.kind === "channel.operation");
      controller.abort("page disposed");
      await expect(operation).resolves.toMatchObject({ status: "transport-error" });
      expect(sent).toContainEqual(expect.objectContaining({
        kind: "channel.cancel",
        targetRequestId: expect.stringMatching(/^req-/u),
      }));
    } finally { globalThis.SharedWorker = original; }
  });

  it("通过页面桥读写设备记录与 session", async () => {
    const storage = new BridgeMemoryStorage();
    const restoreGlobals = installBridgeGlobals(storage);
    const { client, workerPort } = await openTestLocalBridge(storage, { bucketId: "bucket-bridge", label: "桥接桶" });
    try {
      const put = await sendBridgeRequest(workerPort, "device-record-put-1", {
        type: "device-record-put",
        remoteStorageId: "bucket-other",
        record: bridgeDeviceRecord("另一个桶"),
      });
      expect(put).toMatchObject({ ok: true, response: { type: "void" } });
      expect(storage.getItem(`${DEVICE_KEY_PREFIX}bucket-other`)).not.toBeNull();

      const list = await sendBridgeRequest(workerPort, "device-record-list-1", { type: "device-record-list" }) as { response?: { type?: string; entries?: Array<{ remoteStorageId: string }> } };
      expect(list.response?.type).toBe("device-records");
      expect(list.response?.entries?.map((entry) => entry.remoteStorageId).sort()).toEqual(["bucket-bridge", "bucket-other"]);

      const got = await sendBridgeRequest(workerPort, "device-record-get-1", { type: "device-record-get", remoteStorageId: "bucket-other" }) as { response?: { record?: DeviceRecordV1 } };
      expect(got.response?.record).toMatchObject({ format: "keymaster.device", displayName: "另一个桶" });

      const read = await sendBridgeRequest(workerPort, "session-read-1", { type: "session-read" }) as { response?: { session?: KeymasterSessionV1 } };
      expect(read.response?.session?.activeBucketId).toBe("bucket-bridge");

      const nextSession = { ...bridgeSession("bucket-other"), activeKey: "02".padEnd(66, "a") };
      const write = await sendBridgeRequest(workerPort, "session-write-1", { type: "session-write", session: nextSession });
      expect(write).toMatchObject({ ok: true, response: { type: "void" } });
      expect(JSON.parse(storage.getItem(KEYMASTER_SESSION_KEY) as string)).toMatchObject({ activeBucketId: "bucket-other" });

      const removed = await sendBridgeRequest(workerPort, "device-record-delete-1", { type: "device-record-delete", remoteStorageId: "bucket-other" });
      expect(removed).toMatchObject({ ok: true, response: { type: "void" } });
      expect(storage.getItem(`${DEVICE_KEY_PREFIX}bucket-other`)).toBeNull();
    } finally {
      client.disconnect();
      workerPort.close();
      restoreGlobals();
    }
  });

  it("通过页面桥把 Local 桶对象写入 IndexedDB，而不是 localStorage", async () => {
    const storage = new BridgeMemoryStorage();
    const restoreGlobals = installBridgeGlobals(storage);
    const { client, workerPort } = await openTestLocalBridge(storage, { bucketId: "bucket-objects", label: "对象桥接桶" });
    try {
      const bytes = new Uint8Array([1, 2, 3]);
      const put = await sendBridgeRequest(workerPort, "object-put-1", {
        type: "put",
        bucketId: "bucket-objects",
        bucketGeneration: 1,
        path: "keys/key-1",
        bytes,
      });
      expect(put).toMatchObject({ ok: true, response: { type: "write", etag: expect.stringMatching(/^[0-9a-f]{64}$/u) } });

      const stored = await readIndexedDbBucketRecord("bucket-objects", "keys/key-1");
      expect(stored?.bytes).toEqual(bytes);

      const read = await sendBridgeRequest(workerPort, "object-get-1", {
        type: "get",
        bucketId: "bucket-objects",
        bucketGeneration: 1,
        path: "keys/key-1",
      }) as { response?: { object?: { bytes?: ArrayBuffer } } };
      // 跨 RPC 的批量字节必须是 ArrayBuffer，DTO 校验才不会逐元素遍历。
      expect(read.response?.object?.bytes).toBeInstanceOf(ArrayBuffer);
      expect(new Uint8Array(read.response?.object?.bytes as ArrayBuffer)).toEqual(bytes);

      // 设备记录/session 仍走 localStorage 引导层；桶对象绝不能再落进去。
      expect(storage.getItem(`keymaster.bucket.bucket-objects.keys/key-1`)).toBeNull();
      expect(localStorageKeys(storage).some((key) => key.startsWith("keymaster.bucket."))).toBe(false);
    } finally {
      client.disconnect();
      workerPort.close();
      restoreGlobals();
    }
  });

  it("页面桥以服务引用过期错误拒绝旧 lease 绑定", async () => {
    const storage = new BridgeMemoryStorage();
    const restoreGlobals = installBridgeGlobals(storage);
    const { client, workerPort, authorityInstanceId } = await openTestLocalBridge(storage, { bucketId: "bucket-bridge", label: "桥接桶" });
    try {
      const stale = await sendBridgeRequest(workerPort, "session-read-stale", {
        type: "session-read",
        authorityInstanceId,
        leaseId: "local-storage-stale",
      }) as { ok?: boolean; error?: { code?: string } };
      expect(stale).toMatchObject({ ok: false, error: { code: "service_reference_stale" } });
    } finally {
      client.disconnect();
      workerPort.close();
      restoreGlobals();
    }
  });
});
