export { installInsecureContextCryptoFallback, getEffectiveCryptoCapability } from "./crypto.js";
export { deriveKey, verifyVerifier, encryptVerifier, decryptBytesWithAad, encryptBytesWithAad, bytesToHex, hexToBytes } from "./crypto.js";
export { encryptBytesWithSaltBoundAad, decryptBytesWithSaltBoundAad } from "./crypto.js";
export * from "./vaultCoordinator.js";
export { deriveP2pkhAddress, signEcdsaDigest, verifySessionKeyPair } from "./sessionCryptoCore.js";
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
