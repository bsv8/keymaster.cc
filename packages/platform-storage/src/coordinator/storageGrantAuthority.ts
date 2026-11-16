import type { SessionEpoch } from "@keymaster/contracts";
import type { StorageOwnerGrant } from "@keymaster/contracts/storage-internal";
export interface StorageGrantSessionFacts {
  sessionEpoch: SessionEpoch;
  walletGeneration: string;
  runGeneration: string;
  unlocked: boolean;
  rootAvailable: boolean;
}
export interface StorageGrantAuthorityDependencies {
  session(): StorageGrantSessionFacts;
}
/** Worker-only authorization state. Grants stay tied to the issuing page and
 * wallet/session/run generation; a retained grant is never a new namespace.
 */
export function createStorageGrantAuthority(deps: StorageGrantAuthorityDependencies) {
  const owners = new Map<string, StorageOwnerGrant & { clientId: string }>();
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
  return { owners, resolveOwner };
}
