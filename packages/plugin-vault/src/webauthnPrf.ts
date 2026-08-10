import type { PasskeyProtection } from "@keymaster/contracts";
import {
  aesGcmKeyFromRawBits,
  bytesToHex,
  hexToBytes
} from "./crypto.js";
import type { VaultKeyMaterial } from "./vaultCoordinator.js";
import type { VaultPasskeyProtectionRecord } from "./vaultDb.js";

type PrfExtensionResult = {
  prf?: {
    enabled?: boolean;
    results?: { first?: BufferSource };
  };
};

type PrfCredential = PublicKeyCredential & {
  getClientExtensionResults(): AuthenticationExtensionsClientOutputs & PrfExtensionResult;
};

type PublicKeyCredentialWithDiagnostics = typeof PublicKeyCredential & {
  getClientCapabilities?: () => Promise<Record<string, boolean>>;
};

type WebAuthnPrfDiagnosticEntry = {
  at: string;
  traceId: string;
  operation: "create" | "get";
  event: string;
  details: Record<string, unknown>;
};

type AnyBufferSource = ArrayBufferLike | ArrayBufferView<ArrayBufferLike>;

const WEBAUTHN_PRF_DIAGNOSTIC_GLOBAL = "__KEYMASTER_WEBAUTHN_PRF_DIAGNOSTICS__";
const WEBAUTHN_PRF_GET_PROBE_GLOBAL = "__KEYMASTER_PROBE_LAST_PRF_GET__";
const WEBAUTHN_PRF_DIAGNOSTIC_LIMIT = 100;
let lastRejectedCreateForProbe: {
  credentialIdB64: string;
  prfSaltB64: string;
  rpId: string;
  transports?: string[];
} | null = null;

export interface CreatedPasskeyPrf {
  credentialIdB64: string;
  prfSaltB64: string;
  prfOutput: Uint8Array;
  rpId: string;
  transports?: string[];
}

/** 严格单次模式：注册成功，但认证器没有在 create() 响应中直接返回 PRF。 */
export class PasskeyPrfOnCreateRequiredError extends Error {
  readonly code = "passkey_prf_on_create_required";

  constructor() {
    super("The selected passkey does not support returning PRF during creation");
    this.name = "PasskeyPrfOnCreateRequiredError";
  }
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
  installWebAuthnPrfGetProbe();
  lastRejectedCreateForProbe = null;
  const traceId = crypto.randomUUID();
  const startedAt = performance.now();
  const prfSalt = randomBytes(32);
  const challenge = randomBytes(32);
  const userId = randomBytes(32);
  const rpId = globalThis.location?.hostname || "localhost";
  writeWebAuthnPrfDiagnostic(traceId, "create", "start", {
    rpId,
    secureContext: globalThis.isSecureContext,
    strictSingleStep: true,
    requestedAlgorithms: [-7, -257],
    residentKey: "required",
    userVerification: "required",
    attestation: "none",
    prfEvalRequested: true,
    prfInputBytes: prfSalt.byteLength,
    prfInputSha256: await sha256Prefix(prfSalt),
    challengeBytes: challenge.byteLength,
    challengeSha256: await sha256Prefix(challenge),
    userIdBytes: userId.byteLength,
    userIdSha256: await sha256Prefix(userId),
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    userAgentData: navigatorUserAgentData(),
    diagnosticBuffer: `globalThis.${WEBAUTHN_PRF_DIAGNOSTIC_GLOBAL}`
  });
  await writeWebAuthnClientCapabilities(traceId, "create");

  let credential: PrfCredential | null;
  try {
    credential = (await navigator.credentials.create({
      publicKey: {
        challenge: toArrayBuffer(challenge),
        rp: { name: "Keymaster", id: rpId },
        user: {
          id: toArrayBuffer(userId),
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
  } catch (err) {
    writeWebAuthnPrfDiagnostic(traceId, "create", "credentials.create.error", {
      elapsedMs: elapsedMs(startedAt),
      error: errorSummary(err)
    }, "error");
    throw err;
  }
  if (!credential) {
    writeWebAuthnPrfDiagnostic(traceId, "create", "credentials.create.null", {
      elapsedMs: elapsedMs(startedAt)
    }, "warn");
    throw new Error("Passkey creation was cancelled");
  }

  const credentialIdB64 = bytesToBase64Url(new Uint8Array(credential.rawId));
  const extensionResults = credential.getClientExtensionResults();
  const prfOutput = readPrfOutput(extensionResults.prf);
  const response = credential.response as AuthenticatorAttestationResponse;
  const transports = typeof response.getTransports === "function" ? response.getTransports() : undefined;
  writeWebAuthnPrfDiagnostic(traceId, "create", "credentials.create.response", {
    elapsedMs: elapsedMs(startedAt),
    credentialType: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? null,
    credentialIdBytes: credential.rawId.byteLength,
    credentialIdSha256: await sha256Prefix(credential.rawId),
    responseType: response.constructor?.name ?? "unknown",
    transports: transports ?? [],
    extensionKeys: Object.keys(extensionResults),
    prfExtensionPresent: extensionResults.prf !== undefined,
    prfEnabled: extensionResults.prf?.enabled ?? null,
    prfResultsPresent: extensionResults.prf?.results !== undefined,
    prfFirstPresent: extensionResults.prf?.results?.first !== undefined,
    prfFirstBytes: prfOutput?.byteLength ?? 0,
    ...await attestationResponseSummary(response)
  });
  if (!prfOutput || prfOutput.byteLength !== 32) {
    // 严格单次模式：不允许在创建后自动补一次 credentials.get()。
    // 没有 create-time PRF 就拒绝该保护器，避免出现第二个登录弹窗。
    lastRejectedCreateForProbe = {
      credentialIdB64,
      prfSaltB64: bytesToBase64Url(prfSalt),
      rpId,
      transports
    };
    writeWebAuthnPrfDiagnostic(traceId, "create", "strict-mode.rejected", {
      elapsedMs: elapsedMs(startedAt),
      reason: !prfOutput ? "create-time-prf-missing" : "create-time-prf-invalid-length",
      prfEnabled: extensionResults.prf?.enabled ?? null,
      prfFirstBytes: prfOutput?.byteLength ?? 0,
      secondCredentialsGetAttempted: false,
      manualGetProbeAvailable: true,
      manualGetProbeCommand: `await globalThis.${WEBAUTHN_PRF_GET_PROBE_GLOBAL}()`
    }, "warn");
    throw new PasskeyPrfOnCreateRequiredError();
  }
  writeWebAuthnPrfDiagnostic(traceId, "create", "complete", {
    elapsedMs: elapsedMs(startedAt),
    prfOutputBytes: prfOutput.byteLength,
    secondCredentialsGetAttempted: false
  });
  lastRejectedCreateForProbe = null;
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
  const traceId = crypto.randomUUID();
  const startedAt = performance.now();
  const credentialId = base64UrlToBytes(input.credentialIdB64);
  const prfSalt = base64UrlToBytes(input.prfSaltB64);
  const challenge = randomBytes(32);
  writeWebAuthnPrfDiagnostic(traceId, "get", "start", {
    rpId: input.rpId,
    secureContext: globalThis.isSecureContext,
    allowCredentialCount: 1,
    credentialIdBytes: credentialId.byteLength,
    credentialIdSha256: await sha256Prefix(credentialId),
    transports: input.transports ?? [],
    userVerification: "required",
    prfEvalRequested: true,
    prfInputBytes: prfSalt.byteLength,
    prfInputSha256: await sha256Prefix(prfSalt),
    challengeBytes: challenge.byteLength,
    challengeSha256: await sha256Prefix(challenge),
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    userAgentData: navigatorUserAgentData(),
    diagnosticBuffer: `globalThis.${WEBAUTHN_PRF_DIAGNOSTIC_GLOBAL}`
  });
  await writeWebAuthnClientCapabilities(traceId, "get");

  let credential: PrfCredential | null;
  try {
    credential = (await navigator.credentials.get({
      publicKey: {
        challenge: toArrayBuffer(challenge),
        rpId: input.rpId,
        allowCredentials: [
          {
            id: toArrayBuffer(credentialId),
            type: "public-key",
            transports: input.transports as AuthenticatorTransport[] | undefined
          }
        ],
        userVerification: "required",
        timeout: 60_000,
        extensions: {
          prf: { eval: { first: toArrayBuffer(prfSalt) } }
        } as AuthenticationExtensionsClientInputs
      }
    })) as PrfCredential | null;
  } catch (err) {
    writeWebAuthnPrfDiagnostic(traceId, "get", "credentials.get.error", {
      elapsedMs: elapsedMs(startedAt),
      error: errorSummary(err)
    }, "error");
    throw err;
  }
  if (!credential) {
    writeWebAuthnPrfDiagnostic(traceId, "get", "credentials.get.null", {
      elapsedMs: elapsedMs(startedAt)
    }, "warn");
    throw new Error("Passkey verification was cancelled");
  }
  const extensionResults = credential.getClientExtensionResults();
  const output = readPrfOutput(extensionResults.prf);
  const response = credential.response as AuthenticatorAssertionResponse;
  writeWebAuthnPrfDiagnostic(traceId, "get", "credentials.get.response", {
    elapsedMs: elapsedMs(startedAt),
    credentialType: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? null,
    credentialIdBytes: credential.rawId.byteLength,
    credentialIdSha256: await sha256Prefix(credential.rawId),
    extensionKeys: Object.keys(extensionResults),
    prfExtensionPresent: extensionResults.prf !== undefined,
    prfResultsPresent: extensionResults.prf?.results !== undefined,
    prfFirstPresent: extensionResults.prf?.results?.first !== undefined,
    prfFirstBytes: output?.byteLength ?? 0,
    ...await assertionResponseSummary(response)
  });
  if (!output || output.byteLength !== 32) {
    writeWebAuthnPrfDiagnostic(traceId, "get", "rejected", {
      elapsedMs: elapsedMs(startedAt),
      reason: !output ? "prf-missing" : "prf-invalid-length",
      prfFirstBytes: output?.byteLength ?? 0
    }, "warn");
    throw new Error("This passkey or browser does not support the WebAuthn PRF extension");
  }
  writeWebAuthnPrfDiagnostic(traceId, "get", "complete", {
    elapsedMs: elapsedMs(startedAt),
    prfOutputBytes: output.byteLength
  });
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
  // A WebAuthn PRF output is already the full-strength key material. This
  // envelope intentionally has no KDF salt field, so it must not use the
  // Vault/local-secret helper whose random salt is authenticated and persisted
  // separately. Bind only the stable passkey AAD and retain the existing record
  // format for previously stored passkeys.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv as BufferSource,
      additionalData: new TextEncoder().encode(passkeyAad(input.publicKeyHex, input.credentialIdB64)) as BufferSource
    },
    key,
    plaintext as BufferSource
  ));
  return {
    cipherVersion: "webauthn-prf-v1",
    cipherIvB64: bytesToHex(iv),
    cipherB64: bytesToHex(ciphertext)
  };
}

export async function decryptMaterialWithPasskey(input: {
  prfOutput: Uint8Array;
  publicKeyHex: string;
  protection: VaultPasskeyProtectionRecord;
}): Promise<VaultKeyMaterial> {
  const key = await aesGcmKeyFromRawBits(input.prfOutput);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: hexToBytes(input.protection.cipherIvB64) as BufferSource,
      additionalData: new TextEncoder().encode(passkeyAad(input.publicKeyHex, input.protection.credentialIdB64)) as BufferSource
    },
    key,
    hexToBytes(input.protection.cipherB64) as BufferSource
  ));
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as VaultKeyMaterial;
  if (typeof parsed.hex !== "string") throw new Error("Invalid passkey key material");
  return parsed;
}

export function toPasskeySummary(record: VaultPasskeyProtectionRecord): PasskeyProtection {
  return { id: record.id, label: record.label, rpId: record.rpId, createdAt: record.createdAt };
}

function readPrfOutput(prf: PrfExtensionResult["prf"]): Uint8Array | undefined {
  const value = prf?.results?.first;
  if (!value) return undefined;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  return new Uint8Array(value as ArrayBuffer);
}

function installWebAuthnPrfGetProbe(): void {
  const diagnosticGlobal = globalThis as typeof globalThis & {
    [WEBAUTHN_PRF_GET_PROBE_GLOBAL]?: () => Promise<Record<string, unknown>>;
  };
  diagnosticGlobal[WEBAUTHN_PRF_GET_PROBE_GLOBAL] = async () => {
    const pending = lastRejectedCreateForProbe;
    if (!pending) {
      const result = {
        status: "unavailable",
        message: "No rejected create-time PRF attempt is available in this page session"
      };
      console.warn("[KeyMaster WebAuthn PRF] manual get probe unavailable", result);
      return result;
    }
    console.info("[KeyMaster WebAuthn PRF] manual get probe starting", {
      purpose: "diagnostic-only",
      mutatesKeyMasterVault: false,
      storesPasskeyProtection: false
    });
    try {
      const output = await requestPasskeyPrf(pending);
      const result = { status: "prf-returned", prfOutputBytes: output.byteLength };
      output.fill(0);
      console.info("[KeyMaster WebAuthn PRF] manual get probe complete", result);
      return result;
    } catch (err) {
      const result = { status: "error", error: errorSummary(err) };
      console.error("[KeyMaster WebAuthn PRF] manual get probe failed", result);
      return result;
    }
  };
}

async function attestationResponseSummary(
  response: AuthenticatorAttestationResponse
): Promise<Record<string, unknown>> {
  const authenticatorData = typeof response.getAuthenticatorData === "function"
    ? response.getAuthenticatorData()
    : null;
  const publicKey = typeof response.getPublicKey === "function" ? response.getPublicKey() : null;
  return {
    clientData: await clientDataSummary(response.clientDataJSON),
    attestationObjectBytes: response.attestationObject.byteLength,
    attestationObjectSha256: await sha256Prefix(response.attestationObject),
    authenticatorData: authenticatorData ? await authenticatorDataSummary(authenticatorData) : null,
    publicKeyAlgorithm: typeof response.getPublicKeyAlgorithm === "function"
      ? response.getPublicKeyAlgorithm()
      : null,
    publicKeyBytes: publicKey?.byteLength ?? 0,
    publicKeySha256: publicKey ? await sha256Prefix(publicKey) : null
  };
}

async function assertionResponseSummary(
  response: AuthenticatorAssertionResponse
): Promise<Record<string, unknown>> {
  return {
    clientData: await clientDataSummary(response.clientDataJSON),
    authenticatorData: await authenticatorDataSummary(response.authenticatorData),
    signatureBytes: response.signature.byteLength,
    signatureSha256: await sha256Prefix(response.signature),
    userHandleBytes: response.userHandle?.byteLength ?? 0,
    userHandleSha256: response.userHandle ? await sha256Prefix(response.userHandle) : null
  };
}

async function clientDataSummary(clientDataJSON: ArrayBuffer): Promise<Record<string, unknown>> {
  const bytes = new Uint8Array(clientDataJSON);
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const challenge = typeof parsed.challenge === "string" ? parsed.challenge : "";
    return {
      bytes: bytes.byteLength,
      sha256: await sha256Prefix(bytes),
      type: parsed.type ?? null,
      origin: parsed.origin ?? null,
      crossOrigin: parsed.crossOrigin ?? null,
      topOrigin: parsed.topOrigin ?? null,
      challengeCharacters: challenge.length,
      challengeSha256: challenge ? await sha256Prefix(new TextEncoder().encode(challenge)) : null
    };
  } catch (err) {
    return {
      bytes: bytes.byteLength,
      sha256: await sha256Prefix(bytes),
      parseError: errorSummary(err)
    };
  }
}

async function authenticatorDataSummary(value: AnyBufferSource): Promise<Record<string, unknown>> {
  const bytes = bufferSourceBytes(value);
  if (bytes.byteLength < 37) {
    return {
      bytes: bytes.byteLength,
      sha256: await sha256Prefix(bytes),
      malformed: true
    };
  }
  const flags = bytes[32]!;
  const signCount = new DataView(bytes.buffer, bytes.byteOffset + 33, 4).getUint32(0, false);
  return {
    bytes: bytes.byteLength,
    sha256: await sha256Prefix(bytes),
    rpIdHashPrefix: bytesToHex(bytes.slice(0, 32)).slice(0, 16),
    flagsHex: `0x${flags.toString(16).padStart(2, "0")}`,
    flags: {
      userPresent: Boolean(flags & 0x01),
      userVerified: Boolean(flags & 0x04),
      backupEligible: Boolean(flags & 0x08),
      backupState: Boolean(flags & 0x10),
      attestedCredentialData: Boolean(flags & 0x40),
      extensionData: Boolean(flags & 0x80)
    },
    signCount
  };
}

async function sha256Prefix(value: AnyBufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bufferSourceBytes(value));
  return bytesToHex(new Uint8Array(digest)).slice(0, 16);
}

function bufferSourceBytes(value: AnyBufferSource): Uint8Array<ArrayBuffer> {
  let source: Uint8Array<ArrayBufferLike>;
  if (ArrayBuffer.isView(value)) {
    source = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    source = new Uint8Array(value);
  }
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
}

function navigatorUserAgentData(): Record<string, unknown> | null {
  const data = (navigator as Navigator & {
    userAgentData?: {
      brands?: Array<{ brand: string; version: string }>;
      mobile?: boolean;
      platform?: string;
    };
  }).userAgentData;
  return data
    ? {
        brands: data.brands ?? [],
        mobile: data.mobile ?? null,
        platform: data.platform ?? null
      }
    : null;
}

async function writeWebAuthnClientCapabilities(
  traceId: string,
  operation: "create" | "get"
): Promise<void> {
  try {
    const constructor = PublicKeyCredential as PublicKeyCredentialWithDiagnostics;
    const [capabilities, platformAuthenticator] = await Promise.all([
      typeof constructor.getClientCapabilities === "function"
        ? constructor.getClientCapabilities()
        : Promise.resolve(null),
      typeof constructor.isUserVerifyingPlatformAuthenticatorAvailable === "function"
        ? constructor.isUserVerifyingPlatformAuthenticatorAvailable()
        : Promise.resolve(null)
    ]);
    writeWebAuthnPrfDiagnostic(traceId, operation, "client.capabilities", {
      getClientCapabilitiesAvailable: typeof constructor.getClientCapabilities === "function",
      capabilities,
      prfClientExtensionCapability: capabilities?.["extension:prf"] ?? null,
      userVerifyingPlatformAuthenticatorAvailable: platformAuthenticator
    });
  } catch (err) {
    writeWebAuthnPrfDiagnostic(traceId, operation, "client.capabilities.error", {
      error: errorSummary(err)
    }, "warn");
  }
}

function writeWebAuthnPrfDiagnostic(
  traceId: string,
  operation: "create" | "get",
  event: string,
  details: Record<string, unknown>,
  level: "info" | "warn" | "error" = "info"
): void {
  const entry: WebAuthnPrfDiagnosticEntry = {
    at: new Date().toISOString(),
    traceId,
    operation,
    event,
    details
  };
  const diagnosticGlobal = globalThis as typeof globalThis & {
    [WEBAUTHN_PRF_DIAGNOSTIC_GLOBAL]?: WebAuthnPrfDiagnosticEntry[];
  };
  const entries = diagnosticGlobal[WEBAUTHN_PRF_DIAGNOSTIC_GLOBAL] ?? [];
  entries.push(entry);
  if (entries.length > WEBAUTHN_PRF_DIAGNOSTIC_LIMIT) {
    entries.splice(0, entries.length - WEBAUTHN_PRF_DIAGNOSTIC_LIMIT);
  }
  diagnosticGlobal[WEBAUTHN_PRF_DIAGNOSTIC_GLOBAL] = entries;
  console[level](
    `[KeyMaster WebAuthn PRF] ${operation}:${event}\n${JSON.stringify(entry, null, 2)}`
  );
}

function errorSummary(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { value: String(err) };
  return {
    name: err.name,
    message: err.message,
    constructor: err.constructor?.name,
    code: "code" in err ? String(err.code) : undefined,
    cause: err.cause instanceof Error
      ? { name: err.cause.name, message: err.cause.message }
      : err.cause === undefined
        ? undefined
        : String(err.cause),
    stack: err.stack
  };
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 10) / 10;
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
