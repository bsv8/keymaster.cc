import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { AppIdentityProofV1, VerifiedAppIdentity } from "@keymaster/contracts";

export const APP_IDENTITY_DOMAIN_V1 = "keymaster-app-identity:v1";

export class AppIdentityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppIdentityValidationError";
  }
}

/** Validate the immutable, already-verified snapshot persisted in a session. */
export function isVerifiedAppIdentitySnapshot(value: unknown): value is import("@keymaster/contracts").VerifiedAppIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  return snapshot.version === 1
    && typeof snapshot.appId === "string" && /^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/.test(snapshot.appId)
    && typeof snapshot.appName === "string" && snapshot.appName.length > 0 && snapshot.appName.trim().length > 0 && [...snapshot.appName].length <= 120
    && ![...snapshot.appName].some((char) => { const code = char.charCodeAt(0); return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0xfffd; })
    && typeof snapshot.publisherPublicKeyHex === "string" && /^(02|03)[0-9a-f]{64}$/u.test(snapshot.publisherPublicKeyHex)
    && typeof snapshot.identityDigestHex === "string" && /^[0-9a-f]{64}$/u.test(snapshot.identityDigestHex);
}

function hexToBytes(value: string, field: string): Uint8Array {
  if (!/^[0-9a-f]+$/.test(value) || value.length % 2 !== 0) {
    throw new AppIdentityValidationError(`${field} must be hex`);
  }
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function assertText(value: unknown, field: string, max: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0 || [...value].length > max) {
    throw new AppIdentityValidationError(`${field} has invalid length`);
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0xfffd) {
      throw new AppIdentityValidationError(`${field} contains a control character`);
    }
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new AppIdentityValidationError(`${field} has unexpected fields`);
  }
}

/** RFC 8785-compatible canonical JSON for the restricted proof payload. */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AppIdentityValidationError("identity payload contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalizeJson(object[key])}`).join(",")}}`;
  }
  throw new AppIdentityValidationError("identity payload contains an unsupported value");
}

export function identityPayload(proof: AppIdentityProofV1): { version: 1; publisherPublicKey: string; app: { id: string; name: string } } {
  return {
    version: 1,
    publisherPublicKey: proof.publisherPublicKey,
    app: { id: proof.app.id, name: proof.app.name }
  };
}

export function identityDigestBytes(proof: AppIdentityProofV1): Uint8Array {
  const payload = new TextEncoder().encode(canonicalizeJson(identityPayload(proof)));
  const domain = new TextEncoder().encode(APP_IDENTITY_DOMAIN_V1);
  const signed = new Uint8Array(domain.length + 1 + payload.length);
  signed.set(domain, 0);
  signed[domain.length] = 0;
  signed.set(payload, domain.length + 1);
  return sha256(signed);
}

export function verifyAppIdentityProof(raw: unknown): VerifiedAppIdentity {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppIdentityValidationError("appIdentity must be an object");
  }
  const proof = raw as Record<string, unknown>;
  assertExactKeys(proof, ["version", "publisherPublicKey", "app", "signature"], "appIdentity");
  if (proof.version !== 1) throw new AppIdentityValidationError("appIdentity.version must be 1");
  assertText(proof.publisherPublicKey, "publisherPublicKey", 66);
  const publisherPublicKey = proof.publisherPublicKey;
  if (publisherPublicKey.length !== 66 || !/^(02|03)[0-9a-f]{64}$/.test(publisherPublicKey)) {
    throw new AppIdentityValidationError("publisherPublicKey must be a compressed secp256k1 public key");
  }
  const app = proof.app;
  if (!app || typeof app !== "object" || Array.isArray(app)) throw new AppIdentityValidationError("app must be an object");
  const appObject = app as Record<string, unknown>;
  assertExactKeys(appObject, ["id", "name"], "app");
  assertText(appObject.id, "app.id", 63);
  assertText(appObject.name, "app.name", 120);
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/.test(appObject.id)) {
    throw new AppIdentityValidationError("app.id contains unsupported characters");
  }
  assertText(proof.signature, "signature", 128);
  const signature = hexToBytes(proof.signature, "signature");
  if (signature.length !== 64) throw new AppIdentityValidationError("signature must be a 64-byte compact signature");
  const publicKey = hexToBytes(publisherPublicKey, "publisherPublicKey");
  const typedProof = proof as unknown as AppIdentityProofV1;
  try {
    if (!secp256k1.verify(signature, identityDigestBytes(typedProof), publicKey, { prehash: false, format: "compact" })) {
      throw new AppIdentityValidationError("appIdentity signature is invalid");
    }
  } catch (error) {
    if (error instanceof AppIdentityValidationError) throw error;
    throw new AppIdentityValidationError("appIdentity signature is invalid");
  }
  const digest = identityDigestBytes(typedProof);
  return {
    version: 1,
    publisherPublicKeyHex: publisherPublicKey.toLowerCase(),
    appId: appObject.id,
    appName: appObject.name,
    identityDigestHex: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
  };
}
