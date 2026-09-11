import { describe, expect, it } from "vitest";
import { createKeyspaceServiceCoordinator } from "./keyspaceServiceCoordinator.js";
import { SessionStateMirror } from "./sessionStateMirror.js";
import type { CoordinatorValueResult, CoordinatorVaultOperation, CoordinatorVaultOperationResultFor, SessionStateEvent } from "@keymaster/contracts";
import { createMessageBus } from "webloom-framework";

type VaultOperationResponse<O extends CoordinatorVaultOperation> = CoordinatorValueResult<CoordinatorVaultOperationResultFor<O>>;

describe("createKeyspaceServiceCoordinator", () => {
  it("initializes from the Coordinator bootstrap snapshot", () => {
    const coordinatorClient = {
      getBootstrapSnapshot: () => ({
        authorityInstanceId: "authority:test",
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
      vaultOperation: async <O extends CoordinatorVaultOperation>(_operation: O): Promise<VaultOperationResponse<O>> => ({ status: "ok", value: true, sessionEpoch: "test" } as VaultOperationResponse<O>)
    };

    const keyspace = createKeyspaceServiceCoordinator(coordinatorClient, new SessionStateMirror(coordinatorClient), createMessageBus());

    expect(keyspace.active()).toEqual({ activePublicKeyHex: "02".padEnd(66, "a"), generation: 7 });
    expect(keyspace.requireActiveKey().publicKeyHex).toBe("02".padEnd(66, "a"));
    expect(keyspace.selected()).toBe("02".padEnd(66, "a"));
  });

  it("keeps selected while locked and active is empty", () => {
    const key = "02".padEnd(66, "a");
    const listeners: Array<(event: SessionStateEvent) => void> = [];
    const client = { getBootstrapSnapshot: () => ({ authorityInstanceId: "authority:test", sessionEpoch: "e", vaultStatus: "locked" as const, activePublicKeyHex: undefined, selectedPublicKeyHex: key, keyspaceGeneration: 1, taskSnapshots: [], scheduleSettings: { assetHoldingsIntervalMs: 1 } }), subscribeTopic: (_topic: string, cb: (event: SessionStateEvent) => void) => { listeners.push(cb); return () => undefined; }, backgroundCancelByKey: async () => ({ status: "accepted" as const }), vaultOperation: async <O extends CoordinatorVaultOperation>(_operation: O): Promise<VaultOperationResponse<O>> => ({ status: "ok", value: true, sessionEpoch: "e" } as VaultOperationResponse<O>) };
    const keyspace = createKeyspaceServiceCoordinator(client, new SessionStateMirror(client), createMessageBus());
    expect(keyspace.active()).toEqual({ activePublicKeyHex: undefined, generation: 1 });
    expect(keyspace.selected()).toBe(key);
    const nextKey = "03".padEnd(66, "b");
    listeners[0]?.({ topic: "session.state", type: "session.state.changed", cause: "lock", sessionEpoch: "e2", vaultStatus: "locked", activePublicKeyHex: null, selectedPublicKeyHex: nextKey, keyspaceGeneration: 2, sessionRevision: 1 });
    expect(keyspace.selected()).toBe(nextKey);
  });

  it("runs label confirmation, cancellation, and the coordinator delete transaction in order", async () => {
    const key = "02".padEnd(66, "a");
    const operations: unknown[] = [];
    const events: string[] = [];
    const bus = createMessageBus();
    bus.subscribe("key.deleting", () => events.push("key.deleting"));
    bus.subscribe("key.deleted", () => events.push("key.deleted"));
    const client = {
      getBootstrapSnapshot: () => ({ authorityInstanceId: "authority:test", sessionEpoch: "e", vaultStatus: "locked" as const, activePublicKeyHex: undefined, selectedPublicKeyHex: key, keyspaceGeneration: 1, taskSnapshots: [], scheduleSettings: { assetHoldingsIntervalMs: 1 } }),
      subscribeTopic: () => () => undefined,
      backgroundCancelByKey: async () => { operations.push("cancel"); return { status: "accepted" as const }; },
      vaultOperation: async <O extends CoordinatorVaultOperation>(operation: O): Promise<VaultOperationResponse<O>> => {
        operations.push(operation);
        if (operation.type === "listKeys") {
          return { status: "ok", value: [{ publicKeyHex: key, label: "key", capabilities: [], createdAt: "now" }], sessionEpoch: "e" } as unknown as VaultOperationResponse<O>;
        }
        return { status: "ok", value: true, sessionEpoch: "e" } as VaultOperationResponse<O>;
      }
    };
    const keyspace = createKeyspaceServiceCoordinator(client, new SessionStateMirror(client), bus);
    await keyspace.deleteKey({ publicKeyHex: key, confirmationLabel: "key" });
    expect(operations).toEqual([
      { type: "listKeys" },
      "cancel",
      { type: "deleteKey", publicKeyHex: key, confirmationLabel: "key" }
    ]);
    expect(events).toEqual(["key.deleting", "key.deleted"]);
  });

  it("does not clean up on a mismatched label", async () => {
    const key = "02".padEnd(66, "a");
    const operations: unknown[] = [];
    const client = {
      getBootstrapSnapshot: () => ({ authorityInstanceId: "authority:test", sessionEpoch: "e", vaultStatus: "locked" as const, activePublicKeyHex: undefined, selectedPublicKeyHex: key, keyspaceGeneration: 1, taskSnapshots: [], scheduleSettings: { assetHoldingsIntervalMs: 1 } }),
      subscribeTopic: () => () => undefined,
      backgroundCancelByKey: async () => { operations.push("cancel"); return { status: "accepted" as const }; },
      vaultOperation: async <O extends CoordinatorVaultOperation>(operation: O): Promise<VaultOperationResponse<O>> => {
        operations.push(operation);
        return { status: "ok", value: [{ publicKeyHex: key, label: "key", capabilities: [], createdAt: "now" }], sessionEpoch: "e" } as unknown as VaultOperationResponse<O>;
      }
    };
    const keyspace = createKeyspaceServiceCoordinator(client, new SessionStateMirror(client), createMessageBus());
    await expect(keyspace.deleteKey({ publicKeyHex: key, confirmationLabel: "wrong" })).rejects.toThrow("Key label mismatch");
    expect(operations).toEqual([{ type: "listKeys" }]);
  });

  it("waits for the coordinator delete transaction before publishing deletion", async () => {
    const key = "02".padEnd(66, "a");
    const operations: unknown[] = [];
    let releaseDelete!: () => void;
    const deleteTransaction = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const client = {
      getBootstrapSnapshot: () => ({ authorityInstanceId: "authority:test", sessionEpoch: "e", vaultStatus: "locked" as const, activePublicKeyHex: undefined, selectedPublicKeyHex: key, keyspaceGeneration: 1, taskSnapshots: [], scheduleSettings: { assetHoldingsIntervalMs: 1 } }),
      subscribeTopic: () => () => undefined,
      backgroundCancelByKey: async () => { operations.push("cancel"); return { status: "accepted" as const }; },
      vaultOperation: async <O extends CoordinatorVaultOperation>(operation: O): Promise<VaultOperationResponse<O>> => {
        operations.push(operation);
        if (operation.type === "listKeys") return { status: "ok", value: [ { publicKeyHex: key, label: "key", capabilities: [], createdAt: "now" } ], sessionEpoch: "e" } as unknown as VaultOperationResponse<O>;
        if (operation.type === "deleteKey") {
          await deleteTransaction;
        }
        return { status: "ok", value: true, sessionEpoch: "e" } as VaultOperationResponse<O>;
      }
    };
    const keyspace = createKeyspaceServiceCoordinator(client, new SessionStateMirror(client), createMessageBus());
    const deleting = keyspace.deleteKey({ publicKeyHex: key, confirmationLabel: "key" });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(operations).toEqual([{ type: "listKeys" }, "cancel"]);
    // Coordinator 删除事务未完成前，页面不能宣告 Key 已删除。
    let settled = false;
    void deleting.then(() => { settled = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    releaseDelete();
    await deleting;
    expect(operations).toEqual([
      { type: "listKeys" },
      "cancel",
      { type: "deleteKey", publicKeyHex: key, confirmationLabel: "key" }
    ]);
  });

  it("does not start cleanup when cancellation is blocked", async () => {
    const key = "02".padEnd(66, "a");
    const operations: unknown[] = [];
    const bus = createMessageBus();
    const client = {
      getBootstrapSnapshot: () => ({ authorityInstanceId: "authority:test", sessionEpoch: "e", vaultStatus: "locked" as const, activePublicKeyHex: undefined, selectedPublicKeyHex: key, keyspaceGeneration: 1, taskSnapshots: [], scheduleSettings: { assetHoldingsIntervalMs: 1 } }),
      subscribeTopic: () => () => undefined,
      backgroundCancelByKey: async () => ({ status: "blocked" as const, reason: { key: "background.blocked", fallback: "busy" } }),
      vaultOperation: async <O extends CoordinatorVaultOperation>(operation: O): Promise<VaultOperationResponse<O>> => { operations.push(operation); return { status: "ok", value: operation.type === "listKeys" ? [{ publicKeyHex: key, label: "key", capabilities: [], createdAt: "now" }] : true, sessionEpoch: "e" } as VaultOperationResponse<O>; }
    };
    const keyspace = createKeyspaceServiceCoordinator(client, new SessionStateMirror(client), bus);
    await expect(keyspace.deleteKey({ publicKeyHex: key, confirmationLabel: "key" })).rejects.toThrow("Background cancellation failed");
    expect(operations).toEqual([{ type: "listKeys" }]);
  });
});
