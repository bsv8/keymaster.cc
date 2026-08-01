import { describe, expect, it, vi } from "vitest";
import type { CoordinatorCryptoOperation, CoordinatorCryptoResult, KeyRef, SessionCoordinatorClient } from "@keymaster/contracts";
import { createVaultServiceCoordinator, type CoordinatorClientLike } from "./vaultServiceCoordinator.js";
import { createKeyspaceServiceCoordinator } from "./keyspaceServiceCoordinator.js";
import { SessionStateMirror } from "./sessionStateMirror.js";

const PUBLIC_KEY = "02".padEnd(66, "a");
const KEY: KeyRef = { publicKeyHex: PUBLIC_KEY, label: "primary", address: "addr-1", capabilities: ["p2pkh"], createdAt: "now" } as KeyRef;

function makeClient(): CoordinatorClientLike & Pick<SessionCoordinatorClient, "getBootstrapSnapshot" | "subscribeTopic" | "backgroundCancelByKey"> & { publish(topic: string, event: unknown): void } {
  const state = {
    sessionEpoch: "test-epoch",
    vaultStatus: "unlocked" as const,
    activePublicKeyHex: PUBLIC_KEY,
    keyspaceGeneration: 1,
    taskSnapshots: [],
    scheduleSettings: { assetHoldingsIntervalMs: 900_000 }
  };
  const topicHandlers = new Map<string, Set<(value: any) => void>>();
  const vaultOperation = vi.fn(async (operation: string, input?: unknown) => {
    const value = operation === "listKeys" ? [KEY]
      : operation === "getKey" ? ((input as { publicKeyHex: string }).publicKeyHex === PUBLIC_KEY ? KEY : undefined)
      : operation === "verifyPassword" ? true
      : operation === "exportKeyBackup" ? "backup"
      : operation === "exportCurrentKeyBackup" ? "current-backup"
      : operation === "listCurrentKeyPasskeys" ? []
      : operation === "listPasskeysForKey" ? []
      : (() => { throw new Error(`unexpected operation ${operation}`); })();
    return { status: "ok" as const, value, sessionEpoch: "test-epoch" };
  });
  const crypto = vi.fn(async (operation: CoordinatorCryptoOperation) => {
    if (operation.type === "sealSendInput") return { ack: { status: "ok" as const }, result: { type: "sealSendInput", envelope: new Uint8Array([1, 2]), signature: new Uint8Array([3]) } satisfies CoordinatorCryptoResult };
    if (operation.type === "openSealed") return { ack: { status: "ok" as const }, result: { type: "openSealed", plaintext: new TextEncoder().encode(JSON.stringify({ messageId: "m-1", body: "hello" })) } satisfies CoordinatorCryptoResult };
    return { ack: { status: "ok" as const }, result: { type: "deriveP2pkhAddress", address: "addr-1" } satisfies CoordinatorCryptoResult };
  });
  return {
    getIsConnected: () => true,
    getBootstrapSnapshot: () => state,
    subscribeTopic: (topic: string, handler: (value: any) => void) => {
      const handlers = topicHandlers.get(topic) ?? new Set<(value: any) => void>();
      handlers.add(handler);
      topicHandlers.set(topic, handlers);
      if (topic === "session.state") handler({ topic, sessionRevision: 1, type: "session.state.changed", cause: "bootstrap", sessionEpoch: "test-epoch", vaultStatus: state.vaultStatus, activePublicKeyHex: state.activePublicKeyHex, keyspaceGeneration: state.keyspaceGeneration });
      return () => handlers.delete(handler);
    },
    unlock: async () => ({ status: "accepted" as const }),
    lock: async () => ({ status: "accepted" as const }),
    activateKey: async () => ({ status: "accepted" as const }),
    vaultOperation,
    crypto,
    backgroundCancelByKey: async () => ({ status: "accepted" as const }),
    publish: (topic, event) => {
      for (const handler of topicHandlers.get(topic) ?? []) handler(event);
    }
  };
}

function makeVault(client: ReturnType<typeof makeClient>) {
  return createVaultServiceCoordinator({ coordinatorClient: client, sessionStateMirror: new SessionStateMirror(client) });
}

describe("VaultServiceCoordinator", () => {
  it("exposes the new Keyspace snapshot during an earlier Vault listener in the same mirror turn", () => {
    const client = makeClient();
    const mirror = new SessionStateMirror(client);
    const vault = createVaultServiceCoordinator({ coordinatorClient: client, sessionStateMirror: mirror });
    const keyspace = createKeyspaceServiceCoordinator(client, mirror);
    const nextKey = "03".padEnd(66, "b");
    const observed: string[] = [];

    vault.onLifecycleChange((snapshot) => {
      if (snapshot.vaultLifecycleRevision === 2) {
        observed.push(keyspace.active().activePublicKeyHex ?? "");
      }
    });
    client.publish("session.state", {
      topic: "session.state",
      type: "session.state.changed",
      sessionRevision: 2,
      sessionEpoch: "next-epoch",
      cause: "activate-key",
      vaultStatus: "unlocked",
      activePublicKeyHex: nextKey,
      keyspaceGeneration: 2,
    });

    expect(observed).toEqual([nextKey]);
  });

  it("does not report a Vault change for an unrelated Coordinator state update", () => {
    const client = makeClient();
    const vault = makeVault(client);
    const onStatus = vi.fn();
    vault.onLifecycleChange((snapshot) => onStatus(snapshot.status));

    client.publish("background.snapshot", {
      topic: "background.snapshot",
      type: "background.snapshot.changed",
      backgroundSnapshotRevision: 1,
      sessionEpoch: "test-epoch",
      snapshots: []
    });

    expect(onStatus).toHaveBeenCalledTimes(1); // onStatusChange 注册时的当前值
    expect(onStatus).toHaveBeenLastCalledWith("unlocked");
  });

  it("exposes unlock/lock/activate failures as command results", async () => {
    const client = makeClient();
    client.unlock = vi.fn(async () => ({ status: "blocked" as const, reason: { key: "vault.locked", fallback: "Vault is locked" } }));
    client.lock = vi.fn(async () => ({ status: "transport-error" as const, message: "Coordinator connection lost", retryable: true }));
    client.activateKey = vi.fn(async () => ({ status: "validation-error" as const, message: "Invalid key" }));
    const vault = makeVault(client);
    await expect(vault.unlock("pw")).resolves.toMatchObject({ status: "blocked" });
    await expect(vault.lock()).resolves.toMatchObject({ status: "transport-error" });
    await expect(vault.activateKey({ publicKeyHex: PUBLIC_KEY, password: "pw" })).resolves.toMatchObject({ status: "validation-error" });
  });

  it("routes AppMsg seal/open through Coordinator crypto RPC", async () => {
    const client = makeClient();
    const vault = makeVault(client);
    const capability = await vault.createActiveKeyCrypto(PUBLIC_KEY);
    const sealed = await capability.sealSendInput({ sender: { senderPublicKeyHex: PUBLIC_KEY, senderAppId: "app" }, recipient: { recipientPublicKeyHex: PUBLIC_KEY, recipientAppId: "peer" }, contentType: "text/plain", body: "hello", clientMessageId: "c-1", createdAtMs: 1 });
    expect("record" in sealed && sealed.record.envelope.envelopeBytes).toEqual(new Uint8Array([1, 2]));
    const opened = await capability.openSealed((sealed as { record: never }).record);
    expect(opened).toEqual({ messageId: "m-1", body: "hello" });
    expect(client.crypto).toHaveBeenCalledWith(expect.objectContaining({ type: "sealSendInput" }));
    expect(client.crypto).toHaveBeenCalledWith(expect.objectContaining({ type: "openSealed" }));
  });

  it("reads public keys through Vault RPC and revokes AppView sessions", async () => {
    const client = makeClient();
    const vault = makeVault(client);
    expect(await vault.listKeys()).toEqual([KEY]);
    expect(await vault.getKey(PUBLIC_KEY)).toEqual(KEY);
    expect(await vault.findByAddress?.("addr-1")).toEqual(KEY);
    const appView = await vault.createAppViewSession({ sessionId: "session-a", publicKeyHex: PUBLIC_KEY, password: "pw" });
    expect(appView.getIdentity().sessionId).toBe("session-a");
    vault.disposeAppViewSession("session-a");
    expect(() => appView.getIdentity()).toThrow(/revoked/i);
  });

  it("uses the Worker exportKeyBackup operation name", async () => {
    const client = makeClient();
    const vault = makeVault(client);
    const capability = await vault.createActiveKeyCrypto(PUBLIC_KEY);
    await capability.exportEncryptedKeyBackup({ publicKeyHex: PUBLIC_KEY });
    expect(client.vaultOperation).toHaveBeenCalledWith("exportKeyBackup", { publicKeyHex: PUBLIC_KEY });
  });

  it("uses current-key RPCs without adding a public-key argument", async () => {
    const client = makeClient();
    const vault = makeVault(client);

    await expect(vault.exportCurrentKeyBackup()).resolves.toBe("current-backup");
    await expect(vault.listCurrentKeyPasskeys()).resolves.toEqual([]);

    expect(client.vaultOperation).toHaveBeenCalledWith("exportCurrentKeyBackup", undefined);
    expect(client.vaultOperation).toHaveBeenCalledWith("listCurrentKeyPasskeys", undefined);
  });

  it("revokes the previous capability when an AppView session id is reused", async () => {
    const client = makeClient();
    const vault = makeVault(client);
    const first = await vault.createAppViewSession({ sessionId: "reused", publicKeyHex: PUBLIC_KEY, password: "pw" });
    const second = await vault.createAppViewSession({ sessionId: "reused", publicKeyHex: PUBLIC_KEY, password: "pw" });
    expect(() => first.getIdentity()).toThrow(/revoked/i);
    expect(second.getIdentity().sessionId).toBe("reused");
  });

  it("removeKey throws without sending RPC", async () => {
    const client = makeClient();
    const vault = makeVault(client);
    await expect(vault.removeKey(PUBLIC_KEY)).rejects.toThrow("Use keyspace.deleteKey instead");
    expect(client.vaultOperation).not.toHaveBeenCalledWith("removeKey", expect.anything());
  });
});
