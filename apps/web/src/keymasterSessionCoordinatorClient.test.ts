import { describe, expect, it, vi } from "vitest";
import type { CoordinatorTopicEvent, InitialSetupRecoveryRecordV1, SessionCoordinatorClient, StorageBucketCatalogEntryV2 } from "@keymaster/contracts";
import { vaultPlugin, vaultSetup, VAULT_CAPABILITY } from "@keymaster/plugin-vault";
import { createKeymasterPluginHost as createPluginHost } from "@keymaster/runtime";
import { createCoordinatorClient } from "./keymasterSessionCoordinatorClient.js";
import { readStorageCatalog, STORAGE_CATALOG_KEY } from "@keymaster/platform-storage/coordinator";
import type { LocalStorageBridgeRequest } from "@keymaster/platform-storage/coordinator";

class HubPort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  constructor(private readonly hub: Hub) {}
  start(): void {}
  close(): void { this.hub.ports.delete(this); }
  addEventListener(type: string, listener: (event: MessageEvent) => void): void { if (type === "message") this.onmessage = listener; }
  removeEventListener(type: string, listener: (event: MessageEvent) => void): void { if (type === "message" && this.onmessage === listener) this.onmessage = null; }
  postMessage(message: unknown): void { this.hub.receive(this, message as { requestId: string; kind?: string }); }
  emit(message: unknown): void { this.onmessage?.({ data: message } as MessageEvent); }
}

class Hub {
  readonly ports = new Set<HubPort>();
  createPort(): HubPort { const port = new HubPort(this); this.ports.add(port); return port; }
  receive(port: HubPort, message: { requestId: string; kind?: string }): void {
    const response = { requestId: message.requestId, sessionEpoch: "shared-epoch", ack: { status: "ok" }, operationResult: { authorityInstanceId: "authority:hub", sessionEpoch: "shared-epoch", vaultStatus: "locked", keyspaceGeneration: 0, taskSnapshots: [], scheduleSettings: { assetHoldingsIntervalMs: 900_000 } } };
    queueMicrotask(() => port.emit(response));
  }
  broadcast(event: unknown): void { for (const port of this.ports) port.emit(event); }
}

class BridgeMemoryStorage {
  private readonly values = new Map<string, string>();

  get length(): number { return this.values.size; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

const bridgeLocks = {
  request: async <T>(
    _name: string,
    optionsOrCallback: (() => Promise<T>) | { signal?: AbortSignal },
    maybeCallback?: () => Promise<T>,
  ) => {
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
    if (!callback) throw new Error("Web Locks callback is missing");
    return callback();
  }
};

function bridgeCatalogEntry(bucketId: string, label: string): StorageBucketCatalogEntryV2 {
  return {
    bucketId,
    label,
    backend: "local",
    configRevision: 1,
    keyDerivation: {
      algorithm: "pbkdf2-hmac-sha-256",
      passwordEncoding: "utf-8",
      iterations: 100_000,
      outputLengthBits: 256,
      saltB64Url: "0123456789ab"
    },
    encryptedConfig: {
      cipher: {
        algorithm: "aes-gcm",
        keyLengthBits: 256,
        ivB64Url: "0123456789ab",
        tagLengthBits: 128,
        ciphertextAndTagB64Url: "bridge-test-config"
      }
    },
    snapshotRevision: 1,
    createdAt: 1,
    updatedAt: 1
  };
}

type LocalBridgeClientInternals = {
  openLocalStorageBridge(): MessagePort;
  localStorageBridgePort: MessagePort | null;
  localStorageBridgeLease: { authorityInstanceId: string; bucketId?: string; leaseId: string; bucketGeneration: number } | null;
  applyTopicEvent(event: CoordinatorTopicEvent): void;
};

async function nextMacrotask(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
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

async function openTestLocalBridge(storage: BridgeMemoryStorage, current: StorageBucketCatalogEntryV2): Promise<{
  client: ReturnType<typeof createCoordinatorClient>;
  workerPort: MessagePort;
  authorityInstanceId: string;
  leaseId: string;
}> {
  const client = createCoordinatorClient({ clientId: "local-bridge-test" });
  const internals = client as unknown as LocalBridgeClientInternals;
  const workerPort = internals.openLocalStorageBridge();
  const lease = internals.localStorageBridgeLease;
  if (!internals.localStorageBridgePort || !lease) throw new Error("Local bridge test endpoint was not created");
  const authorityInstanceId = "authority:local-bridge-test";
  workerPort.start();
  storage.setItem(STORAGE_CATALOG_KEY, JSON.stringify({
    format: "keymaster.storage.catalog",
    version: 2,
    selectedBucketId: current.bucketId,
    buckets: [current]
  }));
  workerPort.postMessage({ type: "lease", authorityInstanceId, bucketId: current.bucketId, bucketGeneration: 1, leaseId: lease.leaseId });
  await nextMacrotask();
  await vi.waitFor(() => expect(internals.localStorageBridgeLease).toMatchObject({
    authorityInstanceId,
    bucketId: current.bucketId,
    bucketGeneration: 1,
    leaseId: lease.leaseId
  }));
  return { client, workerPort, authorityInstanceId, leaseId: lease.leaseId };
}

async function openEmptyTestLocalBridge(storage: BridgeMemoryStorage): Promise<{
  client: ReturnType<typeof createCoordinatorClient>;
  workerPort: MessagePort;
  authorityInstanceId: string;
  leaseId: string;
}> {
  const client = createCoordinatorClient({ clientId: "initial-local-bridge-test" });
  const internals = client as unknown as LocalBridgeClientInternals;
  const workerPort = internals.openLocalStorageBridge();
  const lease = internals.localStorageBridgeLease;
  if (!internals.localStorageBridgePort || !lease) throw new Error("Local bridge test endpoint was not created");
  const authorityInstanceId = "authority:initial-local-bridge-test";
  workerPort.start();
  workerPort.postMessage({ type: "lease", authorityInstanceId, bucketGeneration: 0, leaseId: lease.leaseId });
  await nextMacrotask();
  await vi.waitFor(() => expect(internals.localStorageBridgeLease).toMatchObject({
    authorityInstanceId,
    bucketGeneration: 0,
    leaseId: lease.leaseId
  }));
  return { client, workerPort, authorityInstanceId, leaseId: lease.leaseId };
}

function sendBridgeRequest(workerPort: MessagePort, requestId: string, request: LocalStorageBridgeRequest): Promise<unknown> {
  return new Promise((resolve) => {
    workerPort.onmessage = (event) => resolve(event.data);
    workerPort.postMessage({ requestId, request });
  });
}

function bridgeRecoveryRecord(transactionId: string, updatedAt: number): InitialSetupRecoveryRecordV1 {
  return {
    format: "keymaster.storage.initial-setup-recovery",
    version: 1,
    transactionId,
    bucketId: "setup-" + transactionId,
    configRevision: 1,
    snapshotRevision: 0,
    backend: "local",
    phase: "rollback",
    catalog: "empty",
    runtimeInstalled: false,
    cleanup: "unconfirmed",
    status: "failed",
    error: {
      title: "初始化失败",
      summary: "候选数据尚未清理",
      action: "请重试清理",
      code: "storage_provider_error",
      incidentId: `bridge-recovery-${transactionId}`,
      transactionId,
      diagnostic: "diagnostic",
      phase: "rollback",
      rollback: "unconfirmed",
    },
    updatedAt,
  };
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
        execution: "window",
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
      expect(host.capabilities.has("keyspace.service")).toBe(true);
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
      queueMicrotask(() => port.onmessage?.({ data: { requestId: message.requestId, sessionEpoch: "e", ack: { status: "ok" }, operationResult: {} } } as MessageEvent));
    });
    const port = { start: vi.fn(), postMessage, close: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null, onmessageerror: null };
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

  it("uses the module URL constructor", async () => {
    const port = { start: vi.fn(), postMessage: vi.fn(), close: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null, onmessageerror: null };
    port.postMessage.mockImplementation((message: unknown) => { const request = message as { requestId: string }; queueMicrotask(() => port.onmessage?.({ data: { requestId: request.requestId, sessionEpoch: "e", ack: { status: "ok" }, operationResult: { vaultStatus: "locked", keyspaceGeneration: 0, taskSnapshots: [], scheduleSettings: { assetHoldingsIntervalMs: 1 } } } } as MessageEvent)); });
    const worker = { port } as unknown as SharedWorker;
    const Constructor = vi.fn(() => worker);
    const original = globalThis.SharedWorker;
    globalThis.SharedWorker = Constructor;
    try {
      const client = createCoordinatorClient();
      await client.connect();
      expect(Constructor).toHaveBeenCalledWith(expect.any(URL), {
        name: "keymaster-coordinator-dev-20260818-woc-raw-text",
        type: "module"
      });
    }
    finally { globalThis.SharedWorker = original; }
  });

  it("only uses a fixed SharedWorker name when the host explicitly requests one", async () => {
    const port = { start: vi.fn(), postMessage: vi.fn(), close: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null, onmessageerror: null };
    port.postMessage.mockImplementation((message: unknown) => {
      const request = message as { requestId: string };
      queueMicrotask(() => port.onmessage?.({ data: { requestId: request.requestId, sessionEpoch: "e", ack: { status: "ok" }, operationResult: { vaultStatus: "locked", keyspaceGeneration: 0, taskSnapshots: [], scheduleSettings: { assetHoldingsIntervalMs: 1 } } } } as MessageEvent));
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
      hub.broadcast({ topic: "session.state", sessionRevision: 1, type: "session.state.changed", cause: "unlock", sessionEpoch: "unlocked-epoch", vaultStatus: "unlocked", activePublicKeyHex: "a".repeat(64), selectedPublicKeyHex: "a".repeat(64), keyspaceGeneration: 1 });
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

      hub.broadcast({
        topic: "session.state",
        type: "session.state.changed",
        sessionRevision: 1,
        cause: "unlock",
        sessionEpoch: "unlocked-epoch",
        vaultStatus: "unlocked",
        activePublicKeyHex: "a".repeat(64),
        keyspaceGeneration: 1
      });
      hub.broadcast({
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
      hub.broadcast({
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

      hub.broadcast({
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

      hub.broadcast({ ...base, sessionRevision: 3, sessionEpoch: "epoch-2" });
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
      hub.broadcast(accepted);
      hub.broadcast(accepted);
      hub.broadcast({ ...accepted, sessionRevision: 1, sessionEpoch: "stale-epoch", activePublicKeyHex: "d".repeat(64) });

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

      hub.broadcast({
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
    const port = { start: vi.fn(), postMessage: vi.fn(), close: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null, onmessageerror: null };
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
        : { sessionEpoch: "boot-epoch", vaultStatus: "locked", keyspaceGeneration: 0, taskSnapshots: [], scheduleSettings: { assetHoldingsIntervalMs: 1 } };
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
    const port = { start: vi.fn(), postMessage: vi.fn(), close: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null, onmessageerror: null };
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
        execution: "coordinator-worker" as const,
        lifetime: "owner-session" as const,
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
      hub.broadcast(accepted);
      hub.broadcast({ ...accepted, units: [{ ...unit, instanceId: "worker-unit:stale" }] });
      hub.broadcast({ ...accepted, authorityInstanceId: "authority:old", workerUnitRevision: 99 });

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
        execution: "coordinator-worker" as const,
        lifetime: "storage" as const,
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
      hub.broadcast(oldEvent);

      const nextEvent = {
        ...oldEvent,
        workerUnitRevision: 2,
        sessionEpoch: "next-session",
        units: [{
          ...oldUnit,
          productId: "p2pkh",
          unitId: "p2pkh.coordinator-worker",
          lifetime: "owner-session" as const,
          instanceId: "worker-unit:next",
          snapshotRevision: 2,
          serviceIds: ["p2pkh.asset-service"],
          taskIds: ["p2pkh.transactions-sync"],
          ownerPublicKeyHex: "a".repeat(64),
          sessionEpoch: "next-session",
        }],
      };
      // 运行单元事件先到时必须等待 session.state，而不能覆盖旧世代。
      hub.broadcast(nextEvent);
      expect(client.getBootstrapSnapshot().coordinatorWorkerUnits).toEqual([oldUnit]);

      hub.broadcast({
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
      hub.broadcast({ ...oldEvent, workerUnitRevision: 99, units: [{ ...oldUnit, instanceId: "worker-unit:late-old" }] });
      expect(events).toHaveLength(2);
      expect(client.getBootstrapSnapshot().coordinatorWorkerUnits).toEqual(expect.arrayContaining([
        expect.objectContaining({ instanceId: "worker-unit:next" }),
      ]));
    } finally { globalThis.SharedWorker = original; }
  });

  it("clears an unlocked snapshot on transport timeout before reconnect", async () => {
    const port = { start: vi.fn(), postMessage: vi.fn(), close: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null, onmessageerror: null };
    port.postMessage.mockImplementation((message: unknown) => { const request = message as { requestId: string }; if (request.requestId) queueMicrotask(() => port.onmessage?.({ data: { requestId: request.requestId, sessionEpoch: "e", ack: { status: "ok" }, operationResult: { vaultStatus: "unlocked", activePublicKeyHex: "a".repeat(64), keyspaceGeneration: 1, taskSnapshots: [], scheduleSettings: { assetHoldingsIntervalMs: 1 } } } } as MessageEvent)); });
    const original = globalThis.SharedWorker;
    globalThis.SharedWorker = vi.fn(() => ({ port }) as unknown as SharedWorker);
    try {
      const client = createCoordinatorClient({ requestTimeoutMs: 5, reconnectIntervalMs: 1000 });
      await client.connect();
      expect(client.getBootstrapSnapshot().vaultStatus).toBe("unlocked");
      port.onmessage = null;
      await expect(client.backgroundRunNow("missing")).resolves.toMatchObject({ status: "transport-error", retryable: true });
      expect(client.getBootstrapSnapshot().vaultStatus).toBe("booting");
    } finally { globalThis.SharedWorker = original; }
  });

  it("normalizes every public command/value facade on transport loss", async () => {
    const port = { start: vi.fn(), postMessage: vi.fn(), close: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null, onmessageerror: null };
    port.postMessage.mockImplementation((message: unknown) => {
      const request = message as { requestId: string; kind: string };
      if (request.kind === "hello" || request.kind === "subscribe") {
        queueMicrotask(() => port.onmessage?.({ data: { requestId: request.requestId, sessionEpoch: "e", ack: { status: "ok" }, operationResult: { vaultStatus: "locked", keyspaceGeneration: 0, taskSnapshots: [], scheduleSettings: { assetHoldingsIntervalMs: 1 } } } } as MessageEvent));
      }
    });
    const original = globalThis.SharedWorker;
    globalThis.SharedWorker = vi.fn(() => ({ port }) as unknown as SharedWorker);
    try {
      const client = createCoordinatorClient({ requestTimeoutMs: 5, reconnectIntervalMs: 1000 });
      await client.connect();
      await expect(client.unlock("pw")).resolves.toMatchObject({ status: "transport-error" });
      await expect(client.vaultOperation("listKeys")).resolves.toMatchObject({ status: "transport-error" });
      await expect(client.crypto({ type: "deriveP2pkhAddress", network: "main" })).resolves.toMatchObject({ ack: { status: "transport-error" } });
      expect(client.getRecoverableDiagnostics().length).toBeGreaterThan(0);
    } finally { globalThis.SharedWorker = original; }
  });

  it("rejects immediately when the SharedWorker reports a startup error", async () => {
    const port = { start: vi.fn(), postMessage: vi.fn(), close: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null, onmessageerror: null };
    const worker = { port, onerror: null as ((event: Event) => void) | null } as unknown as SharedWorker;
    const original = globalThis.SharedWorker;
    globalThis.SharedWorker = vi.fn(() => worker);
    try {
      const client = createCoordinatorClient({ requestTimeoutMs: 1_000, reconnectIntervalMs: 1_000 });
      const connecting = client.connect();
      worker.onerror?.({ message: "module failed to load" } as ErrorEvent);
      await expect(connecting).rejects.toThrow("Coordinator worker error: module failed to load");
    } finally { globalThis.SharedWorker = original; }
  });

  it("notifies the Coordinator to cancel an in-flight Channel request", async () => {
    const sent: Array<{ kind?: string; requestId?: string; targetRequestId?: string }> = [];
    const port = {
      start: vi.fn(),
      postMessage: vi.fn((message: { kind?: string; requestId?: string; targetRequestId?: string }) => {
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
      }),
      close: vi.fn(),
      onmessage: null as ((event: MessageEvent) => void) | null,
      onmessageerror: null,
    };
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
        targetRequestId: channelRequest?.requestId,
      }));
    } finally { globalThis.SharedWorker = original; }
  });

  it("在 catalog-select 响应丢失后仍能用幂等回滚恢复旧桶", async () => {
    const storage = new BridgeMemoryStorage();
    const restoreGlobals = installBridgeGlobals(storage);
    const current = bridgeCatalogEntry("bucket-old", "旧桶");
    const target = bridgeCatalogEntry("bucket-new", "新桶");
    const { client, workerPort, authorityInstanceId, leaseId } = await openTestLocalBridge(storage, current);
    try {
      storage.setItem(STORAGE_CATALOG_KEY, JSON.stringify({
        format: "keymaster.storage.catalog",
        version: 2,
        selectedBucketId: current.bucketId,
        buckets: [current, target]
      }));
      const selectRequest = {
        type: "catalog-select" as const,
        bucketId: target.bucketId,
        bucketGeneration: 2,
        authorityInstanceId,
        leaseId,
        expectedSelectedBucketId: current.bucketId,
        targetBucket: target
      } satisfies LocalStorageBridgeRequest;

      // 消费掉但故意忽略响应，模拟 CAS 已落盘而 Worker 没收到 response。
      await new Promise<void>((resolve) => {
        workerPort.onmessage = () => resolve();
        workerPort.postMessage({ requestId: "lost-select-response", request: selectRequest });
      });
      expect(readStorageCatalog(storage).selectedBucketId).toBe(target.bucketId);

      const rollback = {
        type: "catalog-select" as const,
        bucketId: current.bucketId,
        bucketGeneration: 1,
        authorityInstanceId,
        leaseId,
        expectedSelectedBucketId: target.bucketId,
        rollbackFromSelectedBucketId: target.bucketId,
        targetBucket: current
      } satisfies LocalStorageBridgeRequest;
      const response = await sendBridgeRequest(workerPort, "rollback-after-lost-select", rollback) as { ok?: boolean; response?: { type?: string; bucket?: StorageBucketCatalogEntryV2 } };

      expect(response).toMatchObject({ ok: true, response: { type: "catalog", bucket: { bucketId: current.bucketId } } });
      expect(readStorageCatalog(storage).selectedBucketId).toBe(current.bucketId);
    } finally {
      client.disconnect();
      workerPort.close();
      restoreGlobals();
    }
  });

  it("首桶 Root 尚未绑定时不让旧 unselected 事件清空临时 Local 租约", async () => {
    const storage = new BridgeMemoryStorage();
    const restoreGlobals = installBridgeGlobals(storage);
    const current = bridgeCatalogEntry("bucket-first", "首个桶");
    const { client, workerPort } = await openTestLocalBridge(storage, current);
    try {
      const internals = client as unknown as LocalBridgeClientInternals;
      internals.applyTopicEvent({
        topic: "storage.state",
        type: "storage.state.changed",
        storageRevision: 1,
        sessionEpoch: "boot",
        providerGeneration: null,
        status: "checking",
        healthStatus: "unselected",
        catalogBucket: false,
        summary: null,
        capabilities: null
      });

      expect(internals.localStorageBridgeLease).toMatchObject({
        bucketId: current.bucketId,
        bucketGeneration: 1
      });
    } finally {
      client.disconnect();
      workerPort.close();
      restoreGlobals();
    }
  });

  it("拒绝跳过世代的 Local lease 回滚，并接受精确的上一世代", async () => {
    const storage = new BridgeMemoryStorage();
    const restoreGlobals = installBridgeGlobals(storage);
    const current = bridgeCatalogEntry("bucket-lease-old", "旧桶");
    const target = bridgeCatalogEntry("bucket-lease-new", "新桶");
    const { client, workerPort, authorityInstanceId, leaseId } = await openTestLocalBridge(storage, current);
    try {
      storage.setItem(STORAGE_CATALOG_KEY, JSON.stringify({
        format: "keymaster.storage.catalog",
        version: 2,
        selectedBucketId: current.bucketId,
        buckets: [current, target]
      }));
      const select = {
        type: "catalog-select" as const,
        bucketId: target.bucketId,
        bucketGeneration: 2,
        authorityInstanceId,
        leaseId,
        expectedSelectedBucketId: current.bucketId,
        targetBucket: target
      } satisfies LocalStorageBridgeRequest;
      await sendBridgeRequest(workerPort, "lease-select", select);

      const forgedRollback = {
        ...select,
        bucketId: current.bucketId,
        bucketGeneration: 3,
        expectedSelectedBucketId: target.bucketId,
        rollbackFromSelectedBucketId: target.bucketId,
        targetBucket: current
      } as unknown as LocalStorageBridgeRequest;
      const rejected = await sendBridgeRequest(workerPort, "lease-forged-rollback", forgedRollback) as { ok?: boolean; error?: { code?: string } };
      expect(rejected).toMatchObject({ ok: false, error: { code: "storage_forbidden" } });

      const validRollback = {
        ...forgedRollback,
        bucketGeneration: 1
      } as Extract<LocalStorageBridgeRequest, { type: "catalog-select" }>;
      const accepted = await sendBridgeRequest(workerPort, "lease-valid-rollback", validRollback) as { ok?: boolean; response?: { bucket?: StorageBucketCatalogEntryV2 } };
      expect(accepted).toMatchObject({ ok: true, response: { bucket: { bucketId: current.bucketId } } });
      expect(readStorageCatalog(storage).selectedBucketId).toBe(current.bucketId);
    } finally {
      client.disconnect();
      workerPort.close();
      restoreGlobals();
    }
  });

  it("首次初始化允许空目录暂存，并以幂等 catalog-commit 发布或回滚同一桶", async () => {
    const storage = new BridgeMemoryStorage();
    const restoreGlobals = installBridgeGlobals(storage);
    const target = bridgeCatalogEntry("bucket-initial", "首桶");
    const { client, workerPort, authorityInstanceId, leaseId } = await openEmptyTestLocalBridge(storage);
    try {
      const candidate = {
        bucket: target,
        bucketGeneration: 1,
        initialSetup: true
      } as const;
      const stagedRead = await sendBridgeRequest(workerPort, "initial-staged-read", {
        type: "get",
        bucketId: target.bucketId,
        bucketGeneration: 1,
        authorityInstanceId,
        leaseId,
        candidateBucket: candidate,
        path: ".keymaster/hold/v1/head.json"
      });
      expect(stagedRead).toMatchObject({ ok: true, response: { type: "object" } });
      expect(readStorageCatalog(storage)).toEqual({ format: "keymaster.storage.catalog", version: 2, buckets: [] });

      const commit = {
        type: "catalog-commit" as const,
        bucketId: target.bucketId,
        bucketGeneration: 1,
        authorityInstanceId,
        leaseId,
        targetBucket: target
      };
      await sendBridgeRequest(workerPort, "initial-commit", commit);
      expect(readStorageCatalog(storage)).toMatchObject({ selectedBucketId: target.bucketId, buckets: [target] });
      const committedRead = await sendBridgeRequest(workerPort, "initial-committed-read", {
        type: "get",
        bucketId: target.bucketId,
        bucketGeneration: 1,
        authorityInstanceId,
        leaseId,
        candidateBucket: candidate,
        path: ".keymaster/hold/v1/head.json"
      });
      expect(committedRead).toMatchObject({ ok: true, response: { type: "object" } });
      await sendBridgeRequest(workerPort, "initial-commit-retry", commit);
      expect(readStorageCatalog(storage)).toMatchObject({ selectedBucketId: target.bucketId, buckets: [target] });

      await sendBridgeRequest(workerPort, "initial-rollback", { ...commit, rollback: true });
      expect(readStorageCatalog(storage)).toEqual({ format: "keymaster.storage.catalog", version: 2, buckets: [] });
      await sendBridgeRequest(workerPort, "initial-rollback-retry", { ...commit, rollback: true });
      expect(readStorageCatalog(storage)).toEqual({ format: "keymaster.storage.catalog", version: 2, buckets: [] });
    } finally {
      client.disconnect();
      workerPort.close();
      restoreGlobals();
    }
  });

  it("目录竞争后 cleanupOnly 只能清理输家候选，不能触碰赢家命名空间", async () => {
    const storage = new BridgeMemoryStorage();
    const restoreGlobals = installBridgeGlobals(storage);
    const winner = bridgeCatalogEntry("bucket-race-winner", "赢家");
    const loser = bridgeCatalogEntry("bucket-race-loser", "输家");
    const { client, workerPort, authorityInstanceId, leaseId } = await openEmptyTestLocalBridge(storage);
    try {
      const winnerCandidate = { bucket: winner, bucketGeneration: 1, initialSetup: true } as const;
      const loserCandidate = { bucket: loser, bucketGeneration: 1, initialSetup: true } as const;
      const base = { authorityInstanceId, leaseId };
      storage.setItem(`keymaster.bucket.${winner.bucketId}.candidate/winner`, btoa("winner"));
      storage.setItem(`keymaster.bucket.${loser.bucketId}.candidate/loser`, btoa("loser"));
      await sendBridgeRequest(workerPort, "race-winner-commit", {
        type: "catalog-commit",
        bucketId: winner.bucketId,
        bucketGeneration: 1,
        ...base,
        targetBucket: winner
      });

      const cleanupCandidate = { ...loserCandidate, cleanupOnly: true } as const;
      const listed = await sendBridgeRequest(workerPort, "race-loser-list", {
        type: "list",
        bucketId: loser.bucketId,
        bucketGeneration: 1,
        ...base,
        candidateBucket: cleanupCandidate
      }) as { ok?: boolean; response?: { type?: string; objects?: Array<{ path: string }> } };
      expect(listed).toMatchObject({ ok: true, response: { type: "list", objects: [{ path: "candidate/loser" }] } });
      await sendBridgeRequest(workerPort, "race-loser-delete", {
        type: "delete",
        bucketId: loser.bucketId,
        bucketGeneration: 1,
        ...base,
        candidateBucket: cleanupCandidate,
        path: "candidate/loser"
      });

      const winnerRead = await sendBridgeRequest(workerPort, "race-winner-read", {
        type: "get",
        bucketId: winner.bucketId,
        bucketGeneration: 1,
        ...base,
        candidateBucket: winnerCandidate,
        path: "candidate/winner"
      }) as { ok?: boolean; response?: { type?: string; object?: { bytes?: Uint8Array } } };
      expect(winnerRead.ok).toBe(true);
      expect(winnerRead.response?.object?.bytes).toEqual(new TextEncoder().encode("winner"));
      expect(readStorageCatalog(storage)).toMatchObject({ selectedBucketId: winner.bucketId });
    } finally {
      client.disconnect();
      workerPort.close();
      restoreGlobals();
    }
  });

  it("两个页面桥并发写恢复记录后，其中一个 Worker 终止也不会丢失另一条记录", async () => {
    const storage = new BridgeMemoryStorage();
    const restoreGlobals = installBridgeGlobals(storage);
    const first = await openEmptyTestLocalBridge(storage);
    const second = await openEmptyTestLocalBridge(storage);
    try {
      const recordA = bridgeRecoveryRecord("initial-setup-bridge-worker-a", 1);
      const recordB = bridgeRecoveryRecord("initial-setup-bridge-worker-b", 2);
      const [firstResponse, secondResponse] = await Promise.all([
        sendBridgeRequest(first.workerPort, "recovery-write-a", {
          type: "initial-setup-recovery-write",
          authorityInstanceId: first.authorityInstanceId,
          leaseId: first.leaseId,
          record: recordA,
        }) as Promise<{ ok?: boolean; response?: { records?: InitialSetupRecoveryRecordV1[] } }>,
        sendBridgeRequest(second.workerPort, "recovery-write-b", {
          type: "initial-setup-recovery-write",
          authorityInstanceId: second.authorityInstanceId,
          leaseId: second.leaseId,
          record: recordB,
        }) as Promise<{ ok?: boolean; response?: { records?: InitialSetupRecoveryRecordV1[] } }>,
      ]);
      expect(firstResponse).toMatchObject({ ok: true });
      expect(secondResponse).toMatchObject({ ok: true });

      first.client.disconnect();
      first.workerPort.close();
      const afterWorkerTermination = await sendBridgeRequest(second.workerPort, "recovery-list-after-worker-termination", {
        type: "initial-setup-recovery-list",
        authorityInstanceId: second.authorityInstanceId,
        leaseId: second.leaseId,
      }) as { ok?: boolean; response?: { records?: InitialSetupRecoveryRecordV1[] } };
      expect(afterWorkerTermination.response?.records?.map((record) => record.transactionId)).toEqual([recordA.transactionId, recordB.transactionId]);
    } finally {
      second.client.disconnect();
      second.workerPort.close();
      restoreGlobals();
    }
  });

  it("没有 Web Locks 时恢复记录写入 fail-closed", async () => {
    const storage = new BridgeMemoryStorage();
    const restoreGlobals = installBridgeGlobals(storage);
    const { client, workerPort, authorityInstanceId, leaseId } = await openEmptyTestLocalBridge(storage);
    try {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
      const response = await sendBridgeRequest(workerPort, "recovery-write-without-lock", {
        type: "initial-setup-recovery-write",
        authorityInstanceId,
        leaseId,
        record: bridgeRecoveryRecord("initial-setup-bridge-no-lock", 1),
      }) as { ok?: boolean; error?: { code?: string } };
      expect(response).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
      expect(storage.getItem("keymaster.storage.initial-setup.recovery.v1")).toBeNull();
    } finally {
      client.disconnect();
      workerPort.close();
      restoreGlobals();
    }
  });

  it("恢复账本 JSON 损坏时读取和写入都 fail-closed，不覆盖原始内容", async () => {
    const storage = new BridgeMemoryStorage();
    const restoreGlobals = installBridgeGlobals(storage);
    const { client, workerPort, authorityInstanceId, leaseId } = await openEmptyTestLocalBridge(storage);
    const ledgerKey = "keymaster.storage.initial-setup.recovery.v1";
    const damaged = "{not-json";
    storage.setItem(ledgerKey, damaged);
    try {
      const listed = await sendBridgeRequest(workerPort, "recovery-list-invalid-json", {
        type: "initial-setup-recovery-list",
        authorityInstanceId,
        leaseId,
      }) as { ok?: boolean; error?: { code?: string } };
      expect(listed).toMatchObject({ ok: false, error: { code: "storage_provider_error" } });

      const written = await sendBridgeRequest(workerPort, "recovery-write-invalid-json", {
        type: "initial-setup-recovery-write",
        authorityInstanceId,
        leaseId,
        record: bridgeRecoveryRecord("initial-setup-bridge-after-invalid-json", 1),
      }) as { ok?: boolean; error?: { code?: string } };
      expect(written).toMatchObject({ ok: false, error: { code: "storage_provider_error" } });
      expect(storage.getItem(ledgerKey)).toBe(damaged);
    } finally {
      client.disconnect();
      workerPort.close();
      restoreGlobals();
    }
  });

  it("恢复账本混入非法记录或重复 transactionId 时拒绝读取和覆盖", async () => {
    const storage = new BridgeMemoryStorage();
    const restoreGlobals = installBridgeGlobals(storage);
    const { client, workerPort, authorityInstanceId, leaseId } = await openEmptyTestLocalBridge(storage);
    const ledgerKey = "keymaster.storage.initial-setup.recovery.v1";
    const valid = bridgeRecoveryRecord("initial-setup-bridge-valid-record", 1);
    try {
      const mixed = JSON.stringify([valid, { ...valid, phase: "not-a-phase" }]);
      storage.setItem(ledgerKey, mixed);
      const mixedResponse = await sendBridgeRequest(workerPort, "recovery-list-mixed-invalid", {
        type: "initial-setup-recovery-list",
        authorityInstanceId,
        leaseId,
      }) as { ok?: boolean; error?: { code?: string } };
      expect(mixedResponse).toMatchObject({ ok: false, error: { code: "storage_provider_error" } });

      const duplicate = JSON.stringify([valid, valid]);
      storage.setItem(ledgerKey, duplicate);
      const duplicateResponse = await sendBridgeRequest(workerPort, "recovery-list-duplicate", {
        type: "initial-setup-recovery-list",
        authorityInstanceId,
        leaseId,
      }) as { ok?: boolean; error?: { code?: string } };
      expect(duplicateResponse).toMatchObject({ ok: false, error: { code: "storage_provider_error" } });

      const written = await sendBridgeRequest(workerPort, "recovery-write-duplicate-ledger", {
        type: "initial-setup-recovery-write",
        authorityInstanceId,
        leaseId,
        record: bridgeRecoveryRecord("initial-setup-bridge-after-duplicate", 2),
      }) as { ok?: boolean; error?: { code?: string } };
      expect(written).toMatchObject({ ok: false, error: { code: "storage_provider_error" } });
      expect(storage.getItem(ledgerKey)).toBe(duplicate);
    } finally {
      client.disconnect();
      workerPort.close();
      restoreGlobals();
    }
  });

  it("恢复账本满载且没有已确认终态时拒绝新增并保留原账本", async () => {
    const storage = new BridgeMemoryStorage();
    const restoreGlobals = installBridgeGlobals(storage);
    const { client, workerPort, authorityInstanceId, leaseId } = await openEmptyTestLocalBridge(storage);
    const ledgerKey = "keymaster.storage.initial-setup.recovery.v1";
    const records = Array.from({ length: 32 }, (_, index) => bridgeRecoveryRecord(`capacity-unconfirmed-${index}`, index));
    const original = JSON.stringify(records);
    storage.setItem(ledgerKey, original);
    try {
      const response = await sendBridgeRequest(workerPort, "recovery-write-at-capacity", {
        type: "initial-setup-recovery-write",
        authorityInstanceId,
        leaseId,
        record: bridgeRecoveryRecord("capacity-unconfirmed-new", 33),
      }) as { ok?: boolean; error?: { code?: string } };
      expect(response).toMatchObject({ ok: false, error: { code: "storage_limit_exceeded" } });
      expect(storage.getItem(ledgerKey)).toBe(original);
    } finally {
      client.disconnect();
      workerPort.close();
      restoreGlobals();
    }
  });

  it("恢复账本满载时只淘汰已确认终态，不淘汰未确认记录", async () => {
    const storage = new BridgeMemoryStorage();
    const restoreGlobals = installBridgeGlobals(storage);
    const { client, workerPort, authorityInstanceId, leaseId } = await openEmptyTestLocalBridge(storage);
    const ledgerKey = "keymaster.storage.initial-setup.recovery.v1";
    const terminal = { ...bridgeRecoveryRecord("capacity-confirmed-oldest", 0), cleanup: "confirmed" as const };
    const unconfirmed = Array.from({ length: 31 }, (_, index) => bridgeRecoveryRecord(`capacity-unconfirmed-${index}`, index + 1));
    storage.setItem(ledgerKey, JSON.stringify([terminal, ...unconfirmed]));
    try {
      const response = await sendBridgeRequest(workerPort, "recovery-write-with-terminal-eviction", {
        type: "initial-setup-recovery-write",
        authorityInstanceId,
        leaseId,
        record: bridgeRecoveryRecord("capacity-unconfirmed-new", 32),
      }) as { ok?: boolean; response?: { records?: InitialSetupRecoveryRecordV1[] } };
      expect(response).toMatchObject({ ok: true, response: { type: "initial-setup-recovery" } });
      const persisted = response.response?.records ?? [];
      expect(persisted).toHaveLength(32);
      expect(persisted.map((record) => record.transactionId)).not.toContain(terminal.transactionId);
      expect(persisted.map((record) => record.transactionId)).toEqual(expect.arrayContaining([
        ...unconfirmed.map((record) => record.transactionId),
        "capacity-unconfirmed-new",
      ]));
    } finally {
      client.disconnect();
      workerPort.close();
      restoreGlobals();
    }
  });
});
