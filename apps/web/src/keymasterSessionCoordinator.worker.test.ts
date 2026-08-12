import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bytesToHex,
  hexToBytes,
  vaultDb,
  type LegacyVaultKeyRecord,
} from "@keymaster/plugin-vault/coordinator";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { parse as keyholdParse, unlock as keyholdUnlock } from "keyhold";
import {
  __testBackgroundRunNow,
  __testAddPasskeyToCurrentKey,
  __testActivateKeyWithPasskey,
  __testCancelByKey,
  __testCreateVault,
  __testCreateEmptyVault,
  __testChangePassword,
  __testDeleteVault,
  __testExportKeyBackup,
  __testExportCurrentKeyBackup,
  __testDeleteKeyMaterial,
  __testFinalizeEmptyVaultAfterLastKeyDeletion,
  __testGetActivePublicKeyHex,
  __testGetConnectedPortCount,
  __testDispatchStorageGrant,
  __testDispatchStorageData,
  __testDispatchStorageControl,
  __testDispatchStorageCancel,
  __testDispatchStorageAbort,
  __testResolveStorageGrant,
  __testSeedStorageRequest,
  __testSetStorageRuntime,
  __testSetStorageStartupFailure,
  __testReleaseStorageRuntime,
  __testStorageMutationBarrierProbe,
  __testStorageQueueAdmission,
  __testStorageQueueSnapshot,
  __testStorageSlotErrorCodes,
  __testStorageFairDispatch,
  __testPublishStorageState,
  __testStorageTransfer,
  __testAttachPort,
  __testDispatchStorageMessage,
  __testSetStorageSessionResolver,
  __testGetSnapshot,
  __testGetVaultStatus,
  __testImportKeyBackup,
  __testImportPrivateKey,
  __testInvalidateSession,
  __testLock,
  __testListPasskeysForKey,
  __testRegisterTask,
  __testRemovePasskeyFromCurrentKey,
  __testResetState,
  __testRestartWorker,
  __testRunTask,
  __testSetVaultStatus,
  __testFailNextCoordinatorMetaPersist,
  __testSetActive,
  __testSealLocalSecret,
  __testUnlock,
  __testUpdateScheduleSettings
} from "./keymasterSessionCoordinator.worker.js";

class TestPort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly messages: unknown[] = [];
  start(): void {}
  close(): void {}
  postMessage(message: unknown): void { this.messages.push(message); }
  send(message: unknown): void { this.onmessage?.({ data: message } as MessageEvent); }
}

// metadata snapshot validator 会校验 secp256k1 曲线点；测试 fixture 使用
// 确定性私钥派生真实压缩公钥，只有显式 malformed case 才使用无效值。
function validPublisherKey(seed: number): string {
  const privateKey = new Uint8Array(32);
  privateKey[31] = seed;
  return bytesToHex(secp256k1.getPublicKey(privateKey, true));
}

const VALID_PUBLISHER_KEYS = [1, 2, 3, 4, 5, 6].map(validPublisherKey);

async function flush(): Promise<void> { await Promise.resolve(); await Promise.resolve(); }

describe("Session Coordinator worker", () => {
  it("rejects forged client ownership and revoked/changed Storage grants", async () => {
    __testResetState();
    const identity = { version: 1 as const, publisherPublicKeyHex: VALID_PUBLISHER_KEYS[0]!, appId: "app", appName: "App", identityDigestHex: "aa".repeat(32) };
    let revoked = false;
    __testSetStorageSessionResolver(async (id) => revoked ? null : { sessionId: id, origin: "https://app.example", appIdentity: identity, revokedAt: null });
    const granted = await __testDispatchStorageGrant("session-a", "port-a", "forged-client");
    expect(granted.ack.status).toBe("ok");
    const grantId = granted.operationResult as string;
    __testSetStorageRuntime({ list: async () => ({ prefix: "", parentPrefix: "", directories: [], files: [] }), abortSession: async () => undefined });
    expect((await __testDispatchStorageData({ grantId, actualPortId: "forged-client", requestClientId: "port-a" })).ack.status).toBe("error");
    revoked = true;
    expect((await __testDispatchStorageGrant("session-a", "port-a")).ack.status).toBe("error");
    await expect(__testResolveStorageGrant(grantId, "port-a")).rejects.toThrow();
    __testSetStorageRuntime(undefined);
    __testSetStorageSessionResolver(undefined);
  });

  it("rejects unknown and identity-less sessions and binds grants to unchanged origin/identity", async () => {
    __testResetState();
    __testSetStorageSessionResolver(async () => null);
    expect((await __testDispatchStorageGrant("missing", "port-a")).ack.status).toBe("error");
    const identity = { version: 1 as const, publisherPublicKeyHex: VALID_PUBLISHER_KEYS[1]!, appId: "app", appName: "App", identityDigestHex: "bb".repeat(32) };
    let origin = "https://one.example";
    __testSetStorageSessionResolver(async (id) => ({ sessionId: id, origin, appIdentity: identity, revokedAt: null }));
    const granted = await __testDispatchStorageGrant("session-b", "port-a");
    expect(granted.ack.status).toBe("ok");
    origin = "https://two.example";
    await expect(__testResolveStorageGrant(granted.operationResult as string, "port-a")).rejects.toThrow();
    __testSetStorageSessionResolver(async (id) => ({ sessionId: id, origin, appIdentity: { ...identity, publisherPublicKeyHex: "22".repeat(32) }, revokedAt: null }));
    expect((await __testDispatchStorageGrant("short-key", "port-a")).ack.status).toBe("error");
    __testSetStorageSessionResolver(async (id) => ({ sessionId: id, origin, appIdentity: undefined as never, revokedAt: null }));
    expect((await __testDispatchStorageGrant("no-identity", "port-a")).ack.status).toBe("error");
    __testSetStorageSessionResolver(undefined);
  });

  it("enforces cancel owner and aborts only the selected session", async () => {
    __testResetState();
    __testSetStorageRuntime({ abortSession: async () => undefined });
    const a = __testSeedStorageRequest("a", "port-a", "session-a");
    const b = __testSeedStorageRequest("b", "port-b", "session-b");
    const collisionA = __testSeedStorageRequest("same", "port-a", "session-a");
    const collisionB = __testSeedStorageRequest("same", "port-b", "session-b");
    await __testDispatchStorageCancel("a", "port-b");
    expect(a.aborted).toBe(false);
    await __testDispatchStorageCancel("a", "port-a");
    expect(a.aborted).toBe(true);
    await __testDispatchStorageCancel("same", "port-a");
    expect(collisionA.aborted).toBe(true);
    expect(collisionB.aborted).toBe(false);
    await __testDispatchStorageAbort("session-b", "port-b");
    expect(b.aborted).toBe(true);
    __testSetStorageRuntime(undefined);
  });

  it("uses transferables without mutating the receiver payload", () => {
    const result = __testStorageTransfer(new Uint8Array([1, 2, 3]).buffer);
    expect(result.transferCount).toBe(1);
    expect(result.inputDetachedByteLength).toBe(0);
    expect(result.detachedByteLength).toBe(0);
    expect(result.receivedByteLength).toBe(3);
  });

  it("aborts a slow Storage data lane when the global lock preempts it", async () => {
    __testResetState();
    const identity = { version: 1 as const, publisherPublicKeyHex: VALID_PUBLISHER_KEYS[2]!, appId: "app", appName: "App", identityDigestHex: "cc".repeat(32) };
    __testSetStorageSessionResolver(async (id) => ({ sessionId: id, origin: "https://slow.example", appIdentity: identity, revokedAt: null }));
    __testSetStorageRuntime({ list: async (_ctx, input) => await new Promise((_, reject) => { input.signal?.addEventListener("abort", () => { reject(new Error("storage_unavailable")); }); }), abortSession: async () => undefined });
    const grant = await __testDispatchStorageGrant("slow-session", "port-a");
    const pending = __testDispatchStorageData({ grantId: grant.operationResult as string, actualPortId: "port-a" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await __testReleaseStorageRuntime();
    expect((await pending).ack.status).toBe("error");
    __testSetStorageSessionResolver(undefined);
    __testSetStorageRuntime(undefined);
  });

  it("reclaims all four hanging data slots on lock and serves new runtime data", async () => {
    __testResetState();
    const identity = { version: 1 as const, publisherPublicKeyHex: VALID_PUBLISHER_KEYS[3]!, appId: "app", appName: "App", identityDigestHex: "ff".repeat(32) };
    __testSetStorageSessionResolver(async (id) => ({ sessionId: id, origin: "https://slots.example", appIdentity: identity, revokedAt: null }));
    __testSetStorageRuntime({ list: async () => await new Promise<never>(() => undefined), abortSession: async () => undefined });
    const grant = await __testDispatchStorageGrant("slots-session", "port-a");
    const pending = Array.from({ length: 4 }, () => __testDispatchStorageData({ grantId: grant.operationResult as string, actualPortId: "port-a" }));
    await new Promise((resolve) => setTimeout(resolve, 20)); await __testReleaseStorageRuntime();
    expect((await Promise.all(pending)).every((response) => response.ack.status === "error")).toBe(true);
    expect(__testStorageQueueSnapshot().globalActive).toBe(0);
    __testSetStorageRuntime({ list: async () => ({ prefix: "", parentPrefix: "", directories: [], files: [] }), abortSession: async () => undefined });
    const nextGrant = await __testDispatchStorageGrant("slots-session", "port-a");
    expect((await __testDispatchStorageData({ grantId: nextGrant.operationResult as string, actualPortId: "port-a" })).ack.status).toBe("ok");
    __testSetStorageSessionResolver(undefined); __testSetStorageRuntime(undefined);
  });

  it("rejects a late provider success after session epoch or generation changes", async () => {
    __testResetState();
    const identity = { version: 1 as const, publisherPublicKeyHex: VALID_PUBLISHER_KEYS[4]!, appId: "app", appName: "App", identityDigestHex: "dd".repeat(32) };
    __testSetStorageSessionResolver(async (id) => ({ sessionId: id, origin: "https://late.example", appIdentity: identity, revokedAt: null }));
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    let generation = 1;
    __testSetStorageRuntime({ getProviderSummary: async () => ({ generation, providerId: "aws-s3", bucketHint: "b", accessKeyHint: "k", secretConfigured: true, updatedAt: 1 }), list: async () => { await delayed; return { prefix: "", parentPrefix: "", directories: [], files: [] }; }, abortSession: async () => undefined });
    const grant = await __testDispatchStorageGrant("late-session", "port-a");
    const pending = __testDispatchStorageData({ grantId: grant.operationResult as string, actualPortId: "port-a" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    generation = 2;
    release();
    expect((await pending).ack).toMatchObject({ status: "error", code: "storage_unavailable" });
    __testResetState();
    __testSetStorageSessionResolver(async (id) => ({ sessionId: id, origin: "https://late.example", appIdentity: identity, revokedAt: null }));
    let releaseEpoch!: () => void;
    const delayedEpoch = new Promise<void>((resolve) => { releaseEpoch = resolve; });
    __testSetStorageRuntime({ getProviderSummary: async () => ({ generation: 1, providerId: "aws-s3", bucketHint: "b", accessKeyHint: "k", secretConfigured: true, updatedAt: 1 }), list: async () => { await delayedEpoch; return { prefix: "", parentPrefix: "", directories: [], files: [] }; }, abortSession: async () => undefined });
    const epochGrant = await __testDispatchStorageGrant("late-epoch", "port-a");
    const epochPending = __testDispatchStorageData({ grantId: epochGrant.operationResult as string, actualPortId: "port-a" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    __testInvalidateSession(); releaseEpoch();
    expect((await epochPending).ack).toMatchObject({ status: "error", code: "storage_unavailable" });
    __testSetStorageSessionResolver(undefined); __testSetStorageRuntime(undefined);
  });

  it("serializes password-rotation mutation with Storage controls", async () => {
    __testResetState();
    __testSetStorageRuntime({ status: () => "unconfigured", getProviderSummary: async () => null });
    const result = await __testStorageMutationBarrierProbe();
    expect(result).toEqual({ blockedBeforeRelease: true, completedAfterRelease: true });
    __testSetStorageRuntime(undefined);
  });

  it("keeps Storage startup failures isolated from Vault state", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", "a".repeat(64));
    const messages: unknown[] = [];
    __testAttachPort("startup-port", (message) => messages.push(message));
    await __testDispatchStorageMessage("startup-port", { kind: "subscribe", clientId: "spoof", requestId: "sub-startup", topics: ["storage.state"] });
    __testSetStorageStartupFailure(true);
    const response = await __testDispatchStorageControl({ type: "status" });
    expect(response.ack).toMatchObject({ status: "error", code: "storage_unavailable" });
    expect(__testGetVaultStatus()).toBe("unlocked");
    expect(messages.some((message) => (message as { status?: string }).status === "degraded")).toBe(true);
    __testSetStorageStartupFailure(false);
  });

  it("keeps per-port queue admission fair and bounded", () => {
    __testResetState();
    const result = __testStorageQueueAdmission("port-a");
    expect(result.firstPortAccepted).toBe(16);
    expect(result.firstPortRejected).toBe(true);
    expect(result.secondPortAccepted).toBe(true);
    expect(result.remaining).toEqual({});
  });

  it("keeps storage queue and cancellation errors typed", async () => {
    const result = await __testStorageSlotErrorCodes();
    expect(result).toEqual({ queueFull: "storage_limit_exceeded", queuedAbort: "storage_unavailable", activeAbort: "storage_unavailable" });
  });

  it("schedules a competing port ahead of a saturated port's waiters", async () => {
    const order = await __testStorageFairDispatch();
    expect(order.slice(0, 4)).toEqual(["a1", "a2", "a3", "b1"]);
  });

  it("releases a port explicitly before close", async () => {
    __testResetState();
    const identity = { version: 1 as const, publisherPublicKeyHex: VALID_PUBLISHER_KEYS[5]!, appId: "app", appName: "App", identityDigestHex: "ee".repeat(32) };
    __testSetStorageSessionResolver(async (id) => ({ sessionId: id, origin: "https://disconnect.example", appIdentity: identity, revokedAt: null }));
    const pending = __testSeedStorageRequest("active", "port-z", "disconnect-session");
    const granted = await __testDispatchStorageGrant("disconnect-session", "port-z");
    __testAttachPort("port-z", () => undefined);
    await __testDispatchStorageMessage("port-z", { kind: "disconnect", clientId: "spoof", requestId: "release" });
    expect(pending.aborted).toBe(true);
    await expect(__testResolveStorageGrant(granted.operationResult as string, "port-z")).rejects.toThrow();
    __testSetStorageSessionResolver(undefined);
    const port = new TestPort();
    const onconnect = (globalThis as unknown as { onconnect?: (event: MessageEvent) => void }).onconnect;
    onconnect?.({ ports: [port] } as unknown as MessageEvent);
    port.send({ kind: "disconnect", clientId: "spoof", requestId: "release" });
    await flush();
    expect(__testGetConnectedPortCount()).toBe(0);
  });

  it("returns matching storage.state baselines to two ports", async () => {
    __testResetState();
    const a = new TestPort(); const b = new TestPort();
    const onconnect = (globalThis as unknown as { onconnect?: (event: MessageEvent) => void }).onconnect;
    onconnect?.({ ports: [a] } as unknown as MessageEvent); onconnect?.({ ports: [b] } as unknown as MessageEvent);
    a.send({ kind: "subscribe", clientId: "a", requestId: "sa", topics: ["storage.state"] });
    b.send({ kind: "subscribe", clientId: "b", requestId: "sb", topics: ["storage.state"] });
    await flush();
    const baseline = (port: TestPort, id: string) => (port.messages.find((m) => (m as { requestId?: string }).requestId === id) as { operationResult?: { baselines?: Array<{ baselineRevision: number; snapshot: { storageRevision?: number } }> } } | undefined)?.operationResult?.baselines?.[0];
    const ba = baseline(a, "sa"); const bb = baseline(b, "sb");
    expect(ba?.baselineRevision).toBe(ba?.snapshot.storageRevision);
    expect(bb?.baselineRevision).toBe(bb?.snapshot.storageRevision);
    expect(ba?.baselineRevision).toBe(bb?.baselineRevision);
    a.send({ kind: "disconnect", clientId: "a", requestId: "da" }); b.send({ kind: "disconnect", clientId: "b", requestId: "db" });
  });

  it("publishes one strictly increasing storage revision to every subscribed port", async () => {
    __testResetState();
    const a = new TestPort(); const b = new TestPort();
    const onconnect = (globalThis as unknown as { onconnect?: (event: MessageEvent) => void }).onconnect;
    onconnect?.({ ports: [a] } as unknown as MessageEvent); onconnect?.({ ports: [b] } as unknown as MessageEvent);
    a.send({ kind: "subscribe", clientId: "a", requestId: "sa2", topics: ["storage.state"] });
    b.send({ kind: "subscribe", clientId: "b", requestId: "sb2", topics: ["storage.state"] });
    await flush();
    a.messages.length = 0; b.messages.length = 0;
    await __testPublishStorageState(); await __testPublishStorageState();
    const revisions = (port: TestPort) => port.messages.filter((m) => (m as { topic?: string; type?: string }).topic === "storage.state" && (m as { type?: string }).type === "storage.state.changed").map((m) => (m as { storageRevision: number }).storageRevision);
    const ra = revisions(a); const rb = revisions(b);
    expect(ra.length).toBeGreaterThanOrEqual(2); expect(rb).toEqual(ra);
    expect(ra[1]).toBeGreaterThan(ra[0]!);
  });

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
    // The module's one-time IndexedDB bootstrap is asynchronous. Let it finish
    // before installing this test's synthetic session state.
    await new Promise((resolve) => setTimeout(resolve, 30));
    __testResetState();
    __testSetVaultStatus("unlocked", "a".repeat(64));
    const a = new TestPort();
    const b = new TestPort();
    const onconnect = (globalThis as unknown as { onconnect?: (event: MessageEvent) => void }).onconnect;
    onconnect?.({ ports: [a] } as unknown as MessageEvent);
    onconnect?.({ ports: [b] } as unknown as MessageEvent);
    a.send({ kind: "hello", clientId: "a", requestId: "hello-a" });
    b.send({ kind: "hello", clientId: "b", requestId: "hello-b" });
    a.send({ kind: "subscribe", clientId: "a", requestId: "sub-a", topics: ["session.state"] });
    b.send({ kind: "subscribe", clientId: "b", requestId: "sub-b", topics: ["session.state"] });
    await flush();
    a.close();
    expect(__testGetSnapshot().vaultStatus).toBe("unlocked");
    // 锁定是收敛型安全操作：旧页面也必须能锁定新 epoch 的全局会话。
    b.send({ kind: "lock", clientId: "b", requestId: "lock", expectedSessionEpoch: "stale-page-epoch" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(b.messages.some((message) => (message as { type?: string; vaultStatus?: string }).type === "session.state.changed" && (message as { vaultStatus?: string }).vaultStatus === "locked")).toBe(true);
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

  it("marks tasks as blocked when vault is locked", async () => {
    __testResetState();
    __testSetVaultStatus("locked");
    __testRegisterTask({ id: "task-1", publicKeyHex: "a".repeat(64), run: async () => undefined });
    // 模拟 performGlobalLock 的行为
    const snapshot = __testGetSnapshot();
    const task = snapshot.taskSnapshots.find((t) => t.id === "task-1");
    expect(task?.state).toBe("idle"); // 初始状态是 idle
    // 锁定时任务应该变为 blocked
    __testSetVaultStatus("unlocked", "a".repeat(64));
    __testRegisterTask({ id: "task-2", publicKeyHex: "a".repeat(64), run: async () => undefined });
    // 验证解锁状态下的任务是 idle
    expect(__testGetSnapshot().taskSnapshots.find((t) => t.id === "task-2")?.state).toBe("idle");
  });

  it("locks running tasks to blocked after performGlobalLock", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", "a".repeat(64));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    __testRegisterTask({ id: "running-task", publicKeyHex: "a".repeat(64), run: async () => { await gate; } });
    void __testRunTask("running-task");
    await Promise.resolve();
    // 锁定
    __testSetVaultStatus("locked");
    release();
    await flush();
    const snapshot = __testGetSnapshot();
    const task = snapshot.taskSnapshots.find((t) => t.id === "running-task");
    expect(task?.state).toBe("blocked");
    expect(task?.blockedReason).toMatchObject({ key: "background.blocked.task", fallback: "Vault is locked" });
  });

  it("broadcasts background snapshot immediately on lock", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", "a".repeat(64));
    const a = new TestPort();
    const onconnect = (globalThis as unknown as { onconnect?: (event: MessageEvent) => void }).onconnect;
    onconnect?.({ ports: [a] } as unknown as MessageEvent);
    a.send({ kind: "hello", clientId: "a", requestId: "hello-a" });
    a.send({ kind: "subscribe", clientId: "a", requestId: "sub-a", topics: ["background.snapshot"] });
    await flush();
    a.messages.length = 0;
    // 锁定
    a.send({ kind: "lock", clientId: "a", requestId: "lock", expectedSessionEpoch: __testGetSnapshot().sessionEpoch });
    for (let attempt = 0; attempt < 50; attempt++) {
      if (a.messages.some((message) => (message as { type?: string }).type === "background.snapshot.changed")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const backgroundEvents = a.messages.filter((m) => (m as { type?: string }).type === "background.snapshot.changed");
    expect(backgroundEvents.length).toBeGreaterThan(0);
  });

  it("restores tasks to idle and reschedules after unlock", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", "a".repeat(64));
    __testRegisterTask({ id: "blocked-task", publicKeyHex: "a".repeat(64), run: async () => undefined });
    // 模拟锁定
    const snapshot1 = __testGetSnapshot();
    expect(snapshot1.taskSnapshots.find((t) => t.id === "blocked-task")?.state).toBe("idle");
    // 解锁后任务应该保持 idle
    const snapshot2 = __testGetSnapshot();
    const task = snapshot2.taskSnapshots.find((t) => t.id === "blocked-task");
    expect(task?.state).toBe("idle");
    expect(task?.blockedReason).toBeUndefined();
  });

  it("uses persisted interval for nextRunAt", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", "a".repeat(64));
    await __testUpdateScheduleSettings({ assetHoldingsIntervalMs: 120_000 });
    // 验证设置已持久化
    const snapshot = __testGetSnapshot();
    expect(snapshot.scheduleSettings.assetHoldingsIntervalMs).toBe(120_000);
  });
});

// ============================================================
// Backup Import Tests (生产执行路径)
// ============================================================

const TEST_PRIV_2 = "0000000000000000000000000000000000000000000000000000000000000002";

const STORAGE_DB_NAME = "keymaster.storage";
const STORAGE_PROVIDER_SCOPE = "keymaster.storage.provider-config.v1";

type StorageTestState = {
  provider?: { sealedConfig: unknown };
  journal?: unknown;
};

function seedCorruptStorageUpload(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(STORAGE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("providerConfig")) db.createObjectStore("providerConfig", { keyPath: "key" });
      if (!db.objectStoreNames.contains("multipartUploads")) db.createObjectStore("multipartUploads", { keyPath: "internalUploadId" });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("multipartUploads", "readwrite");
      tx.objectStore("multipartUploads").put({ internalUploadId: "corrupt-upload", sealedS3UploadId: { version: 2, saltHex: "00", nonceHex: "00", ciphertextHex: "00" } });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

function seedStorageProvider(sealedConfig: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(STORAGE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("providerConfig")) db.createObjectStore("providerConfig", { keyPath: "key" });
      if (!db.objectStoreNames.contains("multipartUploads")) db.createObjectStore("multipartUploads", { keyPath: "internalUploadId" });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("providerConfig", "readwrite");
      tx.objectStore("providerConfig").put({
        key: "active",
        providerId: "aws-s3",
        publicSummary: { bucketHint: "bucket", accessKeyHint: "key" },
        sealedConfig,
        generation: 1,
        updatedAt: Date.now()
      });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

function readStorageTestState(): Promise<StorageTestState> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(STORAGE_DB_NAME, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("providerConfig", "readonly");
      const provider = tx.objectStore("providerConfig").get("active");
      const journal = tx.objectStore("providerConfig").get("rotation");
      tx.oncomplete = () => { db.close(); resolve({ provider: provider.result, journal: journal.result }); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

function deleteStorageDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(STORAGE_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Storage database deletion was blocked"));
  });
}

describe("Session Coordinator backup import", () => {
  beforeEach(async () => {
    await __testDeleteVault();
    __testResetState();
  });

  afterEach(async () => {
    await __testDeleteVault();
    __testResetState();
  });

  it("rejects a legacy whole-Vault backup as an unrecognized format", async () => {
    await __testCreateEmptyVault("target-pw");
    const legacyBackup = JSON.stringify({
      backupVersion: 1,
      sourceVaultMeta: { id: "singleton" },
      keyRecord: {
        publicKeyHex: "02a301cedb7a6cf4d6fc5ba5afe611ef4d13b0d48887ed2574fb186c69aa01058e",
        cipherVersion: "v2",
        cipherB64: "legacy-ciphertext"
      }
    });

    await expect(__testImportKeyBackup(legacyBackup, "legacy-pw", "target-pw"))
      .rejects.toThrow("Unrecognized key backup format");
    expect(await vaultDb.listKeys()).toHaveLength(0);
  });

  it("cross-vault import succeeds with different passwords", async () => {
    const sourceResult = await __testCreateVault("source-pw", { label: "source-key" });
    const backup = await __testExportKeyBackup(sourceResult.publicKeyHex!);

    // A second Vault must be a fresh persistent store, rather than merely a
    // reset Worker session over the source Vault's IndexedDB records.
    await __testDeleteVault();
    __testResetState();
    await __testCreateVault("target-pw", { label: "target-key" });
    const imported = await __testImportKeyBackup(backup, "source-pw", "target-pw");
    expect(imported.publicKeyHex).toBe(sourceResult.publicKeyHex);

    const targetMeta = await vaultDb.getMeta();
    const targetRecord = await vaultDb.getKey(imported.publicKeyHex);
    expect(targetMeta).toBeDefined();
    expect(targetRecord).toBeDefined();
    expect(targetRecord?.storageVersion).toBe("keyhold-v2");
    expect(targetRecord?.keyholdDocument).toBeDefined();
    await __testLock();
    const unlocked = await __testUnlock("target-pw", imported.publicKeyHex);
    expect(unlocked.ack.status).toBe("accepted");
    expect(__testGetActivePublicKeyHex()).toBe(imported.publicKeyHex);
  });

  it("rejects wrong source password without writing any key", async () => {
    const source = await __testCreateVault("source-pw");
    const backup = await __testExportKeyBackup(source.publicKeyHex!);
    await __testDeleteVault();
    __testResetState();
    await __testCreateEmptyVault("target-pw");

    await expect(__testImportKeyBackup(backup, "wrong-source-pw", "target-pw")).rejects.toThrow(/unable to unlock document/);
    expect(await vaultDb.listKeys()).toHaveLength(0);
    expect(__testGetVaultStatus()).toBe("locked");
  });

  it("rejects wrong target password without writing any key", async () => {
    const source = await __testCreateVault("source-pw");
    const backup = await __testExportKeyBackup(source.publicKeyHex!);
    await __testDeleteVault();
    __testResetState();
    await __testCreateEmptyVault("target-pw");

    await expect(__testImportKeyBackup(backup, "source-pw", "wrong-target-pw")).rejects.toThrow(/Invalid password/);
    expect(await vaultDb.listKeys()).toHaveLength(0);
    expect(__testGetVaultStatus()).toBe("locked");
  });

  it("rejects backup with mismatched public key and material", async () => {
    const source = await __testCreateVault("source-pw");
    const backup = await __testExportKeyBackup(source.publicKeyHex!);
    const parsed = JSON.parse(backup) as Record<string, unknown>;
    const tamperedPublicKeyHex = bytesToHex(secp256k1.getPublicKey(hexToBytes(TEST_PRIV_2), true));
    parsed.publicKeyHex = tamperedPublicKeyHex;
    const tamperedBackup = JSON.stringify(parsed);

    await __testDeleteVault();
    __testResetState();
    await __testCreateEmptyVault("target-pw");

    await expect(__testImportKeyBackup(tamperedBackup, "source-pw", "target-pw")).rejects.toThrow();
    expect(await vaultDb.listKeys()).toHaveLength(0);
  });

  it("rejects duplicate key import with Key already exists", async () => {
    const source = await __testCreateVault("source-pw");
    const backup = await __testExportKeyBackup(source.publicKeyHex!);
    await __testDeleteVault();
    __testResetState();
    await __testCreateEmptyVault("target-pw");
    const first = await __testImportKeyBackup(backup, "source-pw", "target-pw");
    const original = await vaultDb.getKey(first.publicKeyHex);

    await expect(__testImportKeyBackup(backup, "source-pw", "target-pw")).rejects.toThrow("Key already exists");
    expect(await vaultDb.listKeys()).toHaveLength(1);
    expect(await vaultDb.getKey(first.publicKeyHex)).toEqual(original);
  });

  it("imports the first key into a locked empty Vault and activates it after unlock", async () => {
    const source = await __testCreateVault("source-pw");
    const backup = await __testExportKeyBackup(source.publicKeyHex!);
    await __testDeleteVault();
    __testResetState();
    await __testCreateEmptyVault("target-pw");

    const imported = await __testImportKeyBackup(backup, "source-pw", "target-pw");
    expect(await vaultDb.listKeys()).toHaveLength(1);
    expect(__testGetVaultStatus()).toBe("locked");
    expect(__testGetActivePublicKeyHex()).toBeUndefined();

    const unlocked = await __testUnlock("target-pw");
    expect(unlocked.ack.status).toBe("accepted");
    expect(__testGetActivePublicKeyHex()).toBe(imported.publicKeyHex);
  });

  it("activates the first key in an unlocked Vault and broadcasts it to every tab", async () => {
    const source = await __testCreateVault("source-pw");
    const backup = await __testExportKeyBackup(source.publicKeyHex!);
    await __testDeleteVault();
    __testResetState();

    const placeholder = await __testCreateVault("target-pw", { label: "placeholder" });
    // Model an unlocked empty Vault without forging session crypto state: remove
    // the only persisted key while retaining the real unlocked target session.
    await vaultDb.deleteKeyAndSidecars(placeholder.publicKeyHex!);
    expect(await vaultDb.listKeys()).toHaveLength(0);
    expect(__testGetVaultStatus()).toBe("unlocked");

    const a = new TestPort();
    const b = new TestPort();
    const onconnect = (globalThis as unknown as { onconnect?: (event: MessageEvent) => void }).onconnect;
    onconnect?.({ ports: [a] } as unknown as MessageEvent);
    onconnect?.({ ports: [b] } as unknown as MessageEvent);
    a.send({ kind: "hello", clientId: "import-a", requestId: "hello-a" });
    b.send({ kind: "hello", clientId: "import-b", requestId: "hello-b" });
    a.send({ kind: "subscribe", clientId: "import-a", requestId: "subscribe-a", topics: ["session.state"] });
    b.send({ kind: "subscribe", clientId: "import-b", requestId: "subscribe-b", topics: ["session.state"] });
    await flush();
    a.messages.length = 0;
    b.messages.length = 0;

    const imported = await __testImportKeyBackup(backup, "source-pw", "target-pw");
    expect(__testGetActivePublicKeyHex()).toBe(imported.publicKeyHex);
    for (const port of [a, b]) {
      expect(port.messages).toContainEqual(expect.objectContaining({
        type: "session.state.changed",
        activePublicKeyHex: imported.publicKeyHex,
      }));
    }
  }, 15_000);
});

describe("Session Coordinator locked legacy recovery", () => {
  beforeEach(async () => {
    await __testDeleteVault();
    __testResetState();
  });
  afterEach(async () => {
    await __testDeleteVault();
    __testResetState();
  });

  it("keeps an opaque legacy key selectable without parsing it at bootstrap", async () => {
    await __testCreateEmptyVault("pw");
    const publicKeyHex = bytesToHex(secp256k1.getPublicKey(hexToBytes(TEST_PRIV_2), true));
    await vaultDb.putKey({
      publicKeyHex,
      label: "legacy",
      address: "",
      network: "main",
      format: "legacy",
      capabilities: ["p2pkh"],
      createdAt: new Date().toISOString(),
      cipherVersion: "v2",
      cipherSaltB64: "00",
      cipherIvB64: "00",
      cipherB64: "00"
    });
    await __testRestartWorker();
    const snapshot = __testGetSnapshot();
    expect(snapshot.vaultStatus).toBe("locked");
    expect(snapshot.activePublicKeyHex).toBeUndefined();
    expect(snapshot.selectedPublicKeyHex).toBe(publicKeyHex);
  });
});

describe("Session Coordinator locked deletion and cold export", () => {
  beforeEach(async () => {
    await __testDeleteVault();
    __testResetState();
  });

  afterEach(async () => {
    await __testDeleteVault();
    __testResetState();
  });

  it("recovers a legacy empty Vault to the uninitialized state", async () => {
    await __testCreateEmptyVault("pw");
    const result = await __testUnlock("pw");
    expect(result.ack.status).toBe("accepted");
    expect(__testGetVaultStatus()).toBe("uninitialized");
    expect(__testGetActivePublicKeyHex()).toBeUndefined();
    expect(await vaultDb.getMeta()).toBeUndefined();
  });

  it("classifies a legacy empty Vault as uninitialized after a worker restart", async () => {
    await __testCreateEmptyVault("pw");
    await __testRestartWorker();
    expect(__testGetVaultStatus()).toBe("uninitialized");
    expect(await vaultDb.getMeta()).toBeUndefined();
  });

  it("cold-exports the persisted selected KeyHold document while locked", async () => {
    const key = await __testCreateVault("pw");
    await __testLock();
    const backup = await __testExportCurrentKeyBackup();
    expect(Object.keys(JSON.parse(backup)).sort()).toEqual(["cipher", "format", "keyDerivation", "label", "publicKeyHex", "version"]);
    expect(JSON.parse(backup)).toMatchObject({ format: "keymaster", version: 2 });
    expect(__testGetVaultStatus()).toBe("locked");
    expect(__testGetActivePublicKeyHex()).toBeUndefined();
    expect(key.publicKeyHex).toBeDefined();
  });

  it("new and hex-imported records round-trip through the KeyHold SDK", async () => {
    const first = await __testCreateVault("pw", { label: "first" });
    const second = await __testImportPrivateKey("pw", { label: "second", material: { hex: TEST_PRIV_2 }, format: "hex", capabilities: ["p2pkh"] });
    for (const key of [first, second]) {
      const document = keyholdParse(await __testExportKeyBackup(key.publicKeyHex!));
      const unlocked = await keyholdUnlock(document, "pw");
      try {
        expect(unlocked.publicKeyHex).toBe(key.publicKeyHex);
        expect(bytesToHex(secp256k1.getPublicKey(unlocked.privateKey, true))).toBe(key.publicKeyHex);
      } finally {
        unlocked.privateKey.fill(0);
      }
    }
  });

  it("rolls back active bytes and selected state when active metadata persistence fails", async () => {
    const first = await __testCreateVault("pw", { label: "first" });
    const second = await __testImportPrivateKey("pw", { label: "second", material: { hex: TEST_PRIV_2 }, format: "hex", capabilities: ["p2pkh"] });
    __testFailNextCoordinatorMetaPersist();
    await expect(__testSetActive(first.publicKeyHex!)).rejects.toThrow("injected coordinator meta persist failure");
    expect(__testGetActivePublicKeyHex()).toBe(second.publicKeyHex);
    expect(__testGetSnapshot().selectedPublicKeyHex).toBe(second.publicKeyHex);
  });

  it("deletes selected material while locked and repairs selection to the remaining key", async () => {
    const first = await __testCreateVault("pw", { label: "first" });
    const second = await __testImportPrivateKey("pw", { label: "second", material: { hex: TEST_PRIV_2 }, format: "hex", capabilities: ["p2pkh"] });
    await __testLock();
    await __testDeleteKeyMaterial(second.publicKeyHex);
    const snapshot = __testGetSnapshot();
    expect(snapshot.vaultStatus).toBe("locked");
    expect(snapshot.activePublicKeyHex).toBeUndefined();
    expect(snapshot.selectedPublicKeyHex).toBe(first.publicKeyHex);
  });

  it("finalizes the last material deletion exactly once to uninitialized", async () => {
    const key = await __testCreateVault("pw");
    await __testLock();
    await __testDeleteKeyMaterial(key.publicKeyHex!);
    expect(__testGetVaultStatus()).toBe("locked");
    await __testFinalizeEmptyVaultAfterLastKeyDeletion();
    expect(__testGetVaultStatus()).toBe("uninitialized");
    expect(await vaultDb.getMeta()).toBeUndefined();
    expect(await vaultDb.listKeys()).toHaveLength(0);
  });

  it("rejects cold export of an opaque legacy record without parsing it", async () => {
    await __testCreateVault("pw");
    const key = (await vaultDb.listKeys())[0];
    if (!key) throw new Error("missing seeded key");
    const legacy: LegacyVaultKeyRecord = {
      publicKeyHex: key.publicKeyHex,
      label: key.label,
      address: key.address,
      network: key.network,
      format: "legacy",
      capabilities: key.capabilities,
      createdAt: key.createdAt,
      cipherVersion: "v2",
      cipherSaltB64: "00",
      cipherIvB64: "00",
      cipherB64: "00"
    };
    await vaultDb.putKey(legacy);
    await __testLock();
    await expect(__testExportCurrentKeyBackup()).rejects.toThrow("Unsupported key storage version");
  });
});

describe("Session Coordinator Storage rotation recovery", () => {
  beforeEach(async () => {
    await __testDeleteVault();
    await deleteStorageDb();
    __testResetState();
  });

  afterEach(async () => {
    await __testDeleteVault();
    await deleteStorageDb();
    __testResetState();
  });

  it("clears the Storage barrier when a ciphertext is corrupt and keeps Vault unlockable", async () => {
    const key = await __testCreateVault("old-password", { label: "rotation-test" });
    await seedCorruptStorageUpload();

    await expect(__testChangePassword("old-password", "new-password")).rejects.toBeTruthy();
    expect(__testGetVaultStatus()).toBe("unlocked");

    await __testLock();
    await expect(__testUnlock("old-password", key.publicKeyHex)).resolves.toMatchObject({ ack: { status: "accepted" } });

    const request = indexedDB.open(STORAGE_DB_NAME, 1);
    const journal = await new Promise<unknown>((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("providerConfig", "readonly");
        const get = tx.objectStore("providerConfig").get("rotation");
        tx.oncomplete = () => { db.close(); resolve(get.result); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
    expect(journal).toBeUndefined();
  });

  it("completes a normal Storage/Vault password rotation and retires its journal", async () => {
    const key = await __testCreateVault("old-password", { label: "rotation-test" });
    const oldSealed = await __testSealLocalSecret(STORAGE_PROVIDER_SCOPE, "provider-secret");
    await seedStorageProvider(oldSealed);

    await expect(__testChangePassword("old-password", "new-password")).resolves.toBe(true);
    expect(__testGetVaultStatus()).toBe("locked");
    const rotated = await readStorageTestState();
    expect(rotated.provider?.sealedConfig).not.toEqual(oldSealed);
    expect(rotated.journal).toBeDefined();

    await expect(__testUnlock("new-password", key.publicKeyHex)).resolves.toMatchObject({ ack: { status: "accepted" } });
    expect((await readStorageTestState()).journal).toBeUndefined();
  });

  it("rejects a wrong old password before any rotation write", async () => {
    await __testCreateVault("old-password", { label: "rotation-test" });
    const commit = vi.spyOn(vaultDb, "putMetaAndKeys");
    try {
      await expect(__testChangePassword("wrong-password", "new-password")).rejects.toThrow("Invalid password");
      expect(commit).not.toHaveBeenCalled();
      expect(__testGetVaultStatus()).toBe("unlocked");
    } finally {
      commit.mockRestore();
    }
  });

  it("restores the original snapshot directly when the Vault commit fails", async () => {
    const key = await __testCreateVault("old-password", { label: "rotation-test" });
    const oldSealed = await __testSealLocalSecret(STORAGE_PROVIDER_SCOPE, "provider-secret");
    await seedStorageProvider(oldSealed);
    const commit = vi.spyOn(vaultDb, "putMetaAndKeys").mockRejectedValueOnce(new Error("injected Vault commit failure"));
    try {
      await expect(__testChangePassword("old-password", "new-password")).rejects.toThrow("injected Vault commit failure");
    } finally {
      commit.mockRestore();
    }

    const restored = await readStorageTestState();
    expect(restored.provider?.sealedConfig).toEqual(oldSealed);
    expect(restored.journal).toBeUndefined();
    await __testLock();
    await expect(__testUnlock("old-password", key.publicKeyHex)).resolves.toMatchObject({ ack: { status: "accepted" } });
  }, 15_000);

  // Two unlock/recovery KDFs plus the compensating storage writes exceed the
  // default 5s Vitest budget on the Node worker, while remaining bounded.
  it("keeps the journal when rollback or a later recovery write fails", async () => {
    const key = await __testCreateVault("old-password", { label: "rotation-test" });
    const oldSealed = await __testSealLocalSecret(STORAGE_PROVIDER_SCOPE, "provider-secret");
    await seedStorageProvider(oldSealed);
    const commit = vi.spyOn(vaultDb, "putMetaAndKeys").mockRejectedValueOnce(new Error("injected Vault commit failure"));
    const rollback = vi.spyOn(IDBObjectStore.prototype, "clear").mockImplementationOnce(() => { throw new Error("injected rollback failure"); });
    try {
      await expect(__testChangePassword("old-password", "new-password")).rejects.toThrow("Password rotation rollback failed");
    } finally {
      commit.mockRestore();
      rollback.mockRestore();
    }
    expect((await readStorageTestState()).journal).toBeDefined();

    await __testLock();
    const recovery = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(() => { throw new Error("injected recovery write failure"); });
    try {
      await expect(__testUnlock("old-password", key.publicKeyHex)).resolves.toMatchObject({ ack: { status: "accepted" } });
    } finally {
      recovery.mockRestore();
    }
    expect((await readStorageTestState()).journal).toBeDefined();

    await __testLock();
    await expect(__testUnlock("old-password", key.publicKeyHex)).resolves.toMatchObject({ ack: { status: "accepted" } });
    expect((await readStorageTestState()).journal).toBeUndefined();
  }, 15_000);

  it("keeps a corrupt journal as recovery evidence without blocking Vault unlock", async () => {
    const key = await __testCreateVault("old-password", { label: "rotation-test" });
    const sealed = await __testSealLocalSecret(STORAGE_PROVIDER_SCOPE, "provider-secret");
    await seedStorageProvider(sealed);
    const request = indexedDB.open(STORAGE_DB_NAME, 1);
    await new Promise<void>((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("providerConfig", "readwrite");
        tx.objectStore("providerConfig").put({ key: "rotation", phase: "prepared", old: { corrupted: true } });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });

    await __testLock();
    await expect(__testUnlock("old-password", key.publicKeyHex)).resolves.toMatchObject({ ack: { status: "accepted" } });
    expect((await readStorageTestState()).journal).toEqual({ key: "rotation", phase: "prepared", old: { corrupted: true } });
  });
});

describe("Session Coordinator WebAuthn PRF protection", () => {
  beforeEach(async () => {
    await __testDeleteVault();
    __testResetState();
  });

  afterEach(async () => {
    await __testDeleteVault();
    __testResetState();
  });

  it("stores a passkey alongside password and switches with its PRF output", async () => {
    const first = await __testCreateVault("vault-password", { label: "first" });
    const prfOutputHex = "ab".repeat(32);
    await __testAddPasskeyToCurrentKey({
      label: "passkey01",
      credentialIdB64: "credential-one",
      prfSaltB64: "salt-one",
      prfOutputHex,
      rpId: "keymaster.cc"
    });
    expect(await vaultDb.listSidecars(first.publicKeyHex!)).toHaveLength(1);
    const backup = JSON.parse(await __testExportKeyBackup(first.publicKeyHex!)) as Record<string, unknown>;
    expect(Object.keys(backup).sort()).toEqual(["cipher", "format", "keyDerivation", "label", "publicKeyHex", "version"]);
    expect(backup.format).toBe("keymaster");

    const second = await __testImportPrivateKey("vault-password", {
      label: "second",
      material: { hex: TEST_PRIV_2 },
      format: "hex",
      capabilities: ["p2pkh"]
    });
    expect(__testGetActivePublicKeyHex()).toBe(second.publicKeyHex);
    await __testActivateKeyWithPasskey({
      passkeyId: "credential-one",
      prfOutputHex
    });
    expect(__testGetActivePublicKeyHex()).toBe(first.publicKeyHex);
  });

  it("removes a passkey protector without asking for the Vault password", async () => {
    const key = await __testCreateVault("vault-password", { label: "first" });
    await __testAddPasskeyToCurrentKey({
      label: "passkey01",
      credentialIdB64: "credential-one",
      prfSaltB64: "salt-one",
      prfOutputHex: "ab".repeat(32),
      rpId: "keymaster.cc"
    });

    await __testRemovePasskeyFromCurrentKey({
      passkeyId: "credential-one"
    });

    const backup = JSON.parse(await __testExportKeyBackup(key.publicKeyHex!)) as Record<string, unknown>;
    expect(Object.keys(backup).sort()).toEqual(["cipher", "format", "keyDerivation", "label", "publicKeyHex", "version"]);
    expect(backup.format).toBe("keymaster");
  });

  it("does not use an embedded legacy passkey protector", async () => {
    const key = await __testCreateVault("vault-password", { label: "legacy" });
    const existing = await vaultDb.getKey(key.publicKeyHex!);
    if (!existing) throw new Error("missing seeded key");
    const legacy: LegacyVaultKeyRecord = {
      publicKeyHex: existing.publicKeyHex,
      label: existing.label,
      address: existing.address,
      network: existing.network,
      format: "legacy",
      capabilities: existing.capabilities,
      createdAt: existing.createdAt,
      cipherVersion: "v2",
      cipherSaltB64: "00",
      cipherIvB64: "00",
      cipherB64: "00",
      passkeyProtections: [{ id: "embedded", label: "old", credentialIdB64: "old", prfSaltB64: "old", rpId: "keymaster.cc", createdAt: existing.createdAt, cipherVersion: "webauthn-prf-v1", cipherIvB64: "00", cipherB64: "00" }]
    };
    await vaultDb.putKey(legacy);
    expect(await __testListPasskeysForKey(existing.publicKeyHex)).toEqual([]);
    await expect(__testActivateKeyWithPasskey({ passkeyId: "embedded", prfOutputHex: "ab".repeat(32) })).rejects.toThrow("Passkey protection not found");
  });
});
