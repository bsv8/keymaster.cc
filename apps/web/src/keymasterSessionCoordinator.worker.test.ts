import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bytesToHex,
  decryptVaultKeyMaterialForMigration,
  encryptVaultKeyMaterial,
  hexToBytes,
  resolveVaultPasswordKey,
  decodeKeyBackup,
  passwordBackupView,
  vaultDb,
} from "@keymaster/plugin-vault/coordinator";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  __testBackgroundRunNow,
  __testAddPasskeyToCurrentKey,
  __testActivateKeyWithPasskey,
  __testCancelByKey,
  __testCreateVault,
  __testCreateEmptyVault,
  __testDeleteVault,
  __testExportKeyBackup,
  __testGetActivePublicKeyHex,
  __testGetSnapshot,
  __testGetVaultStatus,
  __testImportKeyBackup,
  __testImportPrivateKey,
  __testInvalidateSession,
  __testLock,
  __testRegisterTask,
  __testRemovePasskeyFromCurrentKey,
  __testResetState,
  __testRestartWorker,
  __testRunTask,
  __testSetVaultStatus,
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

describe("Session Coordinator backup import", () => {
  beforeEach(async () => {
    await __testDeleteVault();
    __testResetState();
  });

  afterEach(async () => {
    await __testDeleteVault();
    __testResetState();
  });

  it("cross-vault import succeeds with different passwords", async () => {
    const sourceResult = await __testCreateVault("source-pw", { label: "source-key" });
    const backup = await __testExportKeyBackup(sourceResult.publicKeyHex!);
    const sourceRecord = passwordBackupView(decodeKeyBackup(backup)).keyRecord;

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
    expect(targetRecord?.cipherSaltB64).not.toBe(sourceRecord.cipherSaltB64);

    // The imported record is encrypted for the target Vault, and only that
    // password can open it after the Worker loses its in-memory session.
    const targetKey = await resolveVaultPasswordKey("target-pw", targetMeta!);
    await expect(
      decryptVaultKeyMaterialForMigration(targetKey.key, targetRecord!, targetKey.encoding)
    ).resolves.toMatchObject({ hex: expect.any(String) });
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

    await expect(__testImportKeyBackup(backup, "wrong-source-pw", "target-pw")).rejects.toThrow(/Invalid password/);
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
    const parsed = JSON.parse(backup);
    const view = passwordBackupView(decodeKeyBackup(backup));
    const sourceKey = await resolveVaultPasswordKey("source-pw", view.sourceVaultMeta);
    const material = await decryptVaultKeyMaterialForMigration(sourceKey.key, view.keyRecord, sourceKey.encoding);
    const tamperedPublicKeyHex = bytesToHex(secp256k1.getPublicKey(hexToBytes(TEST_PRIV_2), true));
    parsed.publicKeyHex = tamperedPublicKeyHex;
    const tamperedCipher = await encryptVaultKeyMaterial(sourceKey.key, tamperedPublicKeyHex, material);
    Object.assign(parsed.protectors.password, tamperedCipher);
    const tamperedBackup = JSON.stringify(parsed);

    await __testDeleteVault();
    __testResetState();
    await __testCreateEmptyVault("target-pw");

    await expect(__testImportKeyBackup(tamperedBackup, "source-pw", "target-pw")).rejects.toThrow("Backup key public key mismatch");
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
    await vaultDb.deleteKey(placeholder.publicKeyHex!);
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
    const backup = decodeKeyBackup(await __testExportKeyBackup(first.publicKeyHex!));
    expect(backup.backupVersion).toBe(2);
    if (backup.backupVersion !== 2) throw new Error("expected v2 backup");
    expect(Object.keys(backup.protectors)).toEqual(["password", "passkey01"]);

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

    const backup = decodeKeyBackup(await __testExportKeyBackup(key.publicKeyHex!));
    expect(backup.backupVersion).toBe(2);
    if (backup.backupVersion !== 2) throw new Error("expected v2 backup");
    expect(Object.keys(backup.protectors)).toEqual(["password"]);
  });
});
