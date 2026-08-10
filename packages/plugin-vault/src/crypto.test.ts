import { describe, expect, it } from "vitest";
import {
  aesGcmKeyFromRawBits,
  decryptBytesWithAad,
  decryptBytesWithSaltBoundAad,
  encryptBytesWithAad,
  encryptBytesWithSaltBoundAad,
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
    const tamperedSalt = { ...blob, salt: new Uint8Array(blob.salt) };
    tamperedSalt.salt[0] = (tamperedSalt.salt[0] ?? 0) ^ 1;
    // Historical generic envelopes did not authenticate the metadata salt.
    await expect(decryptBytesWithAad(key, tamperedSalt, aad)).resolves.toEqual(plaintext);
  });

  it("binds the random salt for local secrets and detects salt tampering", async () => {
    const key = await aesGcmKeyFromRawBits(new Uint8Array(32).fill(3));
    const plaintext = new TextEncoder().encode("provider-secret");
    const first = await encryptBytesWithSaltBoundAad(key, plaintext, "keymaster:local-secret:v2|scope");
    const second = await encryptBytesWithSaltBoundAad(key, plaintext, "keymaster:local-secret:v2|scope");
    expect(Array.from(first.salt)).not.toEqual(Array.from(second.salt));
    expect(Array.from(first.iv)).not.toEqual(Array.from(second.iv));
    await expect(decryptBytesWithSaltBoundAad(key, first, "keymaster:local-secret:v2|scope")).resolves.toEqual(plaintext);
    const tampered = { ...first, salt: new Uint8Array(first.salt) };
    tampered.salt[0] = (tampered.salt[0] ?? 0) ^ 1;
    await expect(decryptBytesWithSaltBoundAad(key, tampered, "keymaster:local-secret:v2|scope")).rejects.toBeTruthy();
    await expect(decryptBytesWithSaltBoundAad(key, first, "keymaster:local-secret:v2|other")).rejects.toBeTruthy();
  });
});
