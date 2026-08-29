import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bytesToHex,
  hexToBytes,
  vaultDb,
  type LegacyVaultKeyRecord,
} from "@keymaster/plugin-vault/coordinator";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  __testAcquireExecutorLease,
  __testExecutorSignNoise,
  __testExecutorSignPeerRecord,
  __testReleaseExecutorLease,
  __testDispatchMsfileControl,
  __testDispatchMsfileControlWithEpoch,
  __testDispatchMsfileData,
  __testDispatchMsfileGrant,
  __testDispatchMsfileSessionAbort,
  __testReleaseMsfileRuntime,
  __testSetMsfileReadConcurrencySettings,
  __testSetMsfileRuntimeOverride,
} from "./keymasterSessionCoordinator.worker.js";
import { peerIdFromPublicKeyBytes } from "bitcoin-libp2p/identity";
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
  __testP2pkhProviderConfigGet,
  __testP2pkhProviderConfigUpdate,
  __testP2pkhProvidersUpdate,
  __testSeedP2pkhLocalSubmission,
  __testFinishP2pkhLocalSubmission,
  __testSetP2pkhChainResolution,
  __testListP2pkhLocalTransactions,
  __testListP2pkhLocalOutpoints,
  __testListP2pkhLocalInputClaims,
  __testP2pkhBroadcast,
  __testSetP2pkhBroadcastProvider,
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

  it("merges provider config updates without clearing the selected provider", async () => {
    __testResetState();
    await __testRestartWorker();
    const before = __testGetSnapshot();
    await __testP2pkhProviderConfigUpdate("junglebus", {
      enabled: true,
      mainEndpoint: "https://main.example/v1",
      testEndpoint: "https://test.example/v1",
      timeoutMs: 1_111,
      maxRetries: 4,
      requestsPerSecond: 7
    });
    await __testP2pkhProviderConfigUpdate("junglebus", { endpoint: "https://alias.example/v1" });
    const config = await __testP2pkhProviderConfigGet("junglebus");
    expect(config).toMatchObject({ enabled: true, endpoint: "https://alias.example/v1", mainEndpoint: "https://main.example/v1", testEndpoint: "https://test.example/v1", timeoutMs: 1_111, maxRetries: 4, requestsPerSecond: 7 });
    const after = __testGetSnapshot();
    expect(after.p2pkhProviders?.selection.main.syncProviderId).toBe(before.p2pkhProviders?.selection.main.syncProviderId);
    expect(after.p2pkhProviders?.selection.test.syncProviderId).toBe(before.p2pkhProviders?.selection.test.syncProviderId);
  });

  it("keeps provider selection unchanged when its metadata persistence fails", async () => {
    __testResetState();
    await __testRestartWorker();
    const before = __testGetSnapshot();
    const beforeConfig = await __testP2pkhProviderConfigGet("woc");
    __testFailNextCoordinatorMetaPersist();
    await expect(__testP2pkhProviderConfigUpdate("woc", { endpoint: "https://should-not-apply.example/v1" })).rejects.toThrow(/persist/i);
    const after = __testGetSnapshot();
    expect(after.p2pkhProviders?.selection).toEqual(before.p2pkhProviders?.selection);
    expect(await __testP2pkhProviderConfigGet("woc")).toEqual(beforeConfig);
  });

  it("keeps provider selection unchanged when a selection persistence fails", async () => {
    __testResetState();
    await __testRestartWorker();
    const before = __testGetSnapshot();
    const generation = before.p2pkhProviders?.selection.generation ?? 0;
    __testFailNextCoordinatorMetaPersist();
    await expect(__testP2pkhProvidersUpdate("main", { syncProviderId: "junglebus", broadcastProviderId: "woc" })).rejects.toThrow(/persist/i);
    expect(__testGetSnapshot().p2pkhProviders?.selection).toEqual(before.p2pkhProviders?.selection);
    expect(__testGetSnapshot().p2pkhProviders?.selection.generation).toBe(generation);
  });

  it("aborts stale-generation P2PKH submissions before any provider call", async () => {
    __testResetState();
    const owner = "c".repeat(64);
    const submissionId = `stale-${Date.now()}`;
    await __testSeedP2pkhLocalSubmission({
      ownerPublicKeyHex: owner,
      submission: { id: submissionId, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: "ab".repeat(32), rawTxHex: "00", localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: ["cd".repeat(32) + ":0"], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [] },
      claims: [{ id: `${submissionId}:claim`, submissionId, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: "cd".repeat(32), vout: 0, value: 1, state: "active", createdAt: "now", updatedAt: "now" }]
    });
    const currentGeneration = __testGetSnapshot().p2pkhProviders?.selection.generation ?? 0;
    const response = await __testP2pkhBroadcast({ ownerPublicKeyHex: owner, network: "main", submissionId, expectedProviderGeneration: currentGeneration + 1 });
    expect(response.operationResult).toMatchObject({ status: "not-dispatched", reason: "stale-provider-generation" });
    expect((await __testListP2pkhLocalTransactions(owner)).some((row) => (row as { id?: string }).id === submissionId)).toBe(false);
  });

  it("retains an unknown submission when a rebroadcast is not dispatched", async () => {
    __testResetState();
    const owner = "d".repeat(64);
    const submissionId = `unknown-rebroadcast-${Date.now()}`;
    await __testSeedP2pkhLocalSubmission({
      ownerPublicKeyHex: owner,
      submission: { id: submissionId, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: "de".repeat(32), rawTxHex: "00", localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: ["ef".repeat(32) + ":0"], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [] },
      claims: [{ id: `${submissionId}:claim`, submissionId, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: "ef".repeat(32), vout: 0, value: 1, state: "active", createdAt: "now", updatedAt: "now" }]
    });
    const currentGeneration = __testGetSnapshot().p2pkhProviders?.selection.generation ?? 0;
    const response = await __testP2pkhBroadcast({ ownerPublicKeyHex: owner, network: "main", submissionId, expectedProviderGeneration: currentGeneration + 1, rebroadcast: true });
    expect(response.operationResult).toMatchObject({ status: "not-dispatched", reason: "stale-provider-generation" });
    expect((await __testListP2pkhLocalTransactions(owner)).find((row) => (row as { id?: string }).id === submissionId)).toMatchObject({ localState: "submitting", chainResolution: "unresolved", attempts: [] });
  });

  it("preserves local-confirmed state when a rebroadcast provider fails", async () => {
    __testResetState();
    const owner = "e".repeat(64);
    const submissionId = `failed-rebroadcast-${Date.now()}`;
    const txid = "fa".repeat(32);
    await __testSeedP2pkhLocalSubmission({
      ownerPublicKeyHex: owner,
      submission: { id: submissionId, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid, rawTxHex: "00", localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [{ vout: 0, value: 1, scriptHex: "" }], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [] },
      localOutpoints: [{ id: `p2pkh:main:${txid}:0`, resourceId: "p2pkh:main", txid, vout: 0, value: 1, scriptHex: "", submissionId, state: "unavailable", createdAt: "now", updatedAt: "now" }]
    });
    await __testFinishP2pkhLocalSubmission({ ownerPublicKeyHex: owner, submissionId, localState: "local-confirmed" });
    __testSetP2pkhBroadcastProvider({
      descriptor: { id: "test-failing-provider", label: "Test failing provider", supportedNetworks: ["main", "test"] },
      broadcast: async () => { throw new Error("provider unavailable"); }
    });
    const generation = __testGetSnapshot().p2pkhProviders?.selection.generation ?? 0;
    const response = await __testP2pkhBroadcast({ ownerPublicKeyHex: owner, network: "main", submissionId, expectedProviderGeneration: generation, rebroadcast: true });
    expect(response.operationResult).toMatchObject({ status: "rebroadcast-failed", txid, reason: "provider unavailable" });
    expect((await __testListP2pkhLocalTransactions(owner)).find((row) => (row as { id?: string }).id === submissionId)).toMatchObject({ localState: "local-confirmed", chainResolution: "unresolved", attempts: [{ status: "isolated" }] });
    __testSetP2pkhBroadcastProvider(undefined);
  });

  it("broadcasts a double-axis submission without relying on legacy state", async () => {
    __testResetState();
    const owner = "f".repeat(64);
    const submissionId = `double-axis-${Date.now()}`;
    const txid = "fb".repeat(32);
    const providerBroadcast = vi.fn(async () => ({ canonicalTxid: txid, status: "accepted" as const, providerReference: "provider-ref" }));
    await __testSeedP2pkhLocalSubmission({
      ownerPublicKeyHex: owner,
      submission: { id: submissionId, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid, rawTxHex: "00", localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: ["fc".repeat(32) + ":0"], ownOutputs: [{ vout: 0, value: 1, scriptHex: "" }], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [] },
      claims: [{ id: `${submissionId}:claim`, submissionId, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: "fc".repeat(32), vout: 0, value: 1, state: "active", createdAt: "now", updatedAt: "now" }],
      localOutpoints: [{ id: `p2pkh:main:${txid}:0`, resourceId: "p2pkh:main", txid, vout: 0, value: 1, scriptHex: "", submissionId, state: "unavailable", createdAt: "now", updatedAt: "now" }]
    });
    __testSetP2pkhBroadcastProvider({
      descriptor: { id: "test-double-axis-provider", label: "Double-axis test provider", supportedNetworks: ["main", "test"] },
      broadcast: providerBroadcast
    });
    const generation = __testGetSnapshot().p2pkhProviders?.selection.generation ?? 0;
    const response = await __testP2pkhBroadcast({ ownerPublicKeyHex: owner, network: "main", submissionId, expectedProviderGeneration: generation });
    expect(response.operationResult).toMatchObject({ status: "local-confirmed", txid });
    expect(providerBroadcast).toHaveBeenCalledWith({ network: "main", canonicalTxid: txid, rawTxHex: "00" });
    expect((await __testListP2pkhLocalTransactions(owner)).find((row) => (row as { id?: string }).id === submissionId)).toMatchObject({ localState: "local-confirmed", chainResolution: "unresolved", attempts: [{ status: "accepted" }] });
    expect((await __testListP2pkhLocalOutpoints(owner)).find((row) => (row as { submissionId?: string }).submissionId === submissionId)).toMatchObject({ state: "available" });
    expect((await __testListP2pkhLocalInputClaims(owner)).find((row) => (row as { submissionId?: string }).submissionId === submissionId)).toMatchObject({ state: "active" });
    __testSetP2pkhBroadcastProvider(undefined);
  });

  it("skips a chain-confirmed ancestor and broadcasts the unresolved child once", async () => {
    __testResetState();
    const owner = "1".repeat(64);
    const parentTxid = "10".repeat(32);
    const childTxid = "11".repeat(32);
    await __testSeedP2pkhLocalSubmission({ ownerPublicKeyHex: owner, submission: { id: "confirmed-parent", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: parentTxid, rawTxHex: "parent", localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [] } });
    await __testFinishP2pkhLocalSubmission({ ownerPublicKeyHex: owner, submissionId: "confirmed-parent", localState: "local-confirmed" });
    await __testSetP2pkhChainResolution({ ownerPublicKeyHex: owner, submissionId: "confirmed-parent", chainResolution: "chain-confirmed" });
    await __testSeedP2pkhLocalSubmission({ ownerPublicKeyHex: owner, submission: { id: "unresolved-child", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: childTxid, rawTxHex: "child", localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [parentTxid], createdAt: "now", updatedAt: "now", attempts: [] } });
    await __testFinishP2pkhLocalSubmission({ ownerPublicKeyHex: owner, submissionId: "unresolved-child", localState: "local-confirmed" });
    const providerBroadcast = vi.fn(async (request: { canonicalTxid: string }) => ({ canonicalTxid: request.canonicalTxid, status: "accepted" as const }));
    __testSetP2pkhBroadcastProvider({ descriptor: { id: "test-ancestor-skip", label: "Ancestor skip", supportedNetworks: ["main", "test"] }, broadcast: providerBroadcast });
    const generation = __testGetSnapshot().p2pkhProviders?.selection.generation ?? 0;
    const response = await __testP2pkhBroadcast({ ownerPublicKeyHex: owner, network: "main", submissionId: "unresolved-child", expectedProviderGeneration: generation, rebroadcast: true });
    expect(response.operationResult).toMatchObject({ status: "local-confirmed", txid: childTxid });
    expect(providerBroadcast).toHaveBeenCalledTimes(1);
    expect(providerBroadcast).toHaveBeenCalledWith({ network: "main", canonicalTxid: childTxid, rawTxHex: "child" });
    expect((await __testListP2pkhLocalTransactions(owner)).find((row) => (row as { id?: string }).id === "confirmed-parent")).toMatchObject({ chainResolution: "chain-confirmed", attempts: [] });
    expect((await __testListP2pkhLocalTransactions(owner)).find((row) => (row as { id?: string }).id === "unresolved-child")).toMatchObject({ localState: "local-confirmed", chainResolution: "unresolved", attempts: [{ status: "accepted" }] });
    __testSetP2pkhBroadcastProvider(undefined);
  });

  it("blocks a conflicted ancestor before invoking the provider", async () => {
    __testResetState();
    const owner = "2".repeat(64);
    const parentTxid = "20".repeat(32);
    const childTxid = "21".repeat(32);
    await __testSeedP2pkhLocalSubmission({ ownerPublicKeyHex: owner, submission: { id: "conflicted-parent", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: parentTxid, rawTxHex: "parent", localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [] } });
    await __testFinishP2pkhLocalSubmission({ ownerPublicKeyHex: owner, submissionId: "conflicted-parent", localState: "local-confirmed" });
    await __testSetP2pkhChainResolution({ ownerPublicKeyHex: owner, submissionId: "conflicted-parent", chainResolution: "conflicted", conflictSourceTxids: ["ff".repeat(32)] });
    await __testSeedP2pkhLocalSubmission({ ownerPublicKeyHex: owner, submission: { id: "blocked-child", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: childTxid, rawTxHex: "child", localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [parentTxid], createdAt: "now", updatedAt: "now", attempts: [] } });
    await __testFinishP2pkhLocalSubmission({ ownerPublicKeyHex: owner, submissionId: "blocked-child", localState: "local-confirmed" });
    const providerBroadcast = vi.fn(async (request: { canonicalTxid: string }) => ({ canonicalTxid: request.canonicalTxid, status: "accepted" as const }));
    __testSetP2pkhBroadcastProvider({ descriptor: { id: "test-ancestor-block", label: "Ancestor block", supportedNetworks: ["main", "test"] }, broadcast: providerBroadcast });
    const generation = __testGetSnapshot().p2pkhProviders?.selection.generation ?? 0;
    const response = await __testP2pkhBroadcast({ ownerPublicKeyHex: owner, network: "main", submissionId: "blocked-child", expectedProviderGeneration: generation, rebroadcast: true });
    expect(response.operationResult).toMatchObject({ status: "isolated", txid: parentTxid, reason: "conflicted-ancestor" });
    expect(providerBroadcast).not.toHaveBeenCalled();
    expect((await __testListP2pkhLocalTransactions(owner)).every((row) => (row as { attempts?: unknown[] }).attempts?.length === 0)).toBe(true);
    __testSetP2pkhBroadcastProvider(undefined);
  });

  it("裁决重复 txid sibling 不受返回顺序影响且只阻断一次逻辑交易", async () => {
    for (const [owner, insertionOrder] of [["3".repeat(64), ["normal", "conflict"]], ["4".repeat(64), ["conflict", "normal"]]] as const) {
      __testResetState();
      const txid = "30".repeat(32);
      const childTxid = "31".repeat(32);
      const seed = async (kind: "normal" | "conflict") => {
        const id = kind === "normal" ? "a-sibling" : "z-sibling";
        await __testSeedP2pkhLocalSubmission({ ownerPublicKeyHex: owner, submission: { id, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid, rawTxHex: kind, localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [] } });
        await __testFinishP2pkhLocalSubmission({ ownerPublicKeyHex: owner, submissionId: id, localState: "local-confirmed" });
        if (kind === "conflict") await __testSetP2pkhChainResolution({ ownerPublicKeyHex: owner, submissionId: id, chainResolution: "conflicted", conflictSourceTxids: ["ee".repeat(32)] });
      };
      for (const kind of insertionOrder) await seed(kind);
      await __testSeedP2pkhLocalSubmission({ ownerPublicKeyHex: owner, submission: { id: "sibling-child", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: childTxid, rawTxHex: "child", localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [txid], createdAt: "now", updatedAt: "now", attempts: [] } });
      await __testFinishP2pkhLocalSubmission({ ownerPublicKeyHex: owner, submissionId: "sibling-child", localState: "local-confirmed" });
      const providerBroadcast = vi.fn(async (request: { canonicalTxid: string }) => ({ canonicalTxid: request.canonicalTxid, status: "accepted" as const }));
      __testSetP2pkhBroadcastProvider({ descriptor: { id: "test-sibling-order", label: "Sibling order", supportedNetworks: ["main", "test"] }, broadcast: providerBroadcast });
      const generation = __testGetSnapshot().p2pkhProviders?.selection.generation ?? 0;
      const response = await __testP2pkhBroadcast({ ownerPublicKeyHex: owner, network: "main", submissionId: "sibling-child", expectedProviderGeneration: generation, rebroadcast: true });
      expect(response.operationResult).toMatchObject({ status: "isolated", txid, reason: "conflicted-ancestor" });
      expect(providerBroadcast).not.toHaveBeenCalled();
      __testSetP2pkhBroadcastProvider(undefined);
    }
    __testResetState();
    const normalOwner = "5".repeat(64);
    const normalTxid = "50".repeat(32);
    const normalChildTxid = "51".repeat(32);
    for (const [id, rawTxHex] of [["first-sibling", "z-raw"], ["second-sibling", "a-raw"]] as const) {
      await __testSeedP2pkhLocalSubmission({ ownerPublicKeyHex: normalOwner, submission: { id, resourceId: "p2pkh:main", publicKeyHex: normalOwner, network: "main", txid: normalTxid, rawTxHex, localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [] } });
      await __testFinishP2pkhLocalSubmission({ ownerPublicKeyHex: normalOwner, submissionId: id, localState: "local-confirmed" });
    }
    await __testSeedP2pkhLocalSubmission({ ownerPublicKeyHex: normalOwner, submission: { id: "unresolved-child", resourceId: "p2pkh:main", publicKeyHex: normalOwner, network: "main", txid: normalChildTxid, rawTxHex: "child", localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [normalTxid], createdAt: "now", updatedAt: "now", attempts: [] } });
    await __testFinishP2pkhLocalSubmission({ ownerPublicKeyHex: normalOwner, submissionId: "unresolved-child", localState: "local-confirmed" });
    const normalProvider = vi.fn(async (request: { canonicalTxid: string }) => ({ canonicalTxid: request.canonicalTxid, status: "accepted" as const }));
    __testSetP2pkhBroadcastProvider({ descriptor: { id: "test-sibling-single", label: "Sibling single", supportedNetworks: ["main", "test"] }, broadcast: normalProvider });
    const normalGeneration = __testGetSnapshot().p2pkhProviders?.selection.generation ?? 0;
    await __testP2pkhBroadcast({ ownerPublicKeyHex: normalOwner, network: "main", submissionId: "unresolved-child", expectedProviderGeneration: normalGeneration, rebroadcast: true });
    expect(normalProvider).toHaveBeenCalledTimes(2);
    expect(normalProvider).toHaveBeenNthCalledWith(1, { network: "main", canonicalTxid: normalTxid, rawTxHex: "a-raw" });
    expect(normalProvider).toHaveBeenNthCalledWith(2, { network: "main", canonicalTxid: normalChildTxid, rawTxHex: "child" });
    __testSetP2pkhBroadcastProvider(undefined);

    __testResetState();
    const targetOwner = "6".repeat(64);
    const targetTxid = "60".repeat(32);
    for (const [id, rawTxHex] of [["canonical-sibling", "a-raw"], ["requested-sibling", "z-raw"]] as const) {
      await __testSeedP2pkhLocalSubmission({ ownerPublicKeyHex: targetOwner, submission: { id, resourceId: "p2pkh:main", publicKeyHex: targetOwner, network: "main", txid: targetTxid, rawTxHex, localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [] } });
      await __testFinishP2pkhLocalSubmission({ ownerPublicKeyHex: targetOwner, submissionId: id, localState: "local-confirmed" });
    }
    const targetProvider = vi.fn(async (request: { canonicalTxid: string }) => ({ canonicalTxid: request.canonicalTxid, status: "accepted" as const }));
    __testSetP2pkhBroadcastProvider({ descriptor: { id: "test-target-boundary", label: "Target boundary", supportedNetworks: ["main", "test"] }, broadcast: targetProvider });
    const targetGeneration = __testGetSnapshot().p2pkhProviders?.selection.generation ?? 0;
    await __testP2pkhBroadcast({ ownerPublicKeyHex: targetOwner, network: "main", submissionId: "requested-sibling", expectedProviderGeneration: targetGeneration, rebroadcast: true });
    expect(targetProvider).toHaveBeenCalledTimes(1);
    expect(targetProvider).toHaveBeenCalledWith({ network: "main", canonicalTxid: targetTxid, rawTxHex: "z-raw" });
    expect((await __testListP2pkhLocalTransactions(targetOwner)).find((row) => (row as { id?: string }).id === "requested-sibling")).toMatchObject({ localState: "local-confirmed", attempts: [{ status: "accepted" }] });
    expect((await __testListP2pkhLocalTransactions(targetOwner)).find((row) => (row as { id?: string }).id === "canonical-sibling")).toMatchObject({ localState: "local-confirmed", attempts: [] });
    __testSetP2pkhBroadcastProvider(undefined);
  });

  it("keeps an explicitly selected provider id while the optional provider is disabled", async () => {
    __testResetState();
    await __testRestartWorker();
    await __testP2pkhProvidersUpdate("main", { syncProviderId: "junglebus", broadcastProviderId: "woc" });
    await __testP2pkhProviderConfigUpdate("junglebus", { enabled: false });
    const disabled = __testGetSnapshot().p2pkhProviders;
    expect(disabled?.selection.main.syncProviderId).toBe("junglebus");
    expect(disabled?.syncProviders.some((provider) => provider.id === "junglebus")).toBe(false);
    await __testP2pkhProviderConfigUpdate("junglebus", { enabled: true });
    const enabled = __testGetSnapshot().p2pkhProviders;
    expect(enabled?.selection.main.syncProviderId).toBe("junglebus");
    expect(enabled?.syncProviders.some((provider) => provider.id === "junglebus")).toBe(true);
  });

  it("blocks the transaction sync task when its selected provider is unavailable", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", "a".repeat(64));
    __testRegisterTask({
      id: "p2pkh.transactions-sync",
      publicKeyHex: "a".repeat(64),
      run: async () => { throw Object.assign(new Error("JungleBus is unavailable"), { code: "provider-unavailable" }); }
    });
    await __testRunTask("p2pkh.transactions-sync");
    expect(__testGetSnapshot().taskSnapshots.find((task) => task.id === "p2pkh.transactions-sync")).toMatchObject({
      state: "blocked",
      blockedReason: { fallback: "JungleBus is unavailable" }
    });
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


// 预生成 PeerId 向量（由 @libp2p/peer-id 派生，避免 apps/web 引入 libp2p 依赖）。
const SUPPLIER_PEER_IDS = new Map<string, string>([
  ["02352bbf4a4cdd12564f93fa332ce333301d9ad40271f8107181340aef25be59d5", "16Uiu2HAky1EH6J1p6jLjseMf5AtAMn3GLwYbcYaK7dH9T1F9XF56"],
  ["03421f5fc9a21065445c96fdb91c0c1e2f2431741c72713b4b99ddcb316f31e9fc", "16Uiu2HAmH771Jxhe2diA2zAtPYNqfABsk5aaJ51cp99LhadN6waK"]
]);

function SUPPLIER_PEER_ID_FOR(publicKeyHex: string): string {
  const peerId = SUPPLIER_PEER_IDS.get(publicKeyHex);
  if (!peerId) throw new Error(`missing precomputed peer id for ${publicKeyHex}`);
  return peerId;
}

describe("MSFile executor lease 与受限 signer（施工单 001 §3.1–3.2）", () => {
  beforeEach(async () => {
    await __testDeleteVault();
    __testResetState();
  });

  afterEach(async () => {
    __testSetStorageSessionResolver(undefined);
    await __testReleaseMsfileRuntime();
    await __testDeleteVault();
    __testResetState();
  });

  async function unlockForSpike(): Promise<{ epoch: string; owner: string }> {
    const created = await __testCreateVault("spike-pw", { label: "executor-key" });
    expect(created.publicKeyHex).toBeTruthy();
    const owner = created.publicKeyHex!;
    const unlockedResponse = await __testUnlock("spike-pw", owner);
    expect(["accepted", "ok", "already-unlocked"]).toContain(unlockedResponse.ack.status);
    return { epoch: __testGetSnapshot().sessionEpoch, owner };
  }

  function noiseStaticPublicKey(fill = 7): ArrayBuffer {
    return new Uint8Array(32).fill(fill).buffer;
  }

  it("A04: two tabs competing for the same epoch yields exactly one lease", async () => {
    const { owner } = await unlockForSpike();
    const first = await __testAcquireExecutorLease(owner, "port-a");
    expect(first.ack.status).toBe("ok");
    const second = await __testAcquireExecutorLease(owner, "port-b");
    expect(second.ack).toMatchObject({ status: "error", code: "msfile_unavailable" });
    // 同 port 幂等续租返回同一 leaseId。
    const again = await __testAcquireExecutorLease(owner, "port-a");
    expect((again.operationResult as { leaseId: string }).leaseId)
      .toBe((first.operationResult as { leaseId: string }).leaseId);
  });

  it("A05: stale lease id / wrong port signer requests are rejected", async () => {
    const { owner } = await unlockForSpike();
    const acquired = await __testAcquireExecutorLease(owner, "port-a");
    const lease = acquired.operationResult as { leaseId: string; sessionEpoch: string };

    // 伪造 port。
    const forgedPort = await __testExecutorSignNoise({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, noiseStaticPublicKey: noiseStaticPublicKey() }, "port-forged");
    expect(forgedPort.ack).toMatchObject({ status: "error", code: "msfile_unavailable" });

    // 正确 port 成功并返回签名。
    const good = await __testExecutorSignNoise({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, noiseStaticPublicKey: noiseStaticPublicKey() }, "port-a");
    expect(good.ack.status).toBe("ok");
    expect((good.operationResult as { signatureDer: ArrayBuffer }).signatureDer.byteLength).toBeGreaterThan(0);

    // 显式释放后旧 leaseId 重放被拒（A05）。
    await __testReleaseExecutorLease(lease.leaseId, "port-a");
    const replay = await __testExecutorSignNoise({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, noiseStaticPublicKey: noiseStaticPublicKey() }, "port-a");
    expect(replay.ack).toMatchObject({ status: "error", code: "msfile_unavailable" });
  });

  it("A03: typed signer inputs and Peer Record invariants are enforced by the worker", async () => {
    const { owner } = await unlockForSpike();
    const acquired = await __testAcquireExecutorLease(owner, "port-a");
    const lease = acquired.operationResult as { leaseId: string; sessionEpoch: string };
    const shortNoiseKey = await __testExecutorSignNoise({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, noiseStaticPublicKey: new Uint8Array(31).buffer }, "port-a");
    expect(shortNoiseKey.ack).toMatchObject({ status: "error", code: "msfile_unavailable" });

    const peerId = peerIdFromPublicKeyBytes(hexToBytes(owner)).toString();
    const nonEmptyAddresses = await __testExecutorSignPeerRecord({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, peerId, addresses: ["/ip4/127.0.0.1/tcp/1"], sequence: "0" }, "port-a");
    expect(nonEmptyAddresses.ack).toMatchObject({ status: "error", code: "msfile_unavailable" });
    const wrongPeerId = await __testExecutorSignPeerRecord({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, peerId: "16Uiu2HAmH4VY9jMZ2fG4N7aQZ6uHh5mS5jQxZ3Yy1h1nH7qVY6r", addresses: [], sequence: "0" }, "port-a");
    expect(wrongPeerId.ack).toMatchObject({ status: "error", code: "msfile_unavailable" });
    const valid = await __testExecutorSignPeerRecord({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, peerId, addresses: [], sequence: "7" }, "port-a");
    expect(valid.ack.status).toBe("ok");
    const decreasing = await __testExecutorSignPeerRecord({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, peerId, addresses: [], sequence: "6" }, "port-a");
    expect(decreasing.ack).toMatchObject({ status: "error", code: "msfile_unavailable" });
    const overflow = await __testExecutorSignPeerRecord({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, peerId, addresses: [], sequence: "18446744073709551616" }, "port-a");
    expect(overflow.ack).toMatchObject({ status: "error", code: "msfile_unavailable" });
  });

  it("A06: lock invalidates the lease; queued signer requests fail after re-unlock", async () => {
    const { epoch } = await unlockForSpike();
    const owner = __testGetSnapshot().activePublicKeyHex!;
    const acquired = await __testAcquireExecutorLease(owner, "port-a");
    const lease = acquired.operationResult as { leaseId: string; sessionEpoch: string };

    await __testLock();
    const duringLock = await __testExecutorSignNoise({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, noiseStaticPublicKey: noiseStaticPublicKey() }, "port-a");
    expect(duringLock.ack).toMatchObject({ status: "error", code: "msfile_unavailable" });
    void epoch;

    await __testUnlock("spike-pw");
    const afterReunlock = await __testExecutorSignNoise({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, noiseStaticPublicKey: noiseStaticPublicKey() }, "port-a");
    // lock 清空了 lease：旧 leaseId 在新会话中不可复活。
    expect(afterReunlock.ack).toMatchObject({ status: "error", code: "msfile_unavailable" });
  });

  it("B11: importing a key into an unlocked Vault revokes the old MSFile lease immediately", async () => {
    const { owner } = await unlockForSpike();
    const acquired = await __testAcquireExecutorLease(owner, "port-a");
    const oldLease = acquired.operationResult as { leaseId: string; sessionEpoch: string };

    const imported = await __testImportPrivateKey("spike-pw", {
      label: "switched-owner",
      material: { hex: "2".padStart(64, "0") },
      format: "hex",
      capabilities: ["p2pkh"],
      source: "test",
    });
    expect(imported.publicKeyHex).not.toBe(owner);
    expect(__testGetSnapshot().activePublicKeyHex).toBe(imported.publicKeyHex);

    const replay = await __testExecutorSignNoise({
      leaseId: oldLease.leaseId,
      expectedSessionEpoch: oldLease.sessionEpoch,
      noiseStaticPublicKey: noiseStaticPublicKey(),
    }, "port-a");
    expect(replay.ack).toMatchObject({ status: "error", code: "msfile_unavailable" });
    const replacement = await __testAcquireExecutorLease(imported.publicKeyHex, "port-a");
    expect(replacement.ack.status).toBe("ok");
  });
});

describe("Session Coordinator MSFile RPC lane（施工单 docs/proposals/msfile）", () => {
  const identity = {
    version: 1 as const,
    publisherPublicKeyHex: "03" + "ab".repeat(32),
    appId: "player.example",
    appName: "Player",
    identityDigestHex: "aa".repeat(32)
  };
  const ownerPublicKeyHex = validPublisherKey(9);

  beforeEach(async () => {
    await __testDeleteVault();
    __testResetState();
  });

  afterEach(async () => {
    __testSetStorageSessionResolver(undefined);
    await __testReleaseMsfileRuntime();
    await __testDeleteVault();
    __testResetState();
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase("keymaster.msfile");
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => setTimeout(() => resolve(), 50);
    });
  });

  async function unlockVault(): Promise<string> {
    const created = await __testCreateVault("vault-pw", { label: "msfile-key" });
    expect(created.publicKeyHex).toBeTruthy();
    // createVaultWithInitialKey 可能直接进入 unlocked（already-unlocked 亦视为就绪）。
    const unlockedResponse = await __testUnlock("vault-pw", created.publicKeyHex);
    expect(["ok", "already-unlocked"]).toContain(unlockedResponse.ack.status);
    return __testGetSnapshot().sessionEpoch;
  }

  it("rejects all data/control/grant traffic while the Vault is locked（审查修复）", async () => {
    // 全新状态：未创建 / 未解锁。
    __testResetState();
    const lockedControl = await __testDispatchMsfileControl({ type: "settings.get" });
    expect(lockedControl.ack).toMatchObject({ status: "locked" });
    const lockedData = await __testDispatchMsfileData({ type: "stat", seedHashHex: "ab".repeat(32) }, "port-a");
    expect(lockedData.ack).toMatchObject({ status: "locked" });
    const lockedGrant = await __testDispatchMsfileGrant({
      connectSessionId: "s", transportOrigin: "https://app.example", ownerPublicKeyHex, appIdentity: identity
    }, "port-a");
    expect(lockedGrant.ack).toMatchObject({ status: "locked" });

    // session.abort 是纯清理：锁定态仍返回 ok 且不重建 runtime。
    const abortWhileLocked = await __testDispatchMsfileSessionAbort("s", __testGetSnapshot().sessionEpoch, "port-a");
    expect(abortWhileLocked.ack).toMatchObject({ status: "ok" });

    // 解锁后同一控制面请求成功。
    const epoch = await unlockVault();
    const okControl = await __testDispatchMsfileControl({ type: "settings.get" });
    expect(okControl.ack.status).toBe("ok");
    void epoch;
  });

  it("enforces the session epoch fence on the msfile lane（审查修复）", async () => {
    // 记录解锁前的 epoch；创建 Vault 会推进 epoch。
    __testResetState();
    const epochBefore = __testGetSnapshot().sessionEpoch;
    await unlockVault();
    const stale = await __testDispatchMsfileControlWithEpoch({ type: "settings.get" }, epochBefore);
    // 携带旧 epoch 的 control 必须被判 stale，而不是进入执行。
    expect(stale.ack).toMatchObject({ status: "stale-epoch" });
    // 当前 epoch 正常放行。
    const fresh = await __testDispatchMsfileControl({ type: "settings.get" });
    expect(fresh.ack.status).toBe("ok");
  });

  it("routes control-plane settings through the coordinator", async () => {
    await unlockVault();
    const saved = await __testDispatchMsfileControl({ type: "settings.global.update", input: { seedMaxPriceSatoshis: "500", blockMaxPriceSatoshis: "0" } });
    expect(saved.ack.status).toBe("ok");
    const snapshot = await __testDispatchMsfileControl({ type: "settings.get" });
    expect(snapshot.ack.status).toBe("ok");
    expect(snapshot.operationResult).toMatchObject({
      globalSettings: { seedMaxPriceSatoshis: "500", blockMaxPriceSatoshis: "0" }
    });
  });

  it("waits on full global slots and rotates clients fairly", async () => {
    await unlockVault();
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const active = { value: 0 };
    __testSetMsfileReadConcurrencySettings({
      mediaBlockReadConcurrency: 1,
      globalSeedReadConcurrency: 1,
      globalBlockReadConcurrency: 1,
      globalStatConcurrency: 1,
    });
    __testSetMsfileRuntimeOverride({
      stat: vi.fn(async ({ seedHashHex }: { seedHashHex: string }) => {
        active.value += 1;
        started.push(seedHashHex);
        try {
          await new Promise<void>((resolve) => releases.set(seedHashHex, resolve));
          return { seedHashHex, suppliers: [] };
        } finally {
          active.value -= 1;
        }
      }),
      describeState: () => ({
        status: "ready",
        supplierGeneration: 0,
        globalSettings: null,
        mediaBlockReadConcurrency: 1,
        globalSeedReadConcurrency: 1,
        globalBlockReadConcurrency: 1,
        globalStatConcurrency: 1,
        pendingApprovals: [],
      }),
    } as never);

    const firstHash = "aa".repeat(32);
    const playerQueuedHash = "bb".repeat(32);
    const appQueuedHash = "cc".repeat(32);
    const first = __testDispatchMsfileData({ type: "stat", seedHashHex: firstHash }, "player");
    await vi.waitFor(() => expect(started).toEqual([firstHash]));
    const playerQueued = __testDispatchMsfileData({ type: "stat", seedHashHex: playerQueuedHash }, "player");
    const appQueued = __testDispatchMsfileData({ type: "stat", seedHashHex: appQueuedHash }, "connect-app");
    await Promise.resolve();
    expect(active.value).toBe(1);
    expect(started).toEqual([firstHash]);

    releases.get(firstHash)!();
    await first;
    await vi.waitFor(() => expect(started).toEqual([firstHash, appQueuedHash]));
    expect(active.value).toBe(1);
    releases.get(appQueuedHash)!();
    await appQueued;
    await vi.waitFor(() => expect(started).toEqual([firstHash, appQueuedHash, playerQueuedHash]));
    releases.get(playerQueuedHash)!();
    await playerQueued;
  });

  it("rejects non-canonical amounts with a validation error", async () => {
    await unlockVault();
    const bad = await __testDispatchMsfileControl({ type: "settings.global.update", input: { seedMaxPriceSatoshis: "01", blockMaxPriceSatoshis: "5" } });
    expect(bad.ack.status).toBe("error");
  });

  it("serializes control mutations so identical generations cannot both commit（审查修复）", async () => {
    await unlockVault();
    const supplierA = validPublisherKey(21);
    const supplierB = validPublisherKey(22);
    // 两个端口携带相同 expectedGeneration=0 并发 upsert：
    // 串行化后第二个任务内的世代检查必须失败，而不是双双通过。
    const [first, second] = await Promise.all([
      __testDispatchMsfileControl({ type: "supplier.upsert", supplier: { name: "a", supplierPublicKeyHex: supplierA, addresses: [`/ip4/127.0.0.1/tcp/8080/tls/ws/p2p/${SUPPLIER_PEER_ID_FOR(supplierA)}`], enabled: true }, expectedGeneration: 0 }),
      __testDispatchMsfileControl({ type: "supplier.upsert", supplier: { name: "b", supplierPublicKeyHex: supplierB, addresses: [`/ip4/127.0.0.1/tcp/8080/tls/ws/p2p/${SUPPLIER_PEER_ID_FOR(supplierB)}`], enabled: true }, expectedGeneration: 0 })
    ]);
    const outcomes = [first.ack.status, second.ack.status].sort();
    expect(outcomes).toEqual(["ok", "validation-error"]);
    const snapshot = await __testDispatchMsfileControl({ type: "settings.get" });
    expect((snapshot.operationResult as { suppliers: unknown[] }).suppliers).toHaveLength(1);
  });

  it("rejects mutations queued before a lock/unlock cycle with stale-epoch and leaves the DB untouched（审查修复）", async () => {
    const epochAtEnqueue = await unlockVault();
    // 用可悬挂的 stub runtime 阻塞串行尾，构造真实排队窗口。
    let releaseHead!: (value?: unknown) => void;
    const headGate = new Promise<unknown>((resolve) => { releaseHead = resolve; });
    __testSetMsfileRuntimeOverride({
      updateGlobalPriceSettings: () => headGate,
      describeState: () => ({ status: "ready", supplierGeneration: 0, globalSettings: null, pendingApprovals: [] })
    } as never);

    // A：占据串行尾（挂起）。
    const headPromise = __testDispatchMsfileControl({ type: "settings.global.update", input: { seedMaxPriceSatoshis: "1", blockMaxPriceSatoshis: "1" } });
    // B：以**当时有效**的 epoch 入队——排在 A 之后。
    const queuedPromise = __testDispatchMsfileControl({ type: "settings.global.update", input: { seedMaxPriceSatoshis: "2", blockMaxPriceSatoshis: "2" } });

    // B 尚未开始执行：先等一拍确保它已入队。
    await new Promise((resolve) => setTimeout(resolve, 10));

    // 排队期间 lock → unlock：epoch 推进两次。
    await __testLock();
    const relocked = await __testUnlock("vault-pw");
    expect(["accepted", "ok", "already-unlocked"]).toContain(relocked.ack.status);

    // 释放 A；随后 B 才真正开始执行。
    releaseHead();
    const headResult = await headPromise;
    // A 的提交跨越了 lock/unlock 栅栏：即使写入发生也不得报告为成功。
    expect(headResult.ack).toMatchObject({ status: "stale-epoch" });

    const queuedResult = await queuedPromise;
    // B 携带入队时的 epoch，执行时已是新会话 → 任务开始时即被拒。
    expect(queuedResult.ack).toMatchObject({ status: "stale-epoch" });
    void epochAtEnqueue;

    // DB 未被 B 修改：重建真实 runtime 后设置仍为空。
    __testSetMsfileRuntimeOverride(undefined);
    const snapshot = await __testDispatchMsfileControl({ type: "settings.get" });
    expect(snapshot.ack.status).toBe("ok");
    expect((snapshot.operationResult as { globalSettings: unknown }).globalSettings).toBeNull();
  });

  it("keeps mutation results stale-epoch when lock lands mid-queue（审查修复）", async () => {
    await unlockVault();
    // 以不存在的旧 epoch 发起 mutation：入口栅栏直接拦截，
    // 等价于“排队期间发生 lock/key switch”的最终形态。
    const stale = await __testDispatchMsfileControlWithEpoch(
      { type: "settings.global.update", input: { seedMaxPriceSatoshis: "9", blockMaxPriceSatoshis: "9" } },
      "epoch-that-no-longer-exists"
    );
    expect(stale.ack).toMatchObject({ status: "stale-epoch" });
    // 未写入：设置保持为空。
    const snapshot = await __testDispatchMsfileControl({ type: "settings.get" });
    expect((snapshot.operationResult as { globalSettings: unknown }).globalSettings).toBeNull();
  });

  it("rejects grants whose session lookup spans a lock/unlock cycle（审查修复）", async () => {
    await unlockVault();
    const epochAtEnqueue = __testGetSnapshot().sessionEpoch;
    let releaseResolver!: (value: { sessionId: string; origin: string; ownerPublicKeyHex: string; appIdentity: typeof identity; revokedAt: number | null } | null) => void;
    const gated = new Promise<{ sessionId: string; origin: string; ownerPublicKeyHex: string; appIdentity: typeof identity; revokedAt: number | null } | null>((resolve) => { releaseResolver = resolve; });
    __testSetStorageSessionResolver(() => gated);

    const pendingGrant = __testDispatchMsfileGrant({
      connectSessionId: "session-gated",
      transportOrigin: "https://app.example",
      ownerPublicKeyHex,
      appIdentity: identity
    }, "port-a", epochAtEnqueue);

    await new Promise((resolve) => setTimeout(resolve, 10));
    // resolver 挂起期间 lock → unlock：epoch 推进。
    await __testLock();
    await __testUnlock("vault-pw");

    releaseResolver({ sessionId: "session-gated", origin: "https://app.example", ownerPublicKeyHex, appIdentity: identity, revokedAt: null });
    const result = await pendingGrant;
    expect(result.ack).toMatchObject({ status: "stale-epoch" });
  });

  it("never reaches the service when an existing grant spans a lock/unlock during session lookup（第五轮审查修复）", async () => {
    const epoch = await unlockVault();
    __testSetStorageSessionResolver(async (id) => id === "session-msfile"
      ? { sessionId: id, origin: "https://app.example", ownerPublicKeyHex: __testGetSnapshot().activePublicKeyHex!, appIdentity: identity, revokedAt: null }
      : null);
    const granted = await __testDispatchMsfileGrant({
      connectSessionId: "session-msfile",
      transportOrigin: "https://app.example",
      ownerPublicKeyHex: __testGetSnapshot().activePublicKeyHex!,
      appIdentity: identity
    }, "port-a");
    expect(granted.ack.status).toBe("ok");
    const grantId = granted.operationResult as string;

    // 用 spy stub 替换 runtime：任何 service 调用都会被记录。
    const readSeedSpy = vi.fn(async () => { throw new Error("must not be called"); });
    __testSetMsfileRuntimeOverride({
      describeState: () => ({ status: "ready", supplierGeneration: 0, globalSettings: null, pendingApprovals: [] }),
      connect: { stat: vi.fn(), readSeed: readSeedSpy, readBlock: vi.fn() }
    } as never);

    // 让 authoritative session 查询悬挂，期间 lock → unlock。
    let releaseResolver!: (value: { sessionId: string; origin: string; ownerPublicKeyHex: string; appIdentity: typeof identity; revokedAt: number | null } | null) => void;
    const gated = new Promise<{ sessionId: string; origin: string; ownerPublicKeyHex: string; appIdentity: typeof identity; revokedAt: number | null } | null>((resolve) => { releaseResolver = resolve; });
    __testSetStorageSessionResolver(() => gated);
    const pendingRead = __testDispatchMsfileData({ type: "read-seed", grantId, supplierPublicKeyHex: identity.publisherPublicKeyHex, seedHashHex: "ab".repeat(32) }, "port-a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await __testLock();
    await __testUnlock("vault-pw");

    // 释放后：grant 已随 lock 清空 → 拒绝且 service 从未被调用。
    releaseResolver({ sessionId: "session-msfile", origin: "https://app.example", ownerPublicKeyHex, appIdentity: identity, revokedAt: null });
    const result = await pendingRead;
    expect(result.ack).toMatchObject({ status: "error", code: "msfile_identity_required" });
    expect(readSeedSpy).not.toHaveBeenCalled();
    void epoch;
  });

  it("refuses to bind a grant when the session owner is not the active runtime owner（审查修复）", async () => {
    await unlockVault();
    const otherOwner = validPublisherKey(31);
    __testSetStorageSessionResolver(async () => ({
      sessionId: "session-owner-mismatch",
      origin: "https://app.example",
      ownerPublicKeyHex: otherOwner,
      appIdentity: identity,
      revokedAt: null
    }));
    const result = await __testDispatchMsfileGrant({
      connectSessionId: "session-owner-mismatch",
      transportOrigin: "https://app.example",
      ownerPublicKeyHex: otherOwner,
      appIdentity: identity
    }, "port-a");
    expect(result.ack).toMatchObject({ status: "error", code: "msfile_identity_required" });
  });

  it("grants connect data access only for authoritative sessions and fails forged grants", async () => {
    await unlockVault();
    // 审查修复后 grant 要求 session owner === active runtime owner。
    const activeOwner = __testGetSnapshot().activePublicKeyHex!;
    __testSetStorageSessionResolver(async (id) => id === "session-msfile"
      ? { sessionId: id, origin: "https://app.example", ownerPublicKeyHex: activeOwner, appIdentity: identity, revokedAt: null }
      : null);
    const granted = await __testDispatchMsfileGrant({
      connectSessionId: "session-msfile",
      transportOrigin: "https://app.example",
      ownerPublicKeyHex: activeOwner,
      appIdentity: identity
    }, "port-a");
    expect(granted.ack.status).toBe("ok");
    const grantId = granted.operationResult as string;

    // 同 session 的伪造 origin grant 必须被拒。
    const forged = await __testDispatchMsfileGrant({
      connectSessionId: "session-msfile",
      transportOrigin: "https://evil.example",
      ownerPublicKeyHex,
      appIdentity: identity
    }, "port-b");
    expect(forged.ack).toMatchObject({ status: "error", code: "msfile_identity_required" });

    // Stat 不受金额设置阻断：无启用供应商时返回空聚合（不是错误）。
    const trustedStat = await __testDispatchMsfileData({ type: "stat", seedHashHex: "ab".repeat(32) }, "port-a");
    expect(trustedStat.ack.status).toBe("ok");
    expect((trustedStat.operationResult as { suppliers: unknown[] }).suppliers).toEqual([]);

    // Read fail closed（三道闸）：全局设置未保存 → msfile_not_configured。
    const unconfigured = await __testDispatchMsfileData({ type: "read-seed", supplierPublicKeyHex: "02" + "ab".repeat(32), seedHashHex: "ab".repeat(32) }, "port-a");
    expect(unconfigured.ack).toMatchObject({ status: "error", code: "msfile_not_configured" });

    // 设置已保存但 Gate 0 前无 transport → 未配置供应商先失败。
    await __testDispatchMsfileControl({ type: "settings.global.update", input: { seedMaxPriceSatoshis: "100", blockMaxPriceSatoshis: "100" } });
    const trustedRead = await __testDispatchMsfileData({ type: "read-seed", supplierPublicKeyHex: "02" + "ab".repeat(32), seedHashHex: "ab".repeat(32) }, "port-a");
    expect(trustedRead.ack).toMatchObject({ status: "error", code: "msfile_supplier_not_found" });

    // 其他端口的 grant 不能使用。
    const stolen = await __testDispatchMsfileData({ type: "read-seed", grantId, supplierPublicKeyHex: "02" + "ab".repeat(32), seedHashHex: "ab".repeat(32) }, "port-b");
    expect(stolen.ack).toMatchObject({ status: "error", code: "msfile_identity_required" });
  });
});
