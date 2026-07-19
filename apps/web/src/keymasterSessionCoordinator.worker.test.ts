import { describe, expect, it } from "vitest";
import { __testBackgroundRunNow, __testCancelByKey, __testGetSnapshot, __testInvalidateSession, __testRegisterTask, __testResetState, __testRestartWorker, __testRunTask, __testSetVaultStatus, __testUpdateScheduleSettings } from "./keymasterSessionCoordinator.worker.js";

class TestPort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly messages: unknown[] = [];
  start(): void {}
  close(): void {}
  postMessage(message: unknown): void { this.messages.push(message); }
  send(message: unknown): void { this.onmessage?.({ data: message } as MessageEvent); }
}

async function flush(): Promise<void> { await Promise.resolve(); await Promise.resolve(); }

describe("Session Coordinator worker", () => {
  it("cancels only the matching key and waits for the handler completion", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", "a".repeat(64));
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let aborted = false;
    __testRegisterTask({ id: "test-a", publicKeyHex: "a".repeat(64), run: async ({ signal }) => { await released; aborted = signal.aborted; } });
    __testRegisterTask({ id: "test-b", publicKeyHex: "b".repeat(64), run: async () => undefined });
    const running = __testRunTask("test-a");
    await Promise.resolve();
    const cancelling = __testCancelByKey("a".repeat(64));
    release();
    await cancelling;
    await running;
    expect(aborted).toBe(true);
    expect(__testGetSnapshot().taskSnapshots.find((task) => task.id === "test-b")?.state).toBe("idle");
  });

  it("rejects a late handler freshness check after session invalidation", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", "a".repeat(64));
    let committed = false;
    __testRegisterTask({ id: "late", publicKeyHex: "a".repeat(64), run: async ({ assertSessionFresh }) => { await Promise.resolve(); assertSessionFresh(); committed = true; } });
    const running = __testRunTask("late");
    __testInvalidateSession();
    await running;
    expect(committed).toBe(false);
    expect(__testGetSnapshot().taskSnapshots.find((task) => task.id === "late")?.error).toMatch(/stale/i);
  });

  it("fans out global lock to both ports and does not lock when one port closes", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", "a".repeat(64));
    const a = new TestPort();
    const b = new TestPort();
    const onconnect = (globalThis as unknown as { onconnect?: (event: MessageEvent) => void }).onconnect;
    onconnect?.({ ports: [a] } as unknown as MessageEvent);
    onconnect?.({ ports: [b] } as unknown as MessageEvent);
    a.send({ kind: "hello", clientId: "a", requestId: "hello-a" });
    b.send({ kind: "hello", clientId: "b", requestId: "hello-b" });
    a.send({ kind: "subscribe", clientId: "a", requestId: "sub-a", topics: ["vault"] });
    b.send({ kind: "subscribe", clientId: "b", requestId: "sub-b", topics: ["vault"] });
    await flush();
    a.close();
    expect(__testGetSnapshot().vaultStatus).toBe("unlocked");
    b.send({ kind: "lock", clientId: "b", requestId: "lock", expectedSessionEpoch: __testGetSnapshot().sessionEpoch });
    await flush();
    expect(__testGetSnapshot().vaultStatus).toBe("locked");
    expect(b.messages.some((message) => (message as { type?: string; status?: string }).type === "vault.status-changed" && (message as { status?: string }).status === "locked")).toBe(true);
  });

  it("returns immediate accepted/already-running acknowledgements for concurrent runNow", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", "a".repeat(64));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let runs = 0;
    __testRegisterTask({ id: "once", publicKeyHex: "a".repeat(64), run: async () => { runs++; await gate; } });
    const first = await __testBackgroundRunNow("once");
    const second = await __testBackgroundRunNow("once");
    expect(first.ack.status).toBe("accepted");
    expect(second.ack.status).toBe("already-running");
    expect(runs).toBe(1);
    release();
    await flush();
  });

  it("exposes only public locked snapshot state", () => {
    __testResetState();
    __testSetVaultStatus("locked");
    const snapshot = __testGetSnapshot();
    expect(snapshot.vaultStatus).toBe("locked");
    expect(JSON.stringify(snapshot)).not.toMatch(/password|privateKey|token/i);
  });

  it("persists schedule settings and restores locked state after Worker restart", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", "a".repeat(64));
    const ack = await __testUpdateScheduleSettings({ assetHoldingsIntervalMs: 60_000 });
    expect(ack.ack.status).toBe("accepted");
    expect(__testGetSnapshot().scheduleSettings.assetHoldingsIntervalMs).toBe(60_000);
    await __testRestartWorker();
    expect(__testGetSnapshot().vaultStatus).not.toBe("unlocked");
    expect(__testGetSnapshot().scheduleSettings.assetHoldingsIntervalMs).toBe(60_000);
  });
});
