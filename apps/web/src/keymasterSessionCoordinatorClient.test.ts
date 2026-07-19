import { describe, expect, it, vi } from "vitest";
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
  it("fails closed when SharedWorker is unavailable", async () => {
    const original = globalThis.SharedWorker;
    // @ts-expect-error test shim
    globalThis.SharedWorker = undefined;
    try { await expect(createCoordinatorClient({ reconnectIntervalMs: 1 }).connect()).rejects.toThrow("SharedWorker"); }
    finally { globalThis.SharedWorker = original; }
  });

  it("uses the module URL constructor", async () => {
    const port = { start: vi.fn(), postMessage: vi.fn(), close: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null, onmessageerror: null };
    port.postMessage.mockImplementation((message: unknown) => { const request = message as { requestId: string }; queueMicrotask(() => port.onmessage?.({ data: { requestId: request.requestId, sessionEpoch: "e", ack: { status: "ok" }, operationResult: { vaultStatus: "locked", keyspaceGeneration: 0, taskSnapshots: [], scheduleSettings: { assetHoldingsIntervalMs: 1 } } } } as MessageEvent)); });
    const worker = { port } as unknown as SharedWorker;
    const Constructor = vi.fn(() => worker);
    const original = globalThis.SharedWorker;
    globalThis.SharedWorker = Constructor;
    try { const client = createCoordinatorClient(); await client.connect(); expect(Constructor).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ type: "module" })); }
    finally { globalThis.SharedWorker = original; }
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
      expect(a.getState().vaultStatus).toBe("locked");
      expect(b.getState().sessionEpoch).toBe("shared-epoch");
      const observed: string[] = [];
      b.onStateChange((state) => observed.push(state.vaultStatus));
      hub.broadcast({ requestId: "legacy-vault-event", type: "vault.status-changed", sessionEpoch: "unlocked-epoch", status: "unlocked", activePublicKeyHex: "a".repeat(64) });
      expect(b.getState().vaultStatus).toBe("unlocked");
      expect(observed).toContain("unlocked");
      a.disconnect();
      expect(b.getIsConnected()).toBe(true);
    } finally {
      globalThis.SharedWorker = original;
    }
  });

  it("clears an unlocked snapshot on transport timeout before reconnect", async () => {
    const port = { start: vi.fn(), postMessage: vi.fn(), close: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null, onmessageerror: null };
    port.postMessage.mockImplementation((message: unknown) => { const request = message as { requestId: string }; if (request.requestId) queueMicrotask(() => port.onmessage?.({ data: { requestId: request.requestId, sessionEpoch: "e", ack: { status: "ok" }, operationResult: { vaultStatus: "unlocked", activePublicKeyHex: "a".repeat(64), keyspaceGeneration: 1, taskSnapshots: [], scheduleSettings: { assetHoldingsIntervalMs: 1 } } } } as MessageEvent)); });
    const original = globalThis.SharedWorker;
    globalThis.SharedWorker = vi.fn(() => ({ port }) as unknown as SharedWorker);
    try {
      const client = createCoordinatorClient({ requestTimeoutMs: 5, reconnectIntervalMs: 1000 });
      await client.connect();
      expect(client.getState().vaultStatus).toBe("unlocked");
      port.onmessage = null;
      await expect(client.backgroundRunNow("missing")).rejects.toThrow();
      expect(client.getState().vaultStatus).toBe("booting");
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
