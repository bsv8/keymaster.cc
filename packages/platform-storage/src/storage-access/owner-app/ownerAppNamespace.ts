import { deriveThirdPartyApplicationStorageId, validateApplicationStorageId } from "@keymaster/contracts";
import type { OwnerAppStorageGrant, VerifiedAppIdentity } from "@keymaster/contracts";
import { StoragePathError, buildObjectKey, normalizeRoot } from "../../bucket-providers/bucketPath.js";

export interface StorageNamespaceIdentity {
  publisherPublicKeyHex: string;
  appId: string;
}

export function validateStorageIdentity(identity: VerifiedAppIdentity): StorageNamespaceIdentity {
  if (!/^(02|03)[0-9a-f]{64}$/u.test(identity.publisherPublicKeyHex)) throw new StoragePathError("publisher key is invalid");
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/u.test(identity.appId) || [...identity.appId].length > 63) throw new StoragePathError("app id is invalid");
  return { publisherPublicKeyHex: identity.publisherPublicKeyHex.toLowerCase(), appId: identity.appId };
}

export function buildOwnerAppNamespaceRoot(grant: Pick<OwnerAppStorageGrant, "ownerPublicKeyHex" | "applicationStorageId">): string {
  if (!/^(02|03)[0-9a-f]{64}$/u.test(grant.ownerPublicKeyHex)) throw new StoragePathError("owner key is invalid");
  validateApplicationStorageId(grant.applicationStorageId);
  return normalizeRoot(`${grant.ownerPublicKeyHex.toLowerCase()}/${grant.applicationStorageId}/`);
}

export function buildStorageContext(input: {
  connectSessionId: string;
  transportOrigin: string;
  appIdentity: VerifiedAppIdentity;
  bucketId: string;
  bucketGeneration: number;
  ownerPublicKeyHex: string;
  sessionEpoch: string;
}): OwnerAppStorageGrant {
  if (!input.connectSessionId || !input.transportOrigin || !input.sessionEpoch) throw new StoragePathError("storage context is incomplete");
  const identity = validateStorageIdentity(input.appIdentity);
  if (!/^(02|03)[0-9a-f]{64}$/u.test(input.ownerPublicKeyHex)) throw new StoragePathError("owner key is invalid");
  if (!input.bucketId || input.bucketId.includes("/")) throw new StoragePathError("bucket is invalid");
  if (!Number.isSafeInteger(input.bucketGeneration) || input.bucketGeneration < 1) throw new StoragePathError("bucket generation is invalid");
  const applicationStorageId = deriveThirdPartyApplicationStorageId(identity.publisherPublicKeyHex, identity.appId);
  return {
    connectSessionId: input.connectSessionId,
    transportOrigin: input.transportOrigin,
    appIdentity: input.appIdentity,
    bucketId: input.bucketId,
    bucketGeneration: input.bucketGeneration,
    ownerPublicKeyHex: input.ownerPublicKeyHex.toLowerCase(),
    applicationStorageId,
    sessionEpoch: input.sessionEpoch
  };
}

export function buildKeyForContext(root: string, relativePath: string, directory = false): string {
  return buildObjectKey(root, relativePath, directory);
}
