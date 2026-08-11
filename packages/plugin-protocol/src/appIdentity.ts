import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { AppIdentityProofV1, AppRequirement, VerifiedAppIdentity } from "@keymaster/contracts";

export const APP_IDENTITY_DOMAIN_V1 = "keymaster-app-identity:v1";

export class AppIdentityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppIdentityValidationError";
  }
}

function exact(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
    throw new AppIdentityValidationError(`${field} has unexpected fields`);
  }
}

function text(value: unknown, field: string, max: number): asserts value is string {
  const invalidControl = (c: string) => {
    const code = c.charCodeAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0xfffd;
  };
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    [...value].length > max ||
    [...value].some(invalidControl)
  ) {
    throw new AppIdentityValidationError(`${field} is invalid`);
  }
}

function hex(value: unknown, field: string, length: number): Uint8Array {
  if (typeof value !== "string" || value.length !== length || !/^[0-9a-f]+$/u.test(value)) {
    throw new AppIdentityValidationError(`${field} must be hex`);
  }
  const out = new Uint8Array(length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** RFC 8785-compatible canonical JSON for the proof payload. */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new AppIdentityValidationError("identity payload contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(object[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new AppIdentityValidationError("identity payload contains an unsupported value");
}

export function identityPayload(proof: AppIdentityProofV1): Omit<AppIdentityProofV1, "signature"> {
  return {
    version: 1,
    publisherPublicKey: proof.publisherPublicKey,
    app: { ...proof.app },
    requirements: [...proof.requirements]
  };
}

export function identityDigestBytes(proof: AppIdentityProofV1): Uint8Array {
  const payload = new TextEncoder().encode(canonicalizeJson(identityPayload(proof)));
  const domain = new TextEncoder().encode(APP_IDENTITY_DOMAIN_V1);
  const signed = new Uint8Array(domain.length + 1 + payload.length);
  signed.set(domain);
  signed[domain.length] = 0;
  signed.set(payload, domain.length + 1);
  return sha256(signed);
}

/** 验证外部签名 proof，并返回可持久化的 digest snapshot。 */
export function verifyAppIdentityProof(raw: unknown): VerifiedAppIdentity {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppIdentityValidationError("appIdentity must be an object");
  }
  const proof = raw as Record<string, unknown>;
  exact(proof, ["version", "publisherPublicKey", "app", "requirements", "signature"], "appIdentity");
  if (
    proof.version !== 1 ||
    typeof proof.publisherPublicKey !== "string" ||
    !/^(02|03)[0-9a-f]{64}$/u.test(proof.publisherPublicKey)
  ) {
    throw new AppIdentityValidationError("publisherPublicKey is invalid");
  }
  try {
    if (!secp256k1.utils.isValidPublicKey(hex(proof.publisherPublicKey, "publisherPublicKey", 66))) throw new Error();
  } catch {
    throw new AppIdentityValidationError("publisherPublicKey is invalid");
  }
  if (!proof.app || typeof proof.app !== "object" || Array.isArray(proof.app)) {
    throw new AppIdentityValidationError("app must be an object");
  }
  const app = proof.app as Record<string, unknown>;
  exact(app, ["id", "name", "description"], "app");
  text(app.id, "app.id", 63);
  text(app.name, "app.name", 120);
  text(app.description, "app.description", 500);
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/u.test(app.id)) {
    throw new AppIdentityValidationError("app.id is invalid");
  }
  if (!Array.isArray(proof.requirements)) {
    throw new AppIdentityValidationError("requirements must be an array");
  }
  const requirements = proof.requirements as unknown[];
  const allowed = new Set<AppRequirement>(["private-key", "storage"]);
  if (
    requirements.some((r) => typeof r !== "string" || !allowed.has(r as AppRequirement)) ||
    new Set(requirements).size !== requirements.length ||
    requirements.some((r, i) => i > 0 && String(requirements[i - 1]) >= String(r))
  ) {
    throw new AppIdentityValidationError("requirements must be sorted and unique");
  }
  const signature = hex(proof.signature, "signature", 128);
  const typed = {
    version: 1 as const,
    publisherPublicKey: proof.publisherPublicKey,
    app: { id: app.id, name: app.name, description: app.description },
    requirements: requirements as AppRequirement[],
    signature: proof.signature as string
  };
  try {
    if (
      !secp256k1.verify(
        signature,
        identityDigestBytes(typed),
        hex(proof.publisherPublicKey, "publisherPublicKey", 66),
        { prehash: false, format: "compact" }
      )
    ) throw new Error();
  } catch {
    throw new AppIdentityValidationError("appIdentity signature is invalid");
  }
  const digest = identityDigestBytes(typed);
  return {
    version: 1,
    publisherPublicKeyHex: typed.publisherPublicKey,
    appId: typed.app.id,
    appName: typed.app.name,
    identityDigestHex: Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")
  };
}

/** 校验 session 中已验证 proof 的不可变 snapshot。 */
export function isVerifiedAppIdentitySnapshot(value: unknown): value is VerifiedAppIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  if (
    snapshot.version !== 1 ||
    typeof snapshot.appId !== "string" ||
    !/^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/u.test(snapshot.appId) ||
    typeof snapshot.appName !== "string" ||
    !snapshot.appName.trim() ||
    snapshot.appName !== snapshot.appName.trim() ||
    [...snapshot.appName].length > 120 ||
    [...snapshot.appName].some((c) => /[\u0000-\u001f\u007f-\u009f\ufffd]/u.test(c)) ||
    typeof snapshot.publisherPublicKeyHex !== "string" ||
    !/^(02|03)[0-9a-f]{64}$/u.test(snapshot.publisherPublicKeyHex) ||
    typeof snapshot.identityDigestHex !== "string" ||
    !/^[0-9a-f]{64}$/u.test(snapshot.identityDigestHex)
  ) {
    return false;
  }
  try {
    return secp256k1.utils.isValidPublicKey(
      hex(snapshot.publisherPublicKeyHex, "publisherPublicKeyHex", 66)
    );
  } catch {
    return false;
  }
}
