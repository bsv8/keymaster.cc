import { describe, expect, it } from "vitest";
import { encodeKeyBackup, decodeKeyBackup } from "./keyBackup.js";

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
    expect(decoded.keyRecord.publicKeyHex).toMatch(/^02/);
  });

  it("rejects malformed payloads", () => {
    expect(() => decodeKeyBackup("{}")).toThrow(/Unsupported key backup version/);
  });
});
