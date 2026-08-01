import { describe, expect, it } from "vitest";
import { decryptMaterialWithPasskey, encryptMaterialWithPasskey } from "./webauthnPrf.js";

describe("WebAuthn PRF key protection", () => {
  it("lets independent PRF outputs protect the same private key", async () => {
    const publicKeyHex = "02".padEnd(66, "1");
    const material = { hex: "01".padStart(64, "0") };
    const firstSecret = crypto.getRandomValues(new Uint8Array(32));
    const secondSecret = crypto.getRandomValues(new Uint8Array(32));
    const first = await encryptMaterialWithPasskey({
      prfOutput: firstSecret,
      publicKeyHex,
      credentialIdB64: "credential-one",
      material
    });
    const second = await encryptMaterialWithPasskey({
      prfOutput: secondSecret,
      publicKeyHex,
      credentialIdB64: "credential-two",
      material
    });

    await expect(decryptMaterialWithPasskey({
      prfOutput: firstSecret,
      publicKeyHex,
      protection: {
        id: "credential-one",
        label: "passkey01",
        credentialIdB64: "credential-one",
        prfSaltB64: "salt-one",
        rpId: "keymaster.cc",
        createdAt: new Date(0).toISOString(),
        ...first
      }
    })).resolves.toEqual(material);
    expect(first.cipherB64).not.toBe(second.cipherB64);
  });

  it("fails closed for the wrong PRF output", async () => {
    const publicKeyHex = "02".padEnd(66, "1");
    const encrypted = await encryptMaterialWithPasskey({
      prfOutput: new Uint8Array(32).fill(1),
      publicKeyHex,
      credentialIdB64: "credential",
      material: { hex: "01".padStart(64, "0") }
    });
    await expect(decryptMaterialWithPasskey({
      prfOutput: new Uint8Array(32).fill(2),
      publicKeyHex,
      protection: {
        id: "credential",
        label: "passkey",
        credentialIdB64: "credential",
        prfSaltB64: "salt",
        rpId: "keymaster.cc",
        createdAt: new Date(0).toISOString(),
        ...encrypted
      }
    })).rejects.toBeTruthy();
  });
});
