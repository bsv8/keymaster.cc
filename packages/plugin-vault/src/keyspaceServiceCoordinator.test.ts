import { describe, expect, it, vi } from "vitest";
import { createKeyspaceServiceCoordinator } from "./keyspaceServiceCoordinator.js";
import { SessionStateMirror } from "./sessionStateMirror.js";
import type { SessionStateEvent } from "@keymaster/contracts";
import { createMessageBus } from "@keymaster/runtime";

describe("createKeyspaceServiceCoordinator", () => {
  it("initializes from the Coordinator bootstrap snapshot", () => {
    const coordinatorClient = {
      getBootstrapSnapshot: () => ({
        sessionEpoch: "test",
        vaultStatus: "unlocked" as const,
        activePublicKeyHex: "02".padEnd(66, "a"),
        selectedPublicKeyHex: "02".padEnd(66, "a"),
        keyspaceGeneration: 7,
        taskSnapshots: [],
        scheduleSettings: { assetHoldingsIntervalMs: 900_000 }
      }),
      subscribeTopic: () => () => undefined,
      backgroundCancelByKey: async () => ({ status: "accepted" as const }),
      vaultOperation: async () => ({ status: "ok" as const, value: undefined, sessionEpoch: "test" })
    };

    const keyspace = createKeyspaceServiceCoordinator(coordinatorClient, new SessionStateMirror(coordinatorClient), createMessageBus());

    expect(keyspace.active()).toEqual({ activePublicKeyHex: "02".padEnd(66, "a") });
    expect(keyspace.requireActiveKey().publicKeyHex).toBe("02".padEnd(66, "a"));
    expect(keyspace.selected()).toBe("02".padEnd(66, "a"));
  });

  it("keeps selected while locked and active is empty", () => {
    const key = "02".padEnd(66, "a");
    const listeners: Array<(event: SessionStateEvent) => void> = [];
    const client = { getBootstrapSnapshot: () => ({ sessionEpoch: "e", vaultStatus: "locked" as const, activePublicKeyHex: undefined, selectedPublicKeyHex: key, keyspaceGeneration: 1, taskSnapshots: [], scheduleSettings: { assetHoldingsIntervalMs: 1 } }), subscribeTopic: (_topic: string, cb: (event: SessionStateEvent) => void) => { listeners.push(cb); return () => undefined; }, backgroundCancelByKey: async () => ({ status: "accepted" as const }), vaultOperation: async () => ({ status: "ok" as const, value: undefined, sessionEpoch: "e" }) };
    const keyspace = createKeyspaceServiceCoordinator(client, new SessionStateMirror(client), createMessageBus());
    expect(keyspace.active()).toEqual({ activePublicKeyHex: undefined });
    expect(keyspace.selected()).toBe(key);
    const nextKey = "03".padEnd(66, "b");
    listeners[0]?.({ topic: "session.state", type: "session.state.changed", cause: "lock", sessionEpoch: "e2", vaultStatus: "locked", activePublicKeyHex: null, selectedPublicKeyHex: nextKey, keyspaceGeneration: 2, sessionRevision: 1 });
    expect(keyspace.selected()).toBe(nextKey);
  });

  it("runs label confirmation, cancellation, material deletion, event, and finalization in order", async () => {
    const key = "02".padEnd(66, "a");
    const operations: string[] = [];
    const events: string[] = [];
    let listCalls = 0;
    const bus = createMessageBus();
    bus.subscribe("key.deleting", () => events.push("key.deleting"));
    bus.subscribe("key.deleted", () => events.push("key.deleted"));
    const client = {
      getBootstrapSnapshot: () => ({ sessionEpoch: "e", vaultStatus: "locked" as const, activePublicKeyHex: undefined, selectedPublicKeyHex: key, keyspaceGeneration: 1, taskSnapshots: [], scheduleSettings: { assetHoldingsIntervalMs: 1 } }),
      subscribeTopic: () => () => undefined,
      backgroundCancelByKey: async () => { operations.push("cancel"); return { status: "accepted" as const }; },
      vaultOperation: async (operation: string) => {
        operations.push(operation);
        if (operation === "listKeys") {
          listCalls += 1;
          return { status: "ok" as const, value: listCalls === 1 ? [{ publicKeyHex: key, label: "key", capabilities: [], createdAt: "now" }] : [], sessionEpoch: "e" };
        }
        return { status: "ok" as const, value: true, sessionEpoch: "e" };
      }
    };
    const keyspace = createKeyspaceServiceCoordinator(client, new SessionStateMirror(client), bus);
    await keyspace.deleteKey({ publicKeyHex: key, confirmationLabel: "key" });
    expect(operations).toEqual(["listKeys", "cancel", "deleteKeyMaterial", "listKeys", "finalizeEmptyVaultAfterLastKeyDeletion"]);
    expect(events).toEqual(["key.deleting", "key.deleted"]);
  });

  it("does not clean up on a mismatched label", async () => {
    const key = "02".padEnd(66, "a");
    const operations: string[] = [];
    const client = {
      getBootstrapSnapshot: () => ({ sessionEpoch: "e", vaultStatus: "locked" as const, activePublicKeyHex: undefined, selectedPublicKeyHex: key, keyspaceGeneration: 1, taskSnapshots: [], scheduleSettings: { assetHoldingsIntervalMs: 1 } }),
      subscribeTopic: () => () => undefined,
      backgroundCancelByKey: async () => { operations.push("cancel"); return { status: "accepted" as const }; },
      vaultOperation: async (operation: string) => {
        operations.push(operation);
        return { status: "ok" as const, value: [{ publicKeyHex: key, label: "key", capabilities: [], createdAt: "now" }], sessionEpoch: "e" };
      }
    };
    const keyspace = createKeyspaceServiceCoordinator(client, new SessionStateMirror(client), createMessageBus());
    await expect(keyspace.deleteKey({ publicKeyHex: key, confirmationLabel: "wrong" })).rejects.toThrow("Key label mismatch");
    expect(operations).toEqual(["listKeys"]);
  });

  it("retains key material when namespace deletion is blocked", async () => {
    const key = "02".padEnd(66, "a");
    const operations: string[] = [];
    const client = {
      getBootstrapSnapshot: () => ({ sessionEpoch: "e", vaultStatus: "locked" as const, activePublicKeyHex: undefined, selectedPublicKeyHex: key, keyspaceGeneration: 1, taskSnapshots: [], scheduleSettings: { assetHoldingsIntervalMs: 1 } }),
      subscribeTopic: () => () => undefined,
      backgroundCancelByKey: async () => { operations.push("cancel"); return { status: "accepted" as const }; },
      vaultOperation: async (operation: string) => {
        operations.push(operation);
        if (operation === "deleteKeyMaterial") return { status: "ok" as const, value: true, sessionEpoch: "e" };
        return { status: "ok" as const, value: [ { publicKeyHex: key, label: "key", capabilities: [], createdAt: "now" } ], sessionEpoch: "e" };
      }
    };
    const keyspace = createKeyspaceServiceCoordinator(client, new SessionStateMirror(client), createMessageBus());
    keyspace.registerPluginStorage({ pluginId: "plugin", storageId: "store" });
    const blockedRequest = {} as IDBOpenDBRequest;
    const deleteDatabase = vi.spyOn(indexedDB, "deleteDatabase").mockImplementation(() => {
      queueMicrotask(() => blockedRequest.onblocked?.(new Event("blocked") as IDBVersionChangeEvent));
      return blockedRequest;
    });
    try {
      await expect(keyspace.deleteKey({ publicKeyHex: key, confirmationLabel: "key" })).rejects.toThrow("Namespace delete blocked");
      expect(operations).toEqual(["listKeys", "cancel"]);
    } finally {
      deleteDatabase.mockRestore();
    }
  });

  it("does not start cleanup when cancellation is blocked", async () => {
    const key = "02".padEnd(66, "a");
    const operations: string[] = [];
    const bus = createMessageBus();
    const client = {
      getBootstrapSnapshot: () => ({ sessionEpoch: "e", vaultStatus: "locked" as const, activePublicKeyHex: undefined, selectedPublicKeyHex: key, keyspaceGeneration: 1, taskSnapshots: [], scheduleSettings: { assetHoldingsIntervalMs: 1 } }),
      subscribeTopic: () => () => undefined,
      backgroundCancelByKey: async () => ({ status: "blocked" as const, reason: { key: "background.blocked", fallback: "busy" } }),
      vaultOperation: async (operation: string) => { operations.push(operation); return { status: "ok" as const, value: operation === "listKeys" ? [{ publicKeyHex: key, label: "key", capabilities: [], createdAt: "now" }] : true, sessionEpoch: "e" }; }
    };
    const keyspace = createKeyspaceServiceCoordinator(client, new SessionStateMirror(client), bus);
    await expect(keyspace.deleteKey({ publicKeyHex: key, confirmationLabel: "key" })).rejects.toThrow("Background cancellation failed");
    expect(operations).toEqual(["listKeys"]);
  });
});
