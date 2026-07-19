import { describe, expect, it, vi } from "vitest";
import type { CoordinatorCryptoOperation, CoordinatorCryptoResult, KeyRef } from "@keymaster/contracts";
import { createVaultServiceCoordinator } from "./vaultServiceCoordinator.js";

const PUBLIC_KEY = "02".padEnd(66, "a");
const KEY: KeyRef = { publicKeyHex: PUBLIC_KEY, label: "primary", address: "addr-1", capabilities: ["p2pkh"], createdAt: "now" } as KeyRef;

function makeClient() {
  const state = { vaultStatus: "unlocked" as const, activePublicKeyHex: PUBLIC_KEY };
  const vaultOperation = vi.fn(async (operation: string, input?: unknown) => {
    if (operation === "listKeys") return [KEY];
    if (operation === "getKey") return (input as { publicKeyHex: string }).publicKeyHex === PUBLIC_KEY ? KEY : undefined;
    if (operation === "verifyPassword") return true;
    if (operation === "exportKeyBackup") return "backup";
    throw new Error(`unexpected operation ${operation}`);
  });
  const crypto = vi.fn(async (operation: CoordinatorCryptoOperation) => {
    if (operation.type === "sealSendInput") return { ack: { status: "ok" }, result: { type: "sealSendInput", envelope: new Uint8Array([1, 2]), signature: new Uint8Array([3]) } satisfies CoordinatorCryptoResult };
    if (operation.type === "openSealed") return { ack: { status: "ok" }, result: { type: "openSealed", plaintext: new TextEncoder().encode(JSON.stringify({ messageId: "m-1", body: "hello" })) } satisfies CoordinatorCryptoResult };
    return { ack: { status: "ok" }, result: { type: "deriveP2pkhAddress", address: "addr-1" } satisfies CoordinatorCryptoResult };
  });
  return {
    getIsConnected: () => true,
    getState: () => state,
    onStateChange: (handler: (value: typeof state) => void) => { handler(state); return () => undefined; },
    onEvent: () => () => undefined,
    unlock: async () => ({ status: "accepted" }),
    lock: async () => ({ status: "accepted" }),
    activateKey: async () => ({ status: "accepted" }),
    vaultOperation,
    crypto
  };
}

describe("VaultServiceCoordinator", () => {
  it("routes AppMsg seal/open through Coordinator crypto RPC", async () => {
    const client = makeClient();
    const vault = createVaultServiceCoordinator({ coordinatorClient: client });
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
    const vault = createVaultServiceCoordinator({ coordinatorClient: client });
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
    const vault = createVaultServiceCoordinator({ coordinatorClient: client });
    const capability = await vault.createActiveKeyCrypto(PUBLIC_KEY);
    await capability.exportEncryptedKeyBackup({ publicKeyHex: PUBLIC_KEY });
    expect(client.vaultOperation).toHaveBeenCalledWith("exportKeyBackup", { publicKeyHex: PUBLIC_KEY });
  });

  it("revokes the previous capability when an AppView session id is reused", async () => {
    const client = makeClient();
    const vault = createVaultServiceCoordinator({ coordinatorClient: client });
    const first = await vault.createAppViewSession({ sessionId: "reused", publicKeyHex: PUBLIC_KEY, password: "pw" });
    const second = await vault.createAppViewSession({ sessionId: "reused", publicKeyHex: PUBLIC_KEY, password: "pw" });
    expect(() => first.getIdentity()).toThrow(/revoked/i);
    expect(second.getIdentity().sessionId).toBe("reused");
  });
});
