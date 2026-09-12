import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aesGcmKeyFromRawBits,
  decryptBytesWithAad,
  decryptBytesWithSaltBoundAad,
  encryptBytesWithAad,
  encryptBytesWithSaltBoundAad,
  encryptVerifier,
  deriveKeyRawBits,
  installInsecureContextCryptoFallback,
  verifyVerifier,
  VAULT_VERIFIER_AAD
} from "./crypto.js";

const originalCrypto = globalThis.crypto;
const originalSecureContext = globalThis.isSecureContext;

function asStrictArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as unknown as ArrayBuffer;
}

afterEach(() => {
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });
  if (originalSecureContext === undefined) {
    Reflect.deleteProperty(globalThis as typeof globalThis & { isSecureContext?: boolean }, "isSecureContext");
  }
  else Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: originalSecureContext });
  vi.restoreAllMocks();
});

describe("crypto", () => {
  it("provides PBKDF2/AES-GCM and randomUUID on an insecure HTTP-like realm", async () => {
    const nativeSubtle = originalCrypto.subtle;
    vi.stubGlobal("isSecureContext", false);
    vi.stubGlobal("crypto", {
      getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto)
    });

    const capability = installInsecureContextCryptoFallback();
    expect(capability).toEqual({ mode: "insecure-context-fallback", subtle: true, secureContext: false });
    expect(globalThis.crypto.randomUUID()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);

    const password = new TextEncoder().encode("http-password");
    const salt = new Uint8Array(16).fill(4);
    const fallbackBaseKey = await globalThis.crypto.subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
    const fallbackBits = await globalThis.crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations: 2, hash: "SHA-256" },
      fallbackBaseKey,
      256
    );
    const nativeBaseKey = await nativeSubtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
    const nativeBits = await nativeSubtle.deriveBits(
      { name: "PBKDF2", salt, iterations: 2, hash: "SHA-256" },
      nativeBaseKey,
      256
    );
    expect(new Uint8Array(fallbackBits)).toEqual(new Uint8Array(nativeBits));

    const hmacKeyMaterial = new Uint8Array(32).fill(0x0b);
    const hmacData = new TextEncoder().encode("http-hmac");
    const fallbackHmacKey = await globalThis.crypto.subtle.importKey(
      "raw",
      hmacKeyMaterial,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const fallbackHmac = await globalThis.crypto.subtle.sign("HMAC", fallbackHmacKey, hmacData);
    const nativeHmacKey = await nativeSubtle.importKey(
      "raw",
      hmacKeyMaterial,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const nativeHmac = await nativeSubtle.sign("HMAC", nativeHmacKey, hmacData);
    expect(new Uint8Array(fallbackHmac)).toEqual(new Uint8Array(nativeHmac));

    const key = await globalThis.crypto.subtle.importKey("raw", new Uint8Array(32).fill(8), { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const iv = new Uint8Array(12).fill(2);
    const aad = new TextEncoder().encode("http-aad");
    const plaintext = new TextEncoder().encode("local encrypted data");
    const ciphertext = await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, plaintext);
    const nativeKey = await nativeSubtle.importKey("raw", new Uint8Array(32).fill(8), { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const decrypted = await nativeSubtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, nativeKey, ciphertext);
    expect(new Uint8Array(decrypted)).toEqual(plaintext);

    // The application envelope carries the same WebCrypto AES-GCM ciphertext
    // and tag bytes; a native reader must accept fallback-produced records.
    const envelope = await encryptBytesWithAad(key, plaintext, "http-envelope");
    const nativeEnvelopeKey = await nativeSubtle.importKey("raw", new Uint8Array(32).fill(8), { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const nativeEnvelopePlaintext = await nativeSubtle.decrypt(
      { name: "AES-GCM", iv: asStrictArrayBuffer(envelope.iv), additionalData: asStrictArrayBuffer(new TextEncoder().encode("http-envelope")) },
      nativeEnvelopeKey,
      asStrictArrayBuffer(envelope.ciphertext)
    );
    expect(new Uint8Array(nativeEnvelopePlaintext)).toEqual(plaintext);

    // And a previously native-produced record remains readable after the
    // insecure-context backend is installed.
    const nativeIv = new Uint8Array(12).fill(6);
    const nativeCiphertext = await nativeSubtle.encrypt(
      { name: "AES-GCM", iv: nativeIv, additionalData: new TextEncoder().encode("http-envelope") },
      nativeEnvelopeKey,
      plaintext
    );
    await expect(decryptBytesWithAad(key, { salt: envelope.salt, iv: nativeIv, ciphertext: new Uint8Array(nativeCiphertext) }, "http-envelope"))
      .resolves.toEqual(plaintext);
  });

  it("does not replace a native secure-context subtle implementation", () => {
    vi.stubGlobal("isSecureContext", true);
    const before = globalThis.crypto;
    expect(installInsecureContextCryptoFallback()).toMatchObject({ mode: "native", subtle: true, secureContext: true });
    expect(globalThis.crypto).toBe(before);
  });

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
    const aad = "keymaster:generic-envelope:v2";
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
