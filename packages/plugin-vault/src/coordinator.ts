export { installInsecureContextCryptoFallback, getEffectiveCryptoCapability } from "./crypto.js";
export { deriveKey, verifyVerifier, encryptVerifier, decryptBytesWithAad, encryptBytesWithAad, bytesToHex, hexToBytes } from "./crypto.js";
export { encryptBytesWithSaltBoundAad, decryptBytesWithSaltBoundAad } from "./crypto.js";
export * from "./vaultCoordinator.js";
export { signEcdsaDigest, verifySessionKeyPair } from "./sessionCryptoCore.js";
export { generatePrivateKeyHex } from "./keyIdentity.js";

export { createWorkerKeySession, signPrivateMessageForFixture } from "./workerKeySession.js";

export { createWalletLifecycleService, type WalletLifecycleDeps } from "./walletLifecycleService.js";
export { createWalletKeyRepository, WALLET_KEYHOLD_FILE_PATH, type WalletKeyRepository, type UnlockedWalletKey, type WalletKeyFile } from "./walletKeyRepository.js";

export { createWorkerIdentityProjection } from "./workerIdentityProjection.js";
export { createWorkerActiveKeyCryptoFactory } from "./workerActiveKeyCrypto.js";
export { createWorkerCryptoRpc } from "./workerCryptoRpc.js";
export { executeWalletControl } from "./walletControlExecutor.js";
export { executeVaultOperation } from "./vaultOperationExecutor.js";
export { createWorkerAutoLock } from "./workerAutoLock.js";
export { executeWorkerUnlock } from "./workerUnlock.js";

export { createWalletStateAccess, createWalletStateSource } from "./walletStateAccess.js";

export { inspectWalletKeyBytes } from "./walletKeyRepository.js";
export { createAndVerifyMigrationKeyHold } from "./migrationKeyHold.js";

/** Worker-local wallet I/O admission (local copy, no VaultLink dependency).
 * Migration admission is no longer used, but the fence object is retained
 * so workerAuthority/final-IO-lease integration keeps its shape. */
export class WalletMigrationFence {
  private active = new Set<symbol>();
  private exclusive: symbol | undefined;
  private notify = new Set<() => void>();
  async acquire(migration = false, signal?: AbortSignal): Promise<{ release(): void }> {
    if (signal?.aborted) throw Error("migration-session-revoked");
    if (this.exclusive) throw Error("migration-pending");
    const id = Symbol();
    if (migration) {
      this.exclusive = id;
      try {
        while (this.active.size) {
          await new Promise<void>((resolve, reject) => {
            const changed = () => { cleanup(); resolve(); };
            const aborted = () => { cleanup(); reject(Error("migration-session-revoked")); };
            const cleanup = () => { this.notify.delete(changed); signal?.removeEventListener("abort", aborted); };
            this.notify.add(changed);
            signal?.addEventListener("abort", aborted, { once: true });
            if (signal?.aborted) aborted();
          });
        }
        if (signal?.aborted) throw Error("migration-session-revoked");
      } catch (error) { if (this.exclusive === id) this.exclusive = undefined; throw error; }
    }
    this.active.add(id);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active.delete(id);
        if (this.exclusive === id) this.exclusive = undefined;
        for (const changed of [...this.notify]) changed();
      },
    };
  }
}
