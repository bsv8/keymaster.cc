import { expect, test } from "vitest";
import { CENTRAL_STORAGE_DECLARATIONS } from "@keymaster/contracts";
import { createIndexedDbWalletStore, createPlatformRootStore, createWorkerStorageClients } from "../../../../packages/platform-storage/src/coordinator/index.js";

test("真实存储根：核心付款账本可条件写，模块不可借用核心缓存，撤权后旧句柄失败", async () => {
  const store = createIndexedDbWalletStore({ databaseName: "payment-private-storage-" + crypto.randomUUID() });
  const declaration = CENTRAL_STORAGE_DECLARATIONS.vaultPayments;
  let binding = { walletGeneration: crypto.randomUUID(), sessionEpoch: crypto.randomUUID(), runGeneration: crypto.randomUUID() };
  const root = createPlatformRootStore({identity: {bsvNetwork:"main",publicKeyHex:"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"},  store, generations: () => binding });
  const clients = createWorkerStorageClients({
    root: () => root, binding: () => binding, sameBinding: (a, b) => a === b,
    declaration(module, purpose, model) {
      if (module !== declaration.moduleId || purpose !== declaration.purposeId || model !== declaration.model) throw new Error("Unknown declaration");
      return declaration;
    },
    assertAvailable: () => {}, assertLive(expected) { if (expected !== binding) throw new Error("Revoked binding"); },
    beginRequest: () => () => {}, unavailable: message => new Error(message),
    withIoLease: (_operation, _model, execute) => execute(), onFailure: () => {},
    onInvalidate: () => {}, registerMaintenance: () => {}, unregisterMaintenance: () => {},
  });
  try {
    const privateFiles = clients.platformFiles("vault", "payments");
    const payload = new TextEncoder().encode("{\"revision\":1}");
    const committed = await privateFiles.put("payments.json", payload, { ifNoneMatch: true });
    expect((await privateFiles.get("payments.json"))?.bytes).toEqual(payload);
    await expect(privateFiles.put("payments.json", payload, { ifRevision: "0" })).rejects.toMatchObject({ code: "storage_conflict" });
    await expect(clients.moduleFiles("vault", "payments").get("payments.json")).rejects.toMatchObject({ code: "storage_forbidden" });
    await expect(root.openPlatformFileStore({ declaration: { ...declaration, authority: "built-in-module" } })).rejects.toMatchObject({ code: "storage_forbidden" });
    const opened = await root.openPlatformFileStore({ declaration });
    binding = { ...binding, sessionEpoch: crypto.randomUUID() };
    await expect(opened.put("payments.json", payload, { ifRevision: committed.revision })).rejects.toMatchObject({ code: "storage_unavailable" });
    opened.close();
  } finally { clients.invalidateAll(); store.close(); }
});
