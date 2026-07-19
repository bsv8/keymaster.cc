export * from "./vaultDb.js";
export { deriveKey, verifyVerifier, encryptVerifier, encryptBytes, decryptBytes, decryptBytesWithAad, vaultKeyAad, base64ToBytes, bytesToHex, hexToBytes } from "./crypto.js";
export * from "./vaultCoordinator.js";
export { encodeKeyBackup, decodeKeyBackup, type KeyBackupEnvelope } from "./keyBackup.js";
export { deriveP2pkhAddress, signEcdsaDigest, decryptSessionPrivateKeyBytes, verifySessionKeyPair, sealAppMessageLocalBytes, openAppMessageLocalBytes } from "./sessionCryptoCore.js";
