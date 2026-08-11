import { describe, expect, it } from "vitest";
import { deriveKey, encryptVerifier } from "./crypto.js";
import { buildVaultMeta, resolveVaultPasswordKey, verifyVaultPasswordKey } from "./vaultCoordinator.js";

describe("vaultCoordinator KeyHold hard switch", () => {
  it("builds canonical v2 metadata", async () => {
    const key = await deriveKey("pw", new Uint8Array(16));
    const verifier = await encryptVerifier(key);
    const meta = buildVaultMeta({ salt: new Uint8Array(16), verifier });
    expect(meta.cryptoVersion).toBe("v2");
    expect(meta.kdf).toBe("pbkdf2-sha256");
  });

  it("verifies the vault password without exposing private material", async () => {
    const salt = new Uint8Array(16);
    const key = await deriveKey("pw", salt);
    const verifier = await encryptVerifier(key);
    const meta = buildVaultMeta({ salt, verifier });
    await expect(verifyVaultPasswordKey("pw", meta)).resolves.toBeDefined();
    await expect(resolveVaultPasswordKey("wrong", meta)).rejects.toThrow("Invalid password");
  });
});
