import { defineWorkerRequestRoute } from "@keymaster/contracts";
import { executeWorkerUnlock } from "./coordinator.js";
import type { SessionEpoch, CoordinatorResponse, CoordinatorCryptoOperation, CoordinatorVaultOperation } from "@keymaster/contracts";
import type { KeyIdentity } from "@keymaster/contracts";
import { executeWalletControl, executeVaultOperation as executeOwnedVaultOperation } from "./coordinator.js";
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
    token(): object | undefined; hasRoot(): boolean;
    revokeGrants(): void; invalidateClients(): void; unavailable(message: string): Error; failure(error: unknown): void; errorResponse(requestId: string, error: unknown): CoordinatorResponse; changed(): void; revokeBindingAndDrain(reason: string): Promise<void>; discardBinding(): void
  };
  binding: { installRoot(): Promise<void>; loadSettings(): Promise<void>; ensureStorage(): Promise<unknown>; ensureTasks(): Promise<void>; complete(cause?: "initialize" | "unlock"): Promise<void>; lock(reason: string): Promise<void> };
  io: {
    assertAuthority(): Promise<void>; closeSession(reason: string): void;
    run<T>(kind: "read" | "write", signal: AbortSignal | undefined, execute: () => Promise<T>, options: { auditOperation: "vault.operation" | "vault.unlock" | "service.crypto.sign"; allowLocalLock?: boolean; allowLocalOwnerTransition?: boolean; walletMigration?: boolean; durableLease?: boolean }): Promise<T>
  };
}
/** Vault 仓库操作归插件；公共层仅提交会话与提供 I/O 栅栏。无硬件、无迁移、无审批。 */
export function createVaultWorkerOperations(ports: VaultWorkerOperationsPorts) {
  function clearVaultOperationSecrets(operation: CoordinatorVaultOperation): void {
    switch (operation.type) {
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

  async function handleVaultOperation(requestId: string, request: { kind: "vault.operation"; operation: CoordinatorVaultOperation }): Promise<CoordinatorResponse> {
    try {
      const ioKind = vaultOperationIoKind(request.operation);
      const result = await ports.io.run(
        ioKind,
        undefined,
        () => executeVaultOperation(request.operation),
        {
          allowLocalLock: true,
          allowLocalOwnerTransition: true,
          auditOperation: "vault.operation",
          durableLease: ioKind === "write",
        },
      );
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
    ports.storage.revokeGrants();
    ports.commit({ walletGeneration: input.walletGeneration });
    ports.commit({ sessionEpoch: input.sessionEpoch });
    ports.commit({ vaultStatus: "unlocked" });
    ports.commit({ activePublicKeyHex: input.publicKeyHex });
    ports.keys.replaceActivePrivateKey(input.privateKeyBytes);
    ports.keys.setCoordinatorActiveKeySummary(input.identity);
    ports.publishWallet();
    ports.clearActivationCredential();
  }

  async function executeVaultOperation(operation: CoordinatorVaultOperation): Promise<unknown> {
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
    async execute(control) {
      if (control.type === "initialize") return ports.wallet.initializeWallet(control.plan);
      if (control.type === "lock") { await ports.binding.lock("storage-control"); return true; }
      if (control.type === "status" || control.type === "summary" || control.type === "cold-start") throw new Error("Storage projection is not a Vault command");
      const { executeWalletControl } = await import("./coordinator.js");
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
      return {
        scheduling: request.kind === "vault.operation" && ["getCurrentKey"].includes(request.operation.type) ? "parallel" : "serial",
        validateEpoch: true,
        activatesWallet: request.kind === "unlock",
      };
    },
    async execute(request, call) {
      if (request.kind === "unlock") return handleUnlock(call.requestId, request);
      if (request.kind === "crypto") return handleCrypto(call.requestId, request);
      return handleVaultOperation(call.requestId, request);
    },
  });
  return { route, walletControl, handleUnlock, handleUnlockUnsafe, handleVaultOperation, vaultOperationIoKind, currentKeySummary, adoptUnlockedKey, executeVaultOperation, handleCrypto, clearVaultOperationSecrets };
}
