import { expect, it } from "vitest";
import type { OwnerAppStorageGrant } from "@keymaster/contracts";
import { createStorageGrantAuthority } from "./storageGrantAuthority.js";
it("rejects an App grant revoked during its authoritative session lookup", async () => {
  const appIdentity = { publisherPublicKeyHex: "02" + "11".repeat(32), appId: "test.app", version: 1 as const, appName: "Test", identityDigestHex: "22".repeat(32) };
  const context: OwnerAppStorageGrant = { connectSessionId: "connect", transportOrigin: "https://app.example", appIdentity, appStorageName: "app", moduleId: "app", purposeId: "files", sessionEpoch: "epoch", walletGeneration: "wallet", runGeneration: "run" };
  const session = { origin: context.transportOrigin, appIdentity, ownerPublicKeyHex: "key", revokedAt: null };
  let complete!: (value: typeof session) => void;
  const authority = createStorageGrantAuthority({
    session: () => ({ sessionEpoch: "epoch", walletGeneration: "wallet", runGeneration: "run", unlocked: true, rootAvailable: true }),
    appSession: () => new Promise(resolve => { complete = resolve; }),
  });
  authority.apps.set("grant", { context, clientId: "page", sessionEpoch: "epoch" });
  const pending = authority.resolveApp("grant", "page");
  const refused = expect(pending).rejects.toMatchObject({ code: "storage_identity_required" });
  authority.apps.delete("grant");
  complete(session);
  await refused;
  await expect(authority.resolveApp("grant", "other-page")).rejects.toMatchObject({ code: "storage_identity_required" });
});
