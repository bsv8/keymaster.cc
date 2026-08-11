import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPasskeyPrf,
  decryptMaterialWithPasskey,
  encryptMaterialWithPasskey,
  PasskeyPrfOnCreateRequiredError
} from "./webauthnPrf.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as typeof globalThis & {
    __KEYMASTER_WEBAUTHN_PRF_DIAGNOSTICS__?: unknown;
  }).__KEYMASTER_WEBAUTHN_PRF_DIAGNOSTICS__;
  delete (globalThis as typeof globalThis & {
    __KEYMASTER_PROBE_LAST_PRF_GET__?: unknown;
  }).__KEYMASTER_PROBE_LAST_PRF_GET__;
});

describe("WebAuthn PRF key protection", () => {
  it("lets independent PRF outputs protect the same private key", async () => {
    const publicKeyHex = "02".padEnd(66, "1");
    const privateKeyBytes = new Uint8Array(32);
    privateKeyBytes[31] = 1;
    const firstSecret = crypto.getRandomValues(new Uint8Array(32));
    const secondSecret = crypto.getRandomValues(new Uint8Array(32));
    const first = await encryptMaterialWithPasskey({
      prfOutput: firstSecret,
      publicKeyHex,
      credentialIdB64: "credential-one",
      privateKeyBytes
    });
    const second = await encryptMaterialWithPasskey({
      prfOutput: secondSecret,
      publicKeyHex,
      credentialIdB64: "credential-two",
      privateKeyBytes
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
    })).resolves.toEqual(privateKeyBytes);
    expect(first.cipherB64).not.toBe(second.cipherB64);
  });

  it("fails closed for the wrong PRF output", async () => {
    const publicKeyHex = "02".padEnd(66, "1");
    const encrypted = await encryptMaterialWithPasskey({
      prfOutput: new Uint8Array(32).fill(1),
      publicKeyHex,
      credentialIdB64: "credential",
      privateKeyBytes: new Uint8Array(32).fill(1)
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

  it("completes passkey creation from the create-time PRF without a second assertion", async () => {
    const prfOutput = new Uint8Array(32).fill(7);
    const get = vi.fn();
    const create = vi.fn(async () => makeCredential({
      enabled: true,
      results: { first: prfOutput.buffer }
    }));
    installWebAuthn({ create, get });

    const result = await createPasskeyPrf({
      label: "Phone",
      publicKeyHex: "02".padEnd(66, "1")
    });

    expect(result.prfOutput).toEqual(prfOutput);
    expect(create).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
  });

  it("strictly rejects a passkey that omits PRF on create without opening a login prompt", async () => {
    const get = vi.fn(async () => makeAssertionCredential({}));
    const create = vi.fn(async () => makeCredential({ enabled: true }));
    installWebAuthn({ create, get });

    await expect(createPasskeyPrf({
      label: "Phone",
      publicKeyHex: "02".padEnd(66, "1")
    })).rejects.toBeInstanceOf(PasskeyPrfOnCreateRequiredError);

    expect(create).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
    const diagnostics = (globalThis as typeof globalThis & {
      __KEYMASTER_WEBAUTHN_PRF_DIAGNOSTICS__?: Array<{
        event: string;
        details: Record<string, unknown>;
      }>;
    }).__KEYMASTER_WEBAUTHN_PRF_DIAGNOSTICS__ ?? [];
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "credentials.create.response",
        details: expect.objectContaining({
          prfEnabled: true,
          prfFirstBytes: 0
        })
      }),
      expect.objectContaining({
        event: "strict-mode.rejected",
        details: expect.objectContaining({
          secondCredentialsGetAttempted: false
        })
      })
    ]));

    const probe = (globalThis as typeof globalThis & {
      __KEYMASTER_PROBE_LAST_PRF_GET__?: () => Promise<Record<string, unknown>>;
    }).__KEYMASTER_PROBE_LAST_PRF_GET__;
    expect(probe).toBeTypeOf("function");
    await expect(probe!()).resolves.toMatchObject({ status: "error" });
    expect(get).toHaveBeenCalledTimes(1);
  });
});

function installWebAuthn(input: {
  create: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
}): void {
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("PublicKeyCredential", class PublicKeyCredential {});
  vi.stubGlobal("navigator", {
    credentials: {
      create: input.create,
      get: input.get
    }
  });
}

function makeCredential(prf: {
  enabled?: boolean;
  results?: { first?: BufferSource };
}): PublicKeyCredential {
  const authenticatorData = new Uint8Array(37);
  authenticatorData[32] = 0x45;
  return {
    type: "public-key",
    rawId: new Uint8Array([1, 2, 3]).buffer,
    authenticatorAttachment: "platform",
    response: {
      clientDataJSON: new TextEncoder().encode(JSON.stringify({
        type: "webauthn.create",
        challenge: "redacted-test-challenge",
        origin: "https://keymaster.cc",
        crossOrigin: false
      })).buffer,
      attestationObject: new Uint8Array([1, 2, 3, 4]).buffer,
      getTransports: () => ["internal"],
      getAuthenticatorData: () => authenticatorData.buffer,
      getPublicKey: () => new Uint8Array([5, 6, 7]).buffer,
      getPublicKeyAlgorithm: () => -7
    },
    getClientExtensionResults: () => ({ prf })
  } as unknown as PublicKeyCredential;
}

function makeAssertionCredential(prf: {
  enabled?: boolean;
  results?: { first?: BufferSource };
}): PublicKeyCredential {
  const authenticatorData = new Uint8Array(37);
  authenticatorData[32] = 0x1d;
  return {
    type: "public-key",
    rawId: new Uint8Array([1, 2, 3]).buffer,
    authenticatorAttachment: "cross-platform",
    response: {
      clientDataJSON: new TextEncoder().encode(JSON.stringify({
        type: "webauthn.get",
        challenge: "redacted-test-challenge",
        origin: "https://keymaster.cc",
        crossOrigin: false
      })).buffer,
      authenticatorData: authenticatorData.buffer,
      signature: new Uint8Array([8, 9, 10]).buffer,
      userHandle: new Uint8Array([11, 12]).buffer
    },
    getClientExtensionResults: () => ({ prf })
  } as unknown as PublicKeyCredential;
}
