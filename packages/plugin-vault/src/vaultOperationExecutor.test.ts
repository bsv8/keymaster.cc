import { expect, it, vi } from "vitest";
import { executeVaultOperation, type VaultOperationDependencies } from "./vaultOperationExecutor.js";

function dependencies(overrides: Partial<VaultOperationDependencies> = {}): VaultOperationDependencies {
  return {
    lifecycle: () => { throw new Error("unused lifecycle"); },
    currentKey: () => undefined,
    beforePasswordChange: async () => undefined,
    passwordChanged: () => undefined,
    renamed: () => undefined,
    assertSecretSession: () => undefined,
    deriveLocalSecretKey: async () => { throw new Error("unused derivation"); },
    ...overrides,
  };
}
it("rejects a retired session after asynchronous key derivation and clears caller plaintext", async () => {
  let finish!: (key: CryptoKey) => void;
  let active = true;
  const plaintext = new Uint8Array([1, 2, 3]);
  const run = executeVaultOperation({ type: "sealLocalSecret", scope: "plugin", plaintext }, dependencies({
    assertSecretSession: () => { if (!active) throw new Error("retired session"); },
    deriveLocalSecretKey: () => new Promise((resolve) => { finish = resolve; }),
  }));
  active = false;
  finish({} as CryptoKey);
  await expect(run).rejects.toThrow("retired session");
  expect([...plaintext]).toEqual([0, 0, 0]);
});
it("rejects invalid scopes before derivation and clears plaintext on failure", async () => {
  const deriveLocalSecretKey = vi.fn();
  const plaintext = new Uint8Array([1, 2]);
  await expect(executeVaultOperation({ type: "sealLocalSecret", scope: "bad\u0000scope", plaintext }, dependencies({ deriveLocalSecretKey }))).rejects.toThrow("Invalid secret scope");
  expect(deriveLocalSecretKey).not.toHaveBeenCalled();
  expect([...plaintext]).toEqual([0, 0]);
});
