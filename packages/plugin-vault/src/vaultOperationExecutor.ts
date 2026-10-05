import type { CoordinatorVaultOperation, KeyIdentity, WalletLifecycleService } from "@keymaster/contracts";
import { bytesToHex, hexToBytes, encryptBytesWithSaltBoundAad, decryptBytesWithSaltBoundAad } from "./crypto.js";

export interface VaultOperationDependencies {
  lifecycle(): WalletLifecycleService;
  currentKey(): KeyIdentity | undefined;
  beforePasswordChange(): Promise<void>;
  passwordChanged(): void;
  renamed(label: string): void;
  assertSecretSession(): void;
  deriveLocalSecretKey(scope: string): Promise<CryptoKey>;
}

function secretAad(scope: string): string {
  if (!scope || scope.length > 256 || /[\u0000-\u001f\u007f]/u.test(scope)) throw new Error("Invalid secret scope");
  return `keymaster:local-secret:v3|${scope}`;
}

/** Vault dispatches its operations; the coordinator owns session transitions and final I/O leases. */
export async function executeVaultOperation(operation: CoordinatorVaultOperation, deps: VaultOperationDependencies): Promise<unknown> {
  switch (operation.type) {
    case "getCurrentKey": {
      const key = deps.currentKey();
      return key ? { ...key, capabilities: [...key.capabilities], format: "keyhold" } : undefined;
    }
    case "verifyPassword":
      await deps.lifecycle().verifyPassword(operation.password);
      return true;
    case "changePassword": {
      const lifecycle = deps.lifecycle();
      await deps.beforePasswordChange();
      await lifecycle.changePassword({ oldPassword: operation.oldPassword, newPassword: operation.newPassword });
      deps.passwordChanged();
      return true;
    }
    case "renameKey":
      await deps.lifecycle().rename(operation.label);
      deps.renamed(operation.label);
      return true;
    case "exportKeyHold":
      return deps.lifecycle().exportKeyHold();
    case "sealLocalSecret": {
      try {
        deps.assertSecretSession();
        const aad = secretAad(operation.scope);
        const key = await deps.deriveLocalSecretKey(operation.scope);
        deps.assertSecretSession();
        const blob = await encryptBytesWithSaltBoundAad(key, operation.plaintext, aad);
        deps.assertSecretSession();
        return { version: 3, keySource: "active-key-hkdf-v1", saltHex: bytesToHex(blob.salt), nonceHex: bytesToHex(blob.iv), ciphertextHex: bytesToHex(blob.ciphertext) };
      } finally {
        operation.plaintext.fill(0);
      }
    }
    case "openLocalSecret": {
      deps.assertSecretSession();
      const aad = secretAad(operation.scope);
      const sealed = operation.sealed;
      if (sealed.version !== 3 || sealed.keySource !== "active-key-hkdf-v1") throw new Error("Legacy local secret requires explicit re-sealing with the current active key");
      const blob = { salt: hexToBytes(sealed.saltHex), iv: hexToBytes(sealed.nonceHex), ciphertext: hexToBytes(sealed.ciphertextHex) };
      const key = await deps.deriveLocalSecretKey(operation.scope);
      deps.assertSecretSession();
      const plaintext = await decryptBytesWithSaltBoundAad(key, blob, aad);
      try {
        deps.assertSecretSession();
        return plaintext;
      } catch (error) {
        plaintext.fill(0);
        throw error;
      }
    }
  }
}
