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
    const response = { requestId: message.requestId, sessionEpoch: "shared-epoch", ack: { status: "ok" }, operationResult: { sessionEpoch: "shared-epoch", vaultStatus: "locked", keyspaceGeneration: 0, taskSnapshots: [], scheduleSettings: { assetHoldingsIntervalMs: 900_000 } } };
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

      const host = createPluginHost({ disableConfigPersistence: true, coordinatorForPlugin: () => client });
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
});
