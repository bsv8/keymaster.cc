import { describe, expect, it } from "vitest";
import { buildKeyBackupEnvelope, encodeKeyBackup, decodeKeyBackup, passwordBackupView } from "./keyBackup.js";

describe("keyBackup", () => {
  it("round-trips a backup envelope", () => {
    const payload = encodeKeyBackup({
      backupVersion: 1,
      sourceVaultMeta: {
        id: "singleton",
        cryptoVersion: "v2",
        kdf: "pbkdf2-sha256",
        iterations: 200_000,
        keyLengthBits: 256,
        saltB64: "salt",
        verifierSaltB64: "vsalt",
        verifierIvB64: "viv",
        verifierCipherB64: "vcipher",
        createdAt: "2026-07-17T00:00:00.000Z"
      },
      keyRecord: {
        publicKeyHex: "02".padEnd(66, "a"),
        cipherVersion: "v2",
        label: "key",
        address: "addr",
        network: "main",
        format: "hex",
        capabilities: ["p2pkh"],
        createdAt: "2026-07-17T00:00:00.000Z",
        cipherSaltB64: "csalt",
        cipherIvB64: "civ",
        cipherB64: "ciph"
      }
    });

    const decoded = decodeKeyBackup(payload);
    expect(decoded.backupVersion).toBe(1);
    expect(passwordBackupView(decoded).keyRecord.publicKeyHex).toMatch(/^02/);
  });

  it("rejects malformed payloads", () => {
    expect(() => decodeKeyBackup("{}")).toThrow(/Unsupported key backup version/);
  });

  it("exports password and multiple passkeys as independent named protectors", () => {
    const meta = {
      id: "singleton" as const,
      saltB64: "salt",
      verifierSaltB64: "vsalt",
      verifierIvB64: "viv",
      verifierCipherB64: "vcipher",
      createdAt: "2026-07-17T00:00:00.000Z"
    };
    const key = {
      publicKeyHex: "02".padEnd(66, "a"),
      cipherVersion: "v2" as const,
      label: "key",
      address: "",
      network: "main" as const,
      format: "generated",
      capabilities: ["p2pkh"],
      createdAt: "2026-07-17T00:00:00.000Z",
      cipherSaltB64: "csalt",
      cipherIvB64: "civ",
      cipherB64: "cipher",
      passkeyProtections: ["passkey01", "passkey02"].map((label, index) => ({
        id: `credential-${index}`,
        label,
        credentialIdB64: `credential-${index}`,
        prfSaltB64: `salt-${index}`,
        rpId: "keymaster.cc",
        createdAt: "2026-07-17T00:00:00.000Z",
        cipherVersion: "webauthn-prf-v1" as const,
        cipherIvB64: `iv-${index}`,
        cipherB64: `cipher-${index}`
      }))
    };
    const decoded = decodeKeyBackup(encodeKeyBackup(buildKeyBackupEnvelope(meta, key)));
    expect(decoded.backupVersion).toBe(2);
    if (decoded.backupVersion !== 2) throw new Error("expected v2");
    expect(Object.keys(decoded.protectors)).toEqual(["password", "passkey01", "passkey02"]);
    expect(passwordBackupView(decoded).keyRecord.passkeyProtections).toHaveLength(2);
  });
});
