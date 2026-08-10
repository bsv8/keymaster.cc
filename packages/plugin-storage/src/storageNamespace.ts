import type { StorageAppContext, VerifiedAppIdentity } from "@keymaster/contracts";
import { StoragePathError, buildObjectKey, normalizeProviderPrefix, normalizeRoot } from "./storagePath.js";

export interface StorageNamespaceIdentity {
  publisherPublicKeyHex: string;
  appId: string;
}

export function validateStorageIdentity(identity: VerifiedAppIdentity): StorageNamespaceIdentity {
  if (!/^(02|03)[0-9a-f]{64}$/u.test(identity.publisherPublicKeyHex)) throw new StoragePathError("publisher key is invalid");
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/u.test(identity.appId) || [...identity.appId].length > 63) throw new StoragePathError("app id is invalid");
  return { publisherPublicKeyHex: identity.publisherPublicKeyHex.toLowerCase(), appId: identity.appId };
}

export function buildNamespaceRoot(providerPrefix: string, identity: VerifiedAppIdentity): string {
  const prefix = normalizeProviderPrefix(providerPrefix);
  const validated = validateStorageIdentity(identity);
  return normalizeRoot(`${prefix}${validated.publisherPublicKeyHex}/${validated.appId}/`);
}

export function buildStorageContext(input: {
  connectSessionId: string;
  transportOrigin: string;
  appIdentity: VerifiedAppIdentity;
}): StorageAppContext {
  if (!input.connectSessionId || !input.transportOrigin) throw new StoragePathError("storage context is incomplete");
  validateStorageIdentity(input.appIdentity);
  return { ...input };
}

export function buildKeyForContext(root: string, relativePath: string, directory = false): string {
  return buildObjectKey(root, relativePath, directory);
}
