import { defineWorkerRequestRoute } from "@keymaster/contracts";
import { executeWorkerUnlock } from "./coordinator.js";
import type { SessionEpoch, CoordinatorResponse, CoordinatorCryptoOperation, CoordinatorVaultOperation } from "@keymaster/contracts";
import { createMigrationJournalService, createHardwareToSoftwareMigration, requestMigratedDeviceErase, createSoftwareToHardwareMigration, inspectWalletKeyBytes, verifyDeviceMigrationJournal, createAndVerifyMigrationKeyHold, executeWalletControl, executeVaultOperation as executeOwnedVaultOperation } from "./coordinator.js";
import type { KeyIdentity } from "@keymaster/contracts";
import { WALLET_MIGRATION_PATH } from "@keymaster/contracts/storage-internal";
import { verifyMigratedHardwareLedger } from "./coordinator.js";
import type { CoordinatorVaultStatus, CoordinatorClientRequest, VaultWorkerWalletControl } from "@keymaster/contracts";
import type { createVaultWorkerKeys } from "./workerKeys.js";
import type { createVaultWalletWorker } from "./workerWallet.js";
export interface VaultWorkerOperationsPorts {
  keys: ReturnType<typeof createVaultWorkerKeys>;
  wallet: ReturnType<typeof createVaultWalletWorker>;
  session(): Readonly<{ vaultStatus: CoordinatorVaultStatus; sessionEpoch: string; runGeneration: string; walletGeneration: string; activePublicKeyHex?: string }>;
  commit(patch: Partial<ReturnType<VaultWorkerOperationsPorts["session"]>>): void;
  cleanupPending(): unknown;
  peerRevoked(peerId: string): boolean;
  newEpoch(): string;
  publishWallet(): void;
  publishSession(cause: "unlock" | "lock" | "change-password" | "reset-wallet"): void;
  clearActivationCredential(): void;
  storage: {
    token(): object | undefined; hasRoot(): boolean; payments(): ReturnType<import("./workerKeys.js").VaultWorkerKeyPorts["storage"]["payments"]>;
    revokeGrants(): void; invalidateClients(): void; unavailable(message: string): Error; failure(error: unknown): void; errorResponse(requestId: string, error: unknown): CoordinatorResponse; changed(): void; revokeBindingAndDrain(reason: string): Promise<void>; discardBinding(): void
  };
  binding: { installRoot(): Promise<void>; loadSettings(): Promise<void>; ensureStorage(): Promise<unknown>; ensureTasks(): Promise<void>; complete(cause?: "initialize" | "unlock"): Promise<void>; lock(reason: string): Promise<void> };
  io: {
    assertAuthority(): Promise<void>; closeSession(reason: string): void;
    run<T>(kind: "read" | "write", signal: AbortSignal | undefined, execute: () => Promise<T>, options: { auditOperation: "vault.operation" | "vault.unlock" | "service.crypto.sign"; allowLocalLock?: boolean; allowLocalOwnerTransition?: boolean; walletMigration?: boolean; durableLease?: boolean }): Promise<T>
  };
}
/** Vault 仓库操作、设备配对和迁移归插件；公共层仅提交会话与提供 I/O 栅栏。 */
export function createVaultWorkerOperations(ports: VaultWorkerOperationsPorts) {
  function clearVaultOperationSecrets(operation: CoordinatorVaultOperation): void {
    switch (operation.type) {
      case "migrateToHardware":
        return;
      case "migrateToSoftware":
        operation.newPassword = ""; return;
      case "verifyPassword":
        operation.password = "";
        return;
      case "changePassword":
        operation.oldPassword = "";
        operation.newPassword = "";
        return;
      case "sealLocalSecret":
        operation.plaintext.fill(0);
        return;
      default:
        return;
    }
  }

  async function handleUnlock(
    requestId: string,
    request: { kind: "unlock"; password: string; expectedSessionEpoch: SessionEpoch }
  ): Promise<CoordinatorResponse> {
    try {
      return await ports.io.run(
        "write",
        undefined,
        () => handleUnlockUnsafe(requestId, request),
        { allowLocalLock: true, allowLocalOwnerTransition: true, auditOperation: "vault.unlock" },
      );
    } finally {
      // 释放 MessageEvent 对象中仍可控的密码引用；解密上下文/私钥在
      // handleUnlockUnsafe 的 finally 中处理。
      request.password = "";
    }
  }

  async function handleUnlockUnsafe(requestId: string, request: { kind: "unlock"; password: string; expectedSessionEpoch: SessionEpoch }): Promise<CoordinatorResponse> {
    if (ports.cleanupPending()) return { requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "locked" } };
    return executeWorkerUnlock(requestId, request, {
      session: () => ports.session(),
      coldStart: async () => ports.wallet.storageColdStartState ?? await ports.wallet.walletLifecycle?.coldStart(),
      lifecycle: ports.wallet.requireWalletLifecycle,
      completeBinding: ports.binding.complete,
      storageFailed: ports.storage.failure,
      clearFailedSession: () => { ports.commit({ vaultStatus: "locked" }); ports.commit({ activePublicKeyHex: undefined }); ports.keys.dropActivePrivateKey(); },
      storageError: ports.storage.errorResponse,
    });
  }

  async function handleHardwareConnection(
    request: Extract<CoordinatorClientRequest, { kind: "vault.operation" }>,
    peerId: string,
    signal?: AbortSignal,
  ): Promise<CoordinatorResponse> {
    const operation = request.operation;
    if (operation.type !== "hardware") throw new Error("Invalid hardware operation");
    const command = operation.command;
    let connectedByRequest = false;
    try {
      if (request.expectedSessionEpoch !== ports.session().sessionEpoch) throw new Error("stale-usb-session");
      if (command.action === "state") {
        const state = ports.keys.hardwareConnections.state();
        const activity = state.status === "connected" && !ports.keys.hardwareConnections.isErasedRecovery() && !ports.keys.hardwareConnections.isProvisioning() ? await ports.keys.hardwareConnections.backend().activity() : undefined;
        return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "ok" }, operationResult: { ...state, ...(activity ? { activity } : {}) } };
      }
      if (command.action === "disconnect") {
        await ports.keys.hardwareConnections.disconnect(peerId, command.leaseId);
      } else if (command.action === "provision" || command.action === "recover-import") {
        if (!ports.wallet.walletStore || !ports.wallet.walletKeys || ports.keys.hardwareConnections.state().status !== "disconnected") throw Error("migration-provisioning-unavailable");
        const store = ports.wallet.walletStore, keys = ports.wallet.walletKeys, epoch = ports.session().sessionEpoch, run = ports.session().runGeneration;
        const service = createMigrationJournalService({ store: ports.wallet.bootstrapStorage(store).migration, inspectKey: inspectWalletKeyBytes });
        const journal = await ports.io.run("read", signal, () => service.current(), { auditOperation: "vault.operation" });
        const recovery = command.action === "recover-import";
        if (recovery ? (!journal || journal.phase === "complete" || journal.source !== "software" || journal.target !== "hardware" || ports.session().vaultStatus !== "locked") :
          (journal && journal.phase !== "complete" || ports.session().vaultStatus !== "unlocked" || ports.keys.activeKeyBackend !== "software")) throw Error("migration-provisioning-unavailable");
        if (recovery) { ports.commit({ walletGeneration: journal!.walletGeneration }); ports.keys.hardwareRecoveryConnection = { migrationId: journal!.migrationId, peerId }; }
        const assertRecordLive = () => { if (signal?.aborted || ports.peerRevoked(peerId) || ports.wallet.walletStore !== store || ports.wallet.walletKeys !== keys || ports.session().sessionEpoch !== epoch || ports.session().runGeneration !== run) throw Error("migration-session-revoked"); };
        const sourceKey = await ports.io.run("read", signal, () => keys.read(), { auditOperation: "vault.operation" });
        if (!sourceKey) throw Error("network-identity-required");
        try {
await ports.keys.hardwareConnections.attachProvision({ bsvNetwork: sourceKey.document.bsvNetwork, peerId, leaseId: command.leaseId, port: command.port, signal, assertRecordLive, walletGeneration: ports.session().walletGeneration! }); connectedByRequest = true; assertRecordLive();
          const state = await ports.keys.hardwareConnections.provision().migrationStatus(); assertRecordLive(); if (journal && journal.phase !== "complete" && state) verifyDeviceMigrationJournal(journal, state);
          else if (recovery && journal!.phase !== "prepared") throw Error("migration-device-record-missing");
        } catch (error) { ports.keys.hardwareRecoveryConnection = undefined; await ports.keys.hardwareConnections.closePeer(peerId); throw error; }
      } else if ((command.action === "recover" || command.action === "recover-erased")) {
        if (!ports.wallet.walletStore || !ports.wallet.walletKeys || ports.keys.hardwareConnections.state().status !== "disconnected" || ports.session().vaultStatus !== "locked") throw Error("migration-recovery-unavailable");
        const store = ports.wallet.walletStore, keys = ports.wallet.walletKeys, epoch = ports.session().sessionEpoch, run = ports.session().runGeneration;
        const service = createMigrationJournalService({ store: ports.wallet.bootstrapStorage(store).migration, inspectKey: inspectWalletKeyBytes });
        const journal = await ports.io.run("read", signal, () => service.current(), { auditOperation: "vault.operation" });
        if (!journal || journal.phase === "complete" || journal.source !== "hardware" || journal.target !== "software") throw Error("migration-recovery-unavailable");
        if (command.action === "recover-erased" && journal.phase !== "local-committed") throw Error("migration-conflict");
        const file = await keys.read(); if (!file) throw Error("migration-source-missing");
        ports.commit({ walletGeneration: journal.walletGeneration });
        ports.keys.hardwareRecoveryConnection = { migrationId: journal.migrationId, peerId };
        const assertRecordLive = () => {
          if (signal?.aborted || ports.peerRevoked(peerId) || ports.wallet.walletStore !== store || ports.wallet.walletKeys !== keys || ports.session().sessionEpoch !== epoch
            || ports.session().runGeneration !== run || ports.keys.hardwareRecoveryConnection?.migrationId !== journal.migrationId) throw Error("migration-session-revoked");
        };
        try {
          if (command.action === "recover-erased") await ports.keys.hardwareConnections.attachErased({ peerId, leaseId: command.leaseId, port: command.port, signal, assertRecordLive, journal });
          else await ports.keys.hardwareConnections.attach({
peerId, leaseId: command.leaseId, port: command.port, signal, assertRecordLive,
            document: {
format: "keymaster.hardware-key", version: 1, backend: "vaultlink", wireVersion: 2, bsvNetwork: file.document.bsvNetwork, label: file.document.label,
              publicKeyHex: journal.publicKeyHex, walletGeneration: journal.walletGeneration, backendGeneration: 1
}
});
          connectedByRequest = true; assertRecordLive();
          const state = await (ports.keys.hardwareConnections.isErasedRecovery() ? ports.keys.hardwareConnections.erased() : ports.keys.hardwareConnections.backend()).migrationStatus(); assertRecordLive();
          if (state && !(journal.phase === "prepared" && state.phase === "complete" && state.id !== journal.migrationId)) verifyDeviceMigrationJournal(journal, state);
          else if (journal.phase !== "prepared") throw Error("migration-device-record-missing");
          // Recovery connection proves the SAME old key, but never installs Root,
          // ordinary crypto, payment access or owner-session units.
        } catch (error) { ports.keys.hardwareRecoveryConnection = undefined; await ports.keys.hardwareConnections.closePeer(peerId); throw error; }
      } else if (command.action === "enroll") {
        if (ports.keys.hardwareEnrollmentInProgress || ports.keys.hardwareConnections.state().status !== "disconnected") throw Error("usb-in-use");
        const lifecycle = ports.wallet.walletLifecycle, keys = ports.wallet.walletKeys, store = ports.wallet.walletStore;
        if (!lifecycle || !keys || !store || ports.session().vaultStatus !== "uninitialized") throw Error("Hardware enrollment requires an uninitialized wallet");
        const run = ports.session().runGeneration, initialGeneration = ports.session().walletGeneration;
        let bindingEpoch = ports.session().sessionEpoch, bindingToken = ports.storage.token();
        let expectedGeneration = initialGeneration;
        const walletGeneration = crypto.randomUUID();
        const assertRecordLive = () => {
          if (signal?.aborted || ports.peerRevoked(peerId) || ports.wallet.walletLifecycle !== lifecycle || ports.wallet.walletKeys !== keys || ports.wallet.walletStore !== store
            || ports.session().runGeneration !== run || ports.session().sessionEpoch !== bindingEpoch || ports.storage.token() !== bindingToken
            || ports.session().walletGeneration !== expectedGeneration) throw Error("Hardware enrollment was revoked");
        };
        if ((await lifecycle.coldStart()).state !== "uninitialized") throw Error("Wallet already has a Key");
        assertRecordLive(); ports.keys.hardwareEnrollmentInProgress = true;
        try {
          await ports.keys.hardwareConnections.enroll({
peerId, leaseId: command.leaseId, port: command.port, label: command.label,
            walletGeneration, assertRecordLive, signal
});
          connectedByRequest = true; assertRecordLive();
          await ports.io.assertAuthority(); assertRecordLive();
          const document = ports.keys.hardwareConnections.verifiedDocument();
          const meta = await ports.io.run("write", undefined, () => lifecycle.initializeHardware(document), {
            allowLocalOwnerTransition: true, auditOperation: "vault.operation",
          });
          // initializeHardware 的提交事件只改变此次指定的身份世代。
          expectedGeneration = meta.walletGeneration;
          assertRecordLive(); ports.keys.hardwareConnections.backend();
          ports.storage.revokeGrants(); ports.storage.invalidateClients(); ports.keys.dropActivePrivateKey();
          bindingEpoch = ports.newEpoch(); ports.commit({ sessionEpoch: bindingEpoch });
          ports.commit({ activePublicKeyHex: document.publicKeyHex }); ports.keys.activeKeyBackend = "hardware";
          ports.commit({ vaultStatus: "unlocked" });
          ports.keys.setCoordinatorActiveKeySummary({
bsvNetwork: document.bsvNetwork, backend: "hardware", publicKeyHex: document.publicKeyHex, label: document.label,
            capabilities: ["p2pkh", "bsv.standard", "feepool.connect", "feepool.bitfs", "local-secret.v3"], createdAt: new Date().toISOString()
});
          await ports.binding.installRoot(); bindingToken = ports.storage.token();
          assertRecordLive(); ports.keys.hardwareConnections.backend();
          await ports.binding.loadSettings(); await ports.binding.ensureStorage(); await ports.binding.ensureTasks();
          ports.publishWallet(); await ports.binding.complete("initialize"); assertRecordLive();
        } catch (error) {
          // 已提交的公开绑定保留；运行装配失败只撤销会话，随后可重新连接。
          if (connectedByRequest) await ports.binding.lock("hardware-enrollment-failed").catch(() => undefined);
          throw error;
        } finally { ports.keys.hardwareEnrollmentInProgress = false; }
      } else {
        const epoch = ports.session().sessionEpoch, run = ports.session().runGeneration;
        let token = ports.storage.token();
        let bindingEpoch = epoch;
        if (ports.session().vaultStatus !== "locked") throw new Error("Hardware connection requires a locked wallet");
        const keys = ports.wallet.walletKeys;
        if (!keys) throw ports.storage.unavailable("Hardware wallet record is unavailable");
        const file = await ports.io.run("read", undefined, () => keys.read(), { auditOperation: "vault.operation" });
        if (!file || file.backend !== "hardware" || file.document.bsvNetwork + "/" + file.document.publicKeyHex !== ports.session().walletGeneration) throw new Error("Current wallet is not bound to a hardware Key");
        const assertRecordIdentity = () => {
          if (signal?.aborted || ports.peerRevoked(peerId) || ports.wallet.walletKeys !== keys
            || ports.session().sessionEpoch !== bindingEpoch || ports.session().runGeneration !== run
            || ports.session().walletGeneration !== file.document.bsvNetwork + "/" + file.document.publicKeyHex) throw new Error("Hardware wallet binding was revoked");
        };
        const assertRecordLive = () => {
          assertRecordIdentity();
          if (ports.storage.token() !== token) throw new Error("Hardware wallet binding was revoked");
        };
        assertRecordLive();
        await ports.keys.hardwareConnections.attach({ peerId, leaseId: command.leaseId, port: command.port, document: file.document, assertRecordLive, signal });
        connectedByRequest = true;
        await ports.io.assertAuthority();
        assertRecordLive();
        const current = await ports.io.run("read", undefined, () => keys.read(), { auditOperation: "vault.operation" });
        if (!current || current.revision !== file.revision || current.backend !== "hardware") throw new Error("Hardware record changed during pairing");
        // 已存在的软件消费账本必须经迁移协议转入设备；不能忽略它而得到空额度。
        const oldPolicy = await ports.storage.payments().get("payments.json");
        assertRecordLive();
        if (oldPolicy) {
          if (!ports.wallet.walletStore) throw ports.storage.unavailable("Migration store is unavailable");
          const migration = await ports.io.run("read", undefined,
            () => ports.wallet.bootstrapStorage(ports.wallet.walletStore!).migration.get(WALLET_MIGRATION_PATH), { auditOperation: "vault.operation" });
          assertRecordLive();
          const actualBank = await ports.keys.hardwareConnections.backend().exportPaymentPolicy();
          assertRecordLive();
          await verifyMigratedHardwareLedger(file.document, migration?.bytes, oldPolicy.bytes, actualBank);
          assertRecordLive();
        }
        const snapshot = await ports.wallet.requireWalletLifecycle().coldStart();
        assertRecordLive();
        if (snapshot.state !== "ready" || snapshot.key?.publicKeyHex !== file.document.publicKeyHex) throw new Error("Hardware identity changed during activation");
        // 记录核验过程中设备可能已经断线，此时尚未设置 activeKeyBackend，断线回调不会替我们锁定。
        // 必须重新检查当前连接所有者，不能只根据持久记录把钱包显示为 unlocked。
        ports.keys.hardwareConnections.backend();
        ports.storage.revokeGrants(); ports.storage.invalidateClients(); ports.keys.dropActivePrivateKey();
        bindingEpoch = ports.newEpoch();
        ports.commit({ sessionEpoch: bindingEpoch });
        ports.commit({ activePublicKeyHex: file.document.publicKeyHex });
        ports.keys.activeKeyBackend = "hardware";
        ports.commit({ vaultStatus: "unlocked" });
        ports.keys.setCoordinatorActiveKeySummary({
          bsvNetwork: file.document.bsvNetwork, backend: "hardware", publicKeyHex: file.document.publicKeyHex, label: file.document.label,
          capabilities: ["p2pkh", "bsv.standard", "feepool.connect", "feepool.bitfs", "local-secret.v3"], createdAt: new Date().toISOString()
        });
        ports.publishWallet();
        await ports.binding.complete();
        // complete() deliberately reinstalls platform storage for the new
        // unlocked epoch. Adopt only that fenced transition, never a token
        // observed during pairing or an identity/epoch/peer change.
        assertRecordIdentity();
        const unlockedToken = ports.storage.token();
        if (!unlockedToken || ports.session().vaultStatus !== "unlocked") throw new Error("Hardware wallet binding was revoked");
        token = unlockedToken;
        assertRecordLive(); ports.keys.hardwareConnections.backend();
      }
      return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "ok" }, operationResult: ports.keys.hardwareConnections.state() };
    } catch (error) {
      if (command.action === "attach" || command.action === "recover" || command.action === "recover-erased" || command.action === "provision" || command.action === "recover-import" || command.action === "enroll") {
        if (connectedByRequest && ports.keys.hardwareConnections.state().leaseId === command.leaseId) await ports.keys.hardwareConnections.closePeer(peerId);
        try { command.port.close(); } catch { /* transferred port cleanup */ }
      }
      return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "error", message: error instanceof Error ? error.message : String(error) } };
    }
  }

  async function handleVaultOperation(requestId: string, request: { kind: "vault.operation"; operation: CoordinatorVaultOperation }): Promise<CoordinatorResponse> {
    try {
      // 所有从页面进入的 Vault 仓库读写都必须在最终边界重新登记；仅在
      // processRequest 开头检查一次运行世代不足以覆盖中途的状态切换。
      // allowLocalLock / allowLocalOwnerTransition 只允许本次操作自己执行
      // fail-closed 锁定或 owner 切换；仍会重新校验共享 authority，不能把
      // 旧页面/迟到结果当成成功。
      const ioKind = vaultOperationIoKind(request.operation);
      const result = await ports.io.run(
        ioKind,
        undefined,
        () => executeVaultOperation(request.operation),
        {
          walletMigration: request.operation.type === "migrateToSoftware" || request.operation.type === "migrateToHardware",
          allowLocalLock: true,
          allowLocalOwnerTransition: true,
          auditOperation: "vault.operation",
          // list/get/export/verify 只读取当前本地真值；底层存储入口也有各自的
          // authority 与绑定世代检查。保留本 Worker 的前后栅栏，但只让真正
          // 会改写 Vault 的操作登记内存 write lease；刷新时浏览器锁随 Worker
          // 终止自动释放，不会留下无法清理的业务 K-V 记录。
          durableLease: ioKind === "write",
        },
      );
      if ((request.operation.type === "migrateToSoftware" || request.operation.type === "migrateToHardware") && !ports.storage.hasRoot()) {
        await ports.binding.installRoot(); await ports.binding.loadSettings(); await ports.binding.ensureStorage(); await ports.binding.ensureTasks(); ports.storage.changed();
      }
      // Session runtime recovery performs ordinary wallet I/O. Run it only after
      // releasing migration admission; nesting it inside the fence would reject
      // its own reads and leave the newly activated wallet's business gates shut.
      if (request.operation.type === "migrateToSoftware" && ports.session().vaultStatus === "unlocked") await ports.binding.complete();
      return { requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "ok" }, operationResult: result };
    } catch (err) {
      ports.storage.failure(err);
      return ports.storage.errorResponse(requestId, err);
    } finally {
      clearVaultOperationSecrets(request.operation);
    }
  }

  function vaultOperationIoKind(operation: CoordinatorVaultOperation): "read" | "write" {
    switch (operation.type) {
      case "verifyPassword":
      case "exportKeyHold":
      case "getCurrentKey":
      case "migrationState":
        return "read";
      default:
        return "write";
    }
  }

  function currentKeySummary(): KeyIdentity | undefined {
    return ports.keys.coordinatorActiveKeySummary();
  }

  function adoptUnlockedKey(input: {
    identity: import("@keymaster/contracts").KeyIdentity;
    privateKeyBytes: Uint8Array;
    publicKeyHex: string;
    walletGeneration: string;
    sessionEpoch: string;
  }): void {
    if (ports.cleanupPending()) { input.privateKeyBytes.fill(0); throw new Error("Wallet cleanup has not completed"); }
    // 旧会话的所有 grant 与任务权限先撤销：解锁只授予新身份，不继承旧句柄。
    ports.keys.activeKeyBackend = "software";
    ports.storage.revokeGrants();
    ports.commit({ walletGeneration: input.walletGeneration });
    // 生命周期已经生成新的会话世代，Coordinator 必须使用它而不是再造一个：
    // grant、存储绑定和迟到结果全部按这个 epoch 判定。
    ports.commit({ sessionEpoch: input.sessionEpoch });
    ports.commit({ vaultStatus: "unlocked" });
    ports.commit({ activePublicKeyHex: input.publicKeyHex });
    ports.keys.replaceActivePrivateKey(input.privateKeyBytes);
    ports.keys.setCoordinatorActiveKeySummary(input.identity);
    // The authenticated session is committed before owner-unit construction reads it.
    ports.publishWallet();
    ports.clearActivationCredential();
  }

  async function migrateHardwareToSoftware(newPassword: string): Promise<{ migrationId: string; phase: "complete"; target: "software" }> {
    const recovery = ports.keys.hardwareRecoveryConnection;
    if (!recovery) ports.keys.assertActiveWalletIdentity();
    if ((ports.keys.activeKeyBackend !== "hardware" && !recovery) || !ports.wallet.walletStore || !ports.wallet.walletKeys) throw Error("hardware-source-required");
    if (ports.keys.hardwareConnections.isErasedRecovery()) {
      const portal = ports.keys.hardwareConnections.erased(), store = ports.wallet.walletStore, keys = ports.wallet.walletKeys, epoch = ports.session().sessionEpoch;
      const assertRecovery = () => { if (ports.wallet.walletStore !== store || ports.wallet.walletKeys !== keys || ports.session().sessionEpoch !== epoch || ports.keys.hardwareRecoveryConnection !== recovery || ports.keys.hardwareConnections.erased() !== portal) throw Error("migration-session-revoked"); };
      try {
        const service = createMigrationJournalService({ store: ports.wallet.bootstrapStorage(store).migration, inspectKey: inspectWalletKeyBytes });
        const journal = await service.current(); assertRecovery(); if (!journal || journal.phase !== "local-committed") throw Error("migration-conflict");
        const receipt = await portal.finishErase(); assertRecovery(); verifyDeviceMigrationJournal(journal, receipt);
        if (!["erased", "complete"].includes(receipt.phase)) throw Error("migration-conflict");
        await service.finish(journal.migrationId); assertRecovery();
        const completed = await service.current(); assertRecovery(); if (!completed) throw Error("migration-conflict");
        await portal.completeDevice(completed); assertRecovery();
        ports.commit({ walletGeneration: journal.walletGeneration }); await ports.binding.lock("backend-migrated");
        ports.wallet.storageColdStartState = await ports.wallet.requireWalletLifecycle().coldStart(); ports.storage.changed(); ports.publishWallet();
        return { migrationId: journal.migrationId, phase: "complete", target: "software" };
      } catch (error) { await ports.binding.lock("backend-migration-recovery-required").catch(() => undefined); ports.wallet.storageColdStartState = await ports.wallet.requireWalletLifecycle().coldStart(); ports.storage.changed(); throw error; }
    }
    const backend = ports.keys.hardwareConnections.backend(), store = ports.wallet.walletStore, keys = ports.wallet.walletKeys;
    const epoch = ports.session().sessionEpoch, run = ports.session().runGeneration, token = ports.storage.token();
    const assertExclusive = () => {
      if (ports.wallet.walletStore !== store || ports.wallet.walletKeys !== keys || ports.session().sessionEpoch !== epoch || ports.session().runGeneration !== run
        || ports.storage.token() !== token || (recovery ? (ports.keys.hardwareRecoveryConnection !== recovery || ports.session().vaultStatus !== "locked") : (ports.session().vaultStatus !== "unlocked" || ports.keys.activeKeyBackend !== "hardware"))
        || ports.keys.hardwareConnections.backend() !== backend || !backend.isMigrating()) throw Error("migration-session-revoked");
    };
    try {
      const result = await backend.withMigration(async () => {
        assertExclusive();
        const source = await keys.read(); assertExclusive();
        if (!source) throw Error("hardware-source-required");
        const service = createMigrationJournalService({ store: ports.wallet.bootstrapStorage(store).migration, inspectKey: inspectWalletKeyBytes });
        const current = await service.current(); assertExclusive();
        if (source.backend !== "hardware" && !(recovery && current?.phase === "local-committed")) throw Error("hardware-source-required");
        const previous = await service.read(); assertExclusive();
        const migrationId = previous && previous.journal.phase !== "complete" ? previous.journal.migrationId : crypto.randomUUID();
        ports.keys.softwareMigrationFailure = undefined;
        if (previous?.journal.phase !== "local-committed" && newPassword.length < 8) throw Error("password-too-short");
        const migration = createHardwareToSoftwareMigration({
service, device: backend, assertExclusive,
          createAndVerifyKeyHold: async (privateKey, publicKeyHex) => createAndVerifyMigrationKeyHold({ bsvNetwork: source.document.bsvNetwork, privateKey, publicKeyHex, label: source.document.label }, newPassword)
});
        return migration.run({ migrationId, expectedRevision: source.revision });
      });
      ports.commit({ walletGeneration: result.bsvNetwork + "/" + result.publicKeyHex });
      // The ciphertext/ledger/completed receipt are already durable. Keep only a
      // migration-frozen USB handle for optional disposal; it must not authorize
      // ordinary hardware operations or inherit the new software session.
      const disposal = ports.keys.hardwareConnections.retainForMigrationCleanup(() => {
        if (ports.wallet.walletStore !== store || ports.wallet.walletKeys !== keys || ports.session().runGeneration !== run
          || ports.session().walletGeneration !== result.bsvNetwork + "/" + result.publicKeyHex
          || (ports.session().sessionEpoch !== epoch && (ports.keys.activeKeyBackend !== "software" || ports.session().activePublicKeyHex !== result.publicKeyHex)))
          throw Error("migration-session-revoked");
      });
      ports.keys.hardwareRecoveryConnection = undefined;
      // No wallet storage writes or admission lease in this independent task.
      // Denial, silence and disconnect preserve the backup, never undo software.
      void requestMigratedDeviceErase(result, disposal.backend).catch(() => undefined).finally(() => disposal.close());
      ports.keys.walletPayments?.close(); ports.keys.walletPayments = undefined; ports.keys.walletPaymentsOpening = undefined;
      ports.io.closeSession("Hardware wallet migrated to software");
      ports.wallet.storageColdStartState = await ports.wallet.requireWalletLifecycle().coldStart();
      if (ports.wallet.storageColdStartState.state !== "ready" || ports.wallet.storageColdStartState.key?.backend !== "software") throw Error("migration-activation-failed");
      await ports.wallet.requireWalletLifecycle().unlock(newPassword);
      const softwareIdentity = ports.keys.coordinatorActiveKeySummary();
      if (softwareIdentity) ports.keys.setCoordinatorActiveKeySummary({ ...softwareIdentity, backend: "software" });
      ports.storage.changed(); ports.publishWallet();
      return { migrationId: result.migrationId, phase: "complete", target: "software" };
    } catch (error) {
      ports.wallet.storageColdStartState = await ports.wallet.requireWalletLifecycle().coldStart();
      // A failed volatile preparation keeps the hardware source and its session.
      // Only an already committed software target needs normal login on failure.
      if (ports.wallet.storageColdStartState.state !== "ready" || ports.wallet.storageColdStartState.key?.backend !== "hardware")
        await ports.binding.lock("backend-migrated").catch(() => undefined);
      ports.storage.changed(); throw error;
    }
  }

  async function migrateSoftwareToHardware(): Promise<{ migrationId: string; phase: "complete"; target: "hardware" }> {
    const recovery = ports.keys.hardwareRecoveryConnection; if (!recovery) ports.keys.assertActiveWalletIdentity();
    if (!ports.wallet.walletStore || !ports.wallet.walletKeys || (!recovery && ports.keys.activeKeyBackend !== "software")) throw Error("software-source-required");
    // 连接未验证与源钱包错误分开报告，不能把配对中的设备当作导入通道。
    if (!ports.keys.hardwareConnections.isProvisioning() || ports.keys.hardwareConnections.state().status !== "connected") throw Error("hardware-provision-required");
    const store = ports.wallet.walletStore, keys = ports.wallet.walletKeys, portal = ports.keys.hardwareConnections.provision(), epoch = ports.session().sessionEpoch, run = ports.session().runGeneration;
    const check = () => {
if (ports.wallet.walletStore !== store || ports.wallet.walletKeys !== keys || ports.session().sessionEpoch !== epoch || ports.session().runGeneration !== run || ports.keys.hardwareConnections.provision() !== portal
        || (recovery ? ports.keys.hardwareRecoveryConnection !== recovery : ports.session().vaultStatus !== "unlocked")) throw Error("migration-session-revoked");
};
    try {
      check();
      const source = await keys.read(); check(); if (!source) throw Error("migration-source-missing");
      const service = createMigrationJournalService({ store: ports.wallet.bootstrapStorage(store).migration, inspectKey: inspectWalletKeyBytes });
      const previous = await service.current(); check();
      const migrationId = previous && previous.phase !== "complete" ? previous.migrationId : crypto.randomUUID();
      const completed = await ports.keys.vaultKeySession.useForMigration(async privateKey => {
        const migration = createSoftwareToHardwareMigration({
service, device: portal, assertExclusive: check,
          sourceBank: () => service.sourceBank(source.document.publicKeyHex),
          unlockSource: async () => { check(); return new Uint8Array(privateKey); },
          hardwareDocument: journal => new TextEncoder().encode(JSON.stringify({
format: "keymaster.hardware-key", version: 1, backend: "vaultlink", wireVersion: 2, bsvNetwork: journal.bsvNetwork, label: source.document.label,
            publicKeyHex: journal.publicKeyHex, walletGeneration: journal.walletGeneration, backendGeneration: 1
})),
        });
        return migration.run({ migrationId, expectedRevision: source.revision });
      }); check();
      ports.commit({ walletGeneration: completed.walletGeneration }); await ports.binding.lock("backend-migrated");
      ports.wallet.storageColdStartState = await ports.wallet.requireWalletLifecycle().coldStart(); if (ports.wallet.storageColdStartState.state !== "ready" || ports.wallet.storageColdStartState.key?.backend !== "hardware") throw Error("migration-activation-failed");
      ports.storage.changed(); ports.publishWallet(); return { migrationId, phase: "complete", target: "hardware" };
    } catch (error) {
      // Before atomic replacement the source session remains usable. Never turn
      // a device rejection or bad password into a corrupt-wallet recovery gate.
      ports.wallet.storageColdStartState = await ports.wallet.requireWalletLifecycle().coldStart(); ports.storage.changed(); throw error;
    }
  }

  async function executeVaultOperation(operation: CoordinatorVaultOperation): Promise<unknown> {
    if (operation.type === "migrationState") {
      if (!ports.wallet.walletStore) return null;
      const service = createMigrationJournalService({ store: ports.wallet.bootstrapStorage(ports.wallet.walletStore).migration, inspectKey: inspectWalletKeyBytes });
      const journal = await service.current();
      return !journal || journal.phase === "complete" ? null : { migrationId: journal.migrationId, phase: journal.phase, publicKeyHex: journal.publicKeyHex, passwordRequired: journal.phase !== "local-committed", target: journal.target, ...(ports.keys.softwareMigrationFailure?.migrationId === journal.migrationId ? { failure: ports.keys.softwareMigrationFailure.message } : {}) };
    }
    if (operation.type === "migrateToHardware") return migrateSoftwareToHardware();
    if (operation.type === "migrateToSoftware") { try { return await migrateHardwareToSoftware(operation.newPassword); } finally { operation.newPassword = ""; } }
    if (ports.keys.activeKeyBackend === "hardware") {
      ports.keys.assertActiveWalletIdentity();
      const backend = ports.keys.hardwareConnections.backend();
      if (operation.type === "sealLocalSecret") {
        try { return await backend.sealLocalSecret(operation.scope, operation.plaintext); }
        finally { operation.plaintext.fill(0); }
      }
      if (operation.type === "openLocalSecret") return backend.openLocalSecret(operation.scope, operation.sealed);
      if (operation.type === "getCurrentKey") { const key = currentKeySummary(); return key ? { ...key, format: "keymaster.hardware-key" } : undefined; }
    }
    if (operation.type === "payment") {
      if (operation.command.action === "signature-history") return ports.keys.currentSignatureHistory().list();
      return (await ports.keys.currentWalletPayments()).handle(operation.command);
    }
    const epoch = ports.session().sessionEpoch;
    const owner = ports.session().activePublicKeyHex;
    return executeOwnedVaultOperation(operation, {
      lifecycle: ports.wallet.requireWalletLifecycle,
      currentKey: currentKeySummary,
      beforePasswordChange: () => ports.storage.revokeBindingAndDrain("vault.changePassword"),
      passwordChanged: () => {
        ports.storage.changed();
        ports.publishSession("change-password");
      },
      renamed: (label) => {
        const summary = ports.keys.coordinatorActiveKeySummary();
        if (summary) ports.keys.setCoordinatorActiveKeySummary({ ...summary, label });
      },
      assertSecretSession: () => {
        if (ports.session().vaultStatus !== "unlocked" || ports.session().sessionEpoch !== epoch || ports.session().activePublicKeyHex !== owner) throw new Error("Vault secret session is unavailable");
      },
      deriveLocalSecretKey: (scope) => ports.keys.vaultKeySession.deriveLocalSecretKey(scope),
    });
  }

  async function handleCrypto(
    requestId: string,
    request: { kind: "crypto"; operation: CoordinatorCryptoOperation; expectedSessionEpoch: SessionEpoch }
  ): Promise<CoordinatorResponse> {
    if (ports.session().vaultStatus !== "unlocked") {
      return {
        requestId,
        sessionEpoch: ports.session().sessionEpoch,
        ack: { status: "blocked", reason: { key: "background.blocked.unlock", fallback: "Vault is locked" } },
      };
    }

    // Crypto RPC 同样属于 session-bound 操作。尤其 Channel seal/open 内部
    // 会经过异步 SDK；如果 lock 或 active-key switch 在中途推进 epoch，旧
    // 结果不能以新 owner 的身份返回。
    if (request.expectedSessionEpoch !== ports.session().sessionEpoch) {
      return {
        requestId,
        sessionEpoch: ports.session().sessionEpoch,
        ack: { status: "stale-epoch" },
      };
    }

    if (!ports.keys.hasActiveWalletCrypto()) {
      return {
        requestId,
        sessionEpoch: ports.session().sessionEpoch,
        ack: { status: "blocked", reason: { key: "background.blocked.noActiveKey", fallback: "No active key" } },
      };
    }

    try {
      const result = await ports.io.run(
        "write",
        undefined,
        () => ports.keys.executeActiveWalletCrypto(request.operation),
        {
          auditOperation: "service.crypto.sign",
          // 签名只在 Worker 内计算；结果必须经过下方 epoch 检查以及
          // withCoordinatorFinalIoLease 的后置运行世代检查才会发布。
          // 页面刷新若终止 Worker，浏览器锁会自动释放；纯本地签名不需要
          // 额外的业务持久化租约；Worker 生命周期 authority lock 仍然必须
          // 在进入 withCoordinatorFinalIoLease 前已取得。
          durableLease: false,
        },
      );

      if (request.expectedSessionEpoch !== ports.session().sessionEpoch || ports.session().vaultStatus !== "unlocked" || !ports.keys.hasActiveWalletCrypto()) {
        return {
          requestId,
          sessionEpoch: ports.session().sessionEpoch,
          ack: { status: "stale-epoch" },
        };
      }

      return {
        requestId,
        sessionEpoch: ports.session().sessionEpoch,
        ack: { status: "ok" },
        cryptoResult: result,
      };
    } catch (err) {
      return {
        requestId,
        sessionEpoch: ports.session().sessionEpoch,
        ack: { status: "error", message: err instanceof Error ? err.message : String(err) },
      };
    }
  }
  const walletControl: VaultWorkerWalletControl = {
    coldStart: () => ports.wallet.requireWalletLifecycle().coldStart(),
    persistence: async () => await ports.wallet.walletStore?.persistence() ?? { persisted: false },
    closeHardware: () => ports.keys.hardwareConnections.close(),
    async execute(control) {
      if (control.type === "initialize") return ports.wallet.initializeWallet(control.plan);
      if (control.type === "lock") { await ports.binding.lock("storage-control"); return true; }
      if (control.type === "status" || control.type === "summary" || control.type === "cold-start") throw new Error("Storage projection is not a Vault command");
      return executeWalletControl(control, {
        lifecycle: ports.wallet.requireWalletLifecycle(),
        beforeRevoke: ports.storage.revokeBindingAndDrain,
        unlocked(result) {
          ports.commit({ sessionEpoch: result.sessionEpoch });
          ports.storage.changed();
          ports.publishSession("unlock");
        },
        locked() {
          ports.commit({ vaultStatus: "locked" });
          ports.keys.setCoordinatorActiveKeySummary(undefined);
          ports.storage.changed();
          ports.publishSession("lock");
        },
        passwordChanged() {
          ports.storage.changed();
          ports.publishSession("change-password");
        },
        reset() {
          ports.storage.discardBinding();
          ports.commit({ vaultStatus: "uninitialized" });
          ports.commit({ walletGeneration: "" });
          ports.commit({ activePublicKeyHex: undefined });
          ports.wallet.storageColdStartState = { state: "uninitialized" };
          ports.keys.setCoordinatorActiveKeySummary(undefined);
          ports.keys.dropActivePrivateKey();
          ports.storage.changed();
          ports.publishSession("reset-wallet");
        },
      });
    },
  };
  const route = defineWorkerRequestRoute<Extract<CoordinatorClientRequest, { kind: "unlock" | "vault.operation" | "crypto" }>>({
    kinds: ["unlock", "vault.operation", "crypto"],
    policy(request) {
      const hardware = request.kind === "vault.operation" && request.operation.type === "hardware";
      return {
        scheduling: hardware || request.kind === "vault.operation" && ["payment", "getCurrentKey"].includes(request.operation.type) ? "parallel" : "serial",
        validateEpoch: !hardware,
        activatesWallet: request.kind === "unlock" || request.kind === "vault.operation" && (request.operation.type !== "hardware" || !["state", "disconnect"].includes(request.operation.command.action))
      };
    },
    async execute(request, call) {
      if (request.kind === "unlock") return handleUnlock(call.requestId, request);
      if (request.kind === "crypto") return handleCrypto(call.requestId, request);
      if (request.operation.type === "hardware") return handleHardwareConnection(request, call.peerId, call.signal);
      return handleVaultOperation(call.requestId, request);
    },
    prepare(request) {
      const command = request.kind === "vault.operation" && request.operation.type === "hardware" ? request.operation.command : undefined;
      const port = command && "port" in command ? command.port : undefined;
      return { dispose(response) { if (port && response?.ack.status !== "ok") { try { port.close(); } catch { } } } };
    },
  });
  return { route, walletControl, handleUnlock, handleUnlockUnsafe, handleHardwareConnection, handleVaultOperation, vaultOperationIoKind, currentKeySummary, adoptUnlockedKey, migrateHardwareToSoftware, migrateSoftwareToHardware, executeVaultOperation, handleCrypto, clearVaultOperationSecrets };
}
