// Public Window assembly; private Worker services and management UI stay inside Vault.
export { vaultPlugin, vaultSetup, VAULT_CAPABILITY } from "./manifest.js";
export { installInsecureContextCryptoFallback } from "./crypto.js";
export { createSessionCryptoEngine } from "./sessionCryptoClient.js";
export type { SessionCryptoClientOptions, SessionCryptoEngine } from "./sessionCryptoClient.js";
