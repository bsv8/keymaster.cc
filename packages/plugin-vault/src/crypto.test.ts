import { describe, expect, it } from "vitest";
import {
  aesGcmKeyFromRawBits,
  decryptBytesWithAad,
  encryptBytesWithAad,
  encryptVerifier,
  deriveKeyRawBits,
  verifyVerifier,
  VAULT_KEY_AAD_PREFIX,
  VAULT_VERIFIER_AAD
} from "./crypto.js";

describe("crypto", () => {
  it("uses the fixed verifier marker", async () => {
    const salt = new Uint8Array(16);
    salt.fill(7);
    const raw = await deriveKeyRawBits("password", salt);
    const key = await aesGcmKeyFromRawBits(raw);
    const verifier = await encryptVerifier(key);
    await expect(verifyVerifier(key, verifier)).resolves.toBe(true);
  });

  it("supports explicit AAD for key blobs", async () => {
    const salt = new Uint8Array(16);
    salt.fill(9);
    const raw = await deriveKeyRawBits("password", salt);
    const key = await aesGcmKeyFromRawBits(raw);
    const aad = `${VAULT_KEY_AAD_PREFIX}02${"a".repeat(64)}`;
    const plaintext = new TextEncoder().encode("hello");
    const blob = await encryptBytesWithAad(key, plaintext, aad);
    const roundTrip = await decryptBytesWithAad(key, blob, aad);
    expect(new TextDecoder().decode(roundTrip)).toBe("hello");
    expect(blob.version).toBe("v2");
    expect(VAULT_VERIFIER_AAD).toContain("vault-verifier");
  });
});
