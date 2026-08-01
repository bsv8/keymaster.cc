import type { PasskeyProtection } from "@keymaster/contracts";
import {
  aesGcmKeyFromRawBits,
  bytesToHex,
  decryptBytesWithAad,
  encryptBytesWithAad,
  hexToBytes
} from "./crypto.js";
import type { VaultKeyMaterial } from "./vaultCoordinator.js";
import type { VaultPasskeyProtectionRecord } from "./vaultDb.js";

type PrfExtensionResult = {
  prf?: {
    enabled?: boolean;
    results?: { first?: ArrayBuffer };
  };
};

type PrfCredential = PublicKeyCredential & {
  getClientExtensionResults(): AuthenticationExtensionsClientOutputs & PrfExtensionResult;
};

export interface CreatedPasskeyPrf {
  credentialIdB64: string;
  prfSaltB64: string;
  prfOutput: Uint8Array;
  rpId: string;
  transports?: string[];
}

export function isWebAuthnPrfAvailable(): boolean {
  return Boolean(
    globalThis.isSecureContext &&
      typeof PublicKeyCredential !== "undefined" &&
      typeof navigator !== "undefined" &&
      navigator.credentials
  );
}

export async function createPasskeyPrf(input: {
  label: string;
  publicKeyHex: string;
}): Promise<CreatedPasskeyPrf> {
  assertAvailable();
  const prfSalt = randomBytes(32);
  const rpId = globalThis.location?.hostname || "localhost";
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: toArrayBuffer(randomBytes(32)),
      rp: { name: "Keymaster", id: rpId },
      user: {
        id: toArrayBuffer(randomBytes(32)),
        name: `key-${input.publicKeyHex.slice(0, 16)}`,
        displayName: input.label
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 }
      ],
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required"
      },
      timeout: 60_000,
      attestation: "none",
      extensions: {
        prf: { eval: { first: toArrayBuffer(prfSalt) } }
      } as AuthenticationExtensionsClientInputs
    }
  })) as PrfCredential | null;
  if (!credential) throw new Error("Passkey creation was cancelled");

  const credentialIdB64 = bytesToBase64Url(new Uint8Array(credential.rawId));
  let prfOutput = readPrfOutput(credential);
  if (!prfOutput) {
    prfOutput = await requestPasskeyPrf({ credentialIdB64, prfSaltB64: bytesToBase64Url(prfSalt), rpId });
  }
  const response = credential.response as AuthenticatorAttestationResponse;
  const transports = typeof response.getTransports === "function" ? response.getTransports() : undefined;
  return {
    credentialIdB64,
    prfSaltB64: bytesToBase64Url(prfSalt),
    prfOutput,
    rpId,
    transports
  };
}

export async function requestPasskeyPrf(input: {
  credentialIdB64: string;
  prfSaltB64: string;
  rpId: string;
  transports?: string[];
}): Promise<Uint8Array> {
  assertAvailable();
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: toArrayBuffer(randomBytes(32)),
      rpId: input.rpId,
      allowCredentials: [
        {
          id: toArrayBuffer(base64UrlToBytes(input.credentialIdB64)),
          type: "public-key",
          transports: input.transports as AuthenticatorTransport[] | undefined
        }
      ],
      userVerification: "required",
      timeout: 60_000,
      extensions: {
        prf: { eval: { first: toArrayBuffer(base64UrlToBytes(input.prfSaltB64)) } }
      } as AuthenticationExtensionsClientInputs
    }
  })) as PrfCredential | null;
  if (!credential) throw new Error("Passkey verification was cancelled");
  const output = readPrfOutput(credential);
  if (!output || output.byteLength !== 32) {
    throw new Error("This passkey or browser does not support the WebAuthn PRF extension");
  }
  return output;
}

export async function encryptMaterialWithPasskey(input: {
  prfOutput: Uint8Array;
  publicKeyHex: string;
  credentialIdB64: string;
  material: VaultKeyMaterial;
}): Promise<Pick<VaultPasskeyProtectionRecord, "cipherVersion" | "cipherIvB64" | "cipherB64">> {
  const key = await aesGcmKeyFromRawBits(input.prfOutput);
  const plaintext = new TextEncoder().encode(JSON.stringify(input.material));
  const encrypted = await encryptBytesWithAad(
    key,
    plaintext,
    passkeyAad(input.publicKeyHex, input.credentialIdB64)
  );
  return {
    cipherVersion: "webauthn-prf-v1",
    cipherIvB64: bytesToHex(encrypted.iv),
    cipherB64: bytesToHex(encrypted.ciphertext)
  };
}

export async function decryptMaterialWithPasskey(input: {
  prfOutput: Uint8Array;
  publicKeyHex: string;
  protection: VaultPasskeyProtectionRecord;
}): Promise<VaultKeyMaterial> {
  const key = await aesGcmKeyFromRawBits(input.prfOutput);
  const plaintext = await decryptBytesWithAad(
    key,
    {
      salt: new Uint8Array(),
      iv: hexToBytes(input.protection.cipherIvB64),
      ciphertext: hexToBytes(input.protection.cipherB64)
    },
    passkeyAad(input.publicKeyHex, input.protection.credentialIdB64)
  );
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as VaultKeyMaterial;
  if (typeof parsed.hex !== "string") throw new Error("Invalid passkey key material");
  return parsed;
}

export function toPasskeySummary(record: VaultPasskeyProtectionRecord): PasskeyProtection {
  return { id: record.id, label: record.label, rpId: record.rpId, createdAt: record.createdAt };
}

function readPrfOutput(credential: PrfCredential): Uint8Array | undefined {
  const value = credential.getClientExtensionResults().prf?.results?.first;
  if (!value) return undefined;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  return new Uint8Array(value as ArrayBuffer);
}

export function passkeyAad(publicKeyHex: string, credentialIdB64: string): string {
  return `keymaster:v1|vault-passkey|${publicKeyHex}|${credentialIdB64}`;
}

function assertAvailable(): void {
  if (!isWebAuthnPrfAvailable()) {
    throw new Error("WebAuthn PRF requires a secure context and a compatible browser");
  }
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
