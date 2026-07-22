import { describe, expect, it, vi } from "vitest";
import { createBroadcastConnectionLifecycle } from "./broadcastConnectionLifecycle.js";

describe("Broadcast connection lifecycle", () => {
  it("reconciles only for Vault/Keyspace identity transitions", async () => {
    const vaultHandlers: ((snapshot: any) => void)[] = [];
    const keyspaceHandlers: (() => void)[] = [];
    const coreHandlers: (() => void)[] = [];
    const identity = { sessionEpoch: "epoch-1", activePublicKeyHex: "a".repeat(64), keyspaceGeneration: 1 };
    let keyspaceGeneration = identity.keyspaceGeneration;
    let state: "idle" | "bound" = "idle";
    const reconcileOwnerConnection = vi.fn(async () => { state = "bound"; return { kind: "connected" as const }; });
    const core = {
      inspect: () => ({ state, nextReconnectAtMs: null }),
      reconcileOwnerConnection,
      markStructurallyOffline: vi.fn(),
      onConnectionStateChanged: (handler: () => void) => { coreHandlers.push(handler); return () => undefined; },
      disconnect: vi.fn(async () => undefined)
    };
    const vault = {
      getLifecycleSnapshot: () => ({ status: "unlocked", ...identity }),
      onLifecycleChange: (handler: (snapshot: any) => void) => { vaultHandlers.push(handler); return () => undefined; }
    };
    const keyspace = {
      active: () => ({ activePublicKeyHex: identity.activePublicKeyHex, generation: keyspaceGeneration }),
      onActiveKeyChanged: (handler: () => void) => { keyspaceHandlers.push(handler); return () => undefined; }
    };

    const lifecycle = createBroadcastConnectionLifecycle({ core: core as any, vault: vault as any, keyspace: keyspace as any });
    await vi.waitFor(() => expect(reconcileOwnerConnection).toHaveBeenCalledTimes(1));

    vaultHandlers[0]!({ status: "unlocked", ...identity });
    await Promise.resolve();
    expect(reconcileOwnerConnection).toHaveBeenCalledTimes(1);
    expect(coreHandlers).toHaveLength(1);

    keyspaceGeneration = 2;
    keyspaceHandlers[0]!();
    await vi.waitFor(() => expect(reconcileOwnerConnection).toHaveBeenCalledTimes(2));
    lifecycle.dispose();
  });

  it("coalesces Vault and Keyspace callbacks for the same in-flight session identity", async () => {
    const vaultHandlers: ((snapshot: any) => void)[] = [];
    const keyspaceHandlers: (() => void)[] = [];
    let identity = { sessionEpoch: "epoch-1", activePublicKeyHex: "a".repeat(64), keyspaceGeneration: 1 };
    let state: "idle" | "bound" = "idle";
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const reconcileOwnerConnection = vi.fn(async () => {
      if (reconcileOwnerConnection.mock.calls.length === 1) {
        state = "bound";
        return { kind: "connected" as const };
      }
      await pending;
      state = "bound";
      return { kind: "connected" as const };
    });
    const core = {
      inspect: () => ({ state, nextReconnectAtMs: null }),
      reconcileOwnerConnection,
      markStructurallyOffline: vi.fn(),
      onConnectionStateChanged: () => () => undefined,
      disconnect: vi.fn(async () => undefined)
    };
    const vault = {
      getLifecycleSnapshot: () => ({ status: "unlocked" as const, ...identity }),
      onLifecycleChange: (handler: (snapshot: any) => void) => { vaultHandlers.push(handler); return () => undefined; }
    };
    const keyspace = {
      active: () => ({ activePublicKeyHex: identity.activePublicKeyHex, generation: identity.keyspaceGeneration }),
      onActiveKeyChanged: (handler: () => void) => { keyspaceHandlers.push(handler); return () => undefined; }
    };

    const lifecycle = createBroadcastConnectionLifecycle({ core: core as any, vault: vault as any, keyspace: keyspace as any });
    await vi.waitFor(() => expect(reconcileOwnerConnection).toHaveBeenCalledTimes(1));
    identity = { sessionEpoch: "epoch-2", activePublicKeyHex: "b".repeat(64), keyspaceGeneration: 2 };
    vaultHandlers[0]!({ status: "unlocked", ...identity });
    keyspaceHandlers[0]!();
    await Promise.resolve();

    expect(reconcileOwnerConnection).toHaveBeenCalledTimes(2);
    release();
    await vi.waitFor(() => expect(core.inspect().state).toBe("bound"));
    lifecycle.dispose();
  });

});
