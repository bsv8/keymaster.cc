import { describe, expect, it, vi } from "vitest";
import type { SessionCoordinatorClient } from "@keymaster/contracts";
import { vaultPlugin, VAULT_CAPABILITY } from "@keymaster/plugin-vault";
import { createPluginHost } from "@keymaster/runtime";
import { createCoordinatorClient } from "./keymasterSessionCoordinatorClient.js";

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

      const host = createPluginHost({ execution: "window", disableConfigPersistence: true, coordinatorForPlugin: () => client });
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
});
