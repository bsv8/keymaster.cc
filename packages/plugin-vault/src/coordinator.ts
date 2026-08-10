export * from "./vaultDb.js";
export { deriveKey, verifyVerifier, encryptVerifier, encryptBytes, decryptBytes, decryptBytesWithAad, encryptBytesWithAad, vaultKeyAad, base64ToBytes, bytesToHex, hexToBytes } from "./crypto.js";
export { encryptBytesWithSaltBoundAad, decryptBytesWithSaltBoundAad } from "./crypto.js";
export * from "./vaultCoordinator.js";
export { buildKeyBackupEnvelope, encodeKeyBackup, decodeKeyBackup, passwordBackupView, type KeyBackupEnvelope } from "./keyBackup.js";
export { encryptMaterialWithPasskey, decryptMaterialWithPasskey, toPasskeySummary } from "./webauthnPrf.js";
export { deriveP2pkhAddress, signEcdsaDigest, decryptSessionPrivateKeyBytes, verifySessionKeyPair, sealAppMessageLocalBytes, openAppMessageLocalBytes } from "./sessionCryptoCore.js";
