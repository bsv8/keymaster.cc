import type { OwnerAppStorageGrant, SessionEpoch } from "@keymaster/contracts";
import type { StorageOwnerGrant, StoragePlatformGrant } from "@keymaster/contracts/storage-internal";
export interface StorageGrantSessionFacts {
  sessionEpoch: SessionEpoch;
  walletGeneration: string;
  runGeneration: string;
  unlocked: boolean;
  rootAvailable: boolean;
}
export interface StorageGrantAuthorityDependencies {
  session(): StorageGrantSessionFacts;
  appSession(id: string): Promise<{ origin: string; appIdentity: OwnerAppStorageGrant["appIdentity"]; ownerPublicKeyHex: string; revokedAt: number | null } | null>;
}
/** Worker-only authorization state. Grants stay tied to the issuing page and
 * wallet/session/run generation; a retained grant is never a new namespace.
 */
export function createStorageGrantAuthority(deps: StorageGrantAuthorityDependencies) {
  const apps = new Map<string, { context: OwnerAppStorageGrant; clientId: string; sessionEpoch: SessionEpoch }>();
  const owners = new Map<string, StorageOwnerGrant & { clientId: string }>();
  const platforms = new Map<string, StoragePlatformGrant & { clientId: string }>();
  const identityError = (message: string) => Object.assign(new Error(message), { code: "storage_identity_required" });
  async function resolvePlatform(id: string, clientId: string): Promise<StoragePlatformGrant & { clientId: string }> {
    const grant = platforms.get(id);
    const facts = deps.session();
    if (!grant || grant.clientId !== clientId) throw new Error("Platform storage grant is invalid");
    if (grant.sessionEpoch !== facts.sessionEpoch) throw new Error("Platform storage session changed");
    if (grant.walletGeneration !== facts.walletGeneration) throw new Error("Platform storage wallet generation changed");
    if (grant.runGeneration !== facts.runGeneration) throw new Error("Platform storage run generation changed");
    if (!facts.rootAvailable) throw new Error("Platform storage root is unavailable");
    return grant;
  }
  async function resolveOwner(id: string, clientId: string): Promise<StorageOwnerGrant> {
    const grant = owners.get(id);
    const facts = deps.session();
    if (!grant || grant.clientId !== clientId) throw new Error("Owner storage grant is invalid");
    if (grant.sessionEpoch !== facts.sessionEpoch) throw new Error("Owner storage session changed");
    if (grant.walletGeneration !== facts.walletGeneration) throw new Error("Owner storage wallet generation changed");
    if (grant.runGeneration !== facts.runGeneration) throw new Error("Owner storage run generation changed");
    if (!facts.unlocked) throw new Error("Owner storage requires an unlocked wallet");
    if (!facts.rootAvailable) throw new Error("Owner storage root is unavailable");
    return grant;
  }
  async function resolveApp(id: string, clientId: string): Promise<{ context: OwnerAppStorageGrant; connectSessionId: string }> {
    const grant = apps.get(id);
    if (!grant || grant.clientId !== clientId || grant.sessionEpoch !== deps.session().sessionEpoch) throw identityError("Storage grant is invalid");
    const authoritative = await deps.appSession(grant.context.connectSessionId);
    // Querying the durable Connect session yields. Revocation or replacement
    // during that query must fail before the physical storage handler runs.
    if (apps.get(id) !== grant) throw identityError("Storage grant was revoked during session lookup");
    const facts = deps.session();
    if (!authoritative || authoritative.revokedAt !== null
      || authoritative.origin !== grant.context.transportOrigin
      || JSON.stringify(authoritative.appIdentity) !== JSON.stringify(grant.context.appIdentity)
      || grant.context.sessionEpoch !== facts.sessionEpoch
      || grant.context.walletGeneration !== facts.walletGeneration
      || grant.context.runGeneration !== facts.runGeneration
      || !facts.rootAvailable || !facts.unlocked) throw identityError("Storage session is invalid or revoked");
    return { context: grant.context, connectSessionId: grant.context.connectSessionId };
  }
  return { apps, owners, platforms, resolvePlatform, resolveOwner, resolveApp };
}
