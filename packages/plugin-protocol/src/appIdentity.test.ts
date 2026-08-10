import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { AppIdentityProofV1 } from "@keymaster/contracts";
import { identityDigestBytes, verifyAppIdentityProof } from "./appIdentity.js";

const PRIVATE_KEY = new Uint8Array(32).fill(7);

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function proof(overrides: Record<string, unknown> = {}) {
  const publisherPublicKey = hex(secp256k1.getPublicKey(PRIVATE_KEY, true));
  const value: Record<string, unknown> = {
    version: 1,
    publisherPublicKey,
    app: { id: "demo.app", name: "Demo App" },
    ...overrides
  };
  const signature = secp256k1.sign(identityDigestBytes(value as unknown as AppIdentityProofV1), PRIVATE_KEY, { prehash: false, format: "compact" });
  return { ...value, signature: hex(signature) } as AppIdentityProofV1;
}

describe("App Identity proof", () => {
  it("matches the KeymasterAppPackCore identity digest golden vector", () => {
    expect(hex(identityDigestBytes({
      version: 1,
      publisherPublicKey: "0284bf7562262bbd6940085748f3be6afa52ae317155181ece31b66351ccffa4b0",
      app: { id: "fixture", name: "Fixture" },
      signature: "0".repeat(128)
    }))).toBe("383e5c563e8df27758a38c6956c7ff651259682e127fb1b18093834bb34ffd0c");
  });

  it("verifies the domain-separated compact signature and records its digest", () => {
    const result = verifyAppIdentityProof(proof());
    expect(result.appId).toBe("demo.app");
    expect(result.publisherPublicKeyHex).toMatch(/^(02|03)/);
    expect(result.identityDigestHex).toHaveLength(64);
  });

  it("is independent of JSON field order but rejects tampering", () => {
    const signed = proof();
    const reordered = {
      signature: signed.signature,
      app: { name: "Demo App", id: "demo.app" },
      publisherPublicKey: signed.publisherPublicKey,
      version: 1
    };
    expect(verifyAppIdentityProof(reordered).identityDigestHex).toBe(verifyAppIdentityProof(signed).identityDigestHex);
    expect(() => verifyAppIdentityProof({ ...signed, app: { id: "demo.app", name: "Tampered" } })).toThrow();
    expect(() => verifyAppIdentityProof({ ...signed, version: 2 })).toThrow();
    expect(() => verifyAppIdentityProof({ ...signed, extra: true })).toThrow();
  });

  it.each(["/absolute", "has\\backslash", "has\u0000nul", "bad\ufffdreplacement"]) (
    "rejects unsafe app ids: %s",
    (appId) => expect(() => verifyAppIdentityProof(proof({ app: { id: appId, name: "Demo App" } }))).toThrow()
  );

  it("rejects the permissive identity forms accepted by the old validator", () => {
    const signed = proof();
    expect(() => verifyAppIdentityProof({ ...signed, publisherPublicKey: signed.publisherPublicKey.toUpperCase() })).toThrow();
    expect(() => verifyAppIdentityProof({ ...signed, signature: signed.signature.toUpperCase() })).toThrow();
    expect(() => verifyAppIdentityProof({ ...signed, app: { id: "A".repeat(64), name: "Demo App" } })).toThrow();
    expect(() => verifyAppIdentityProof({ ...signed, app: { id: "demo.app", name: "🙂".repeat(121) } })).toThrow();
    expect(() => verifyAppIdentityProof({ ...signed, app: { id: "demo.app", name: "   " } })).toThrow();
  });
});
