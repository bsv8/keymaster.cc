import { APP_STORAGE_CLIENTS_CAPABILITY, deriveAppStorageName, deriveAppStorageModuleId, canonicalOrigin, assertAppPublicKeyHex, type AppStorageClients, type AppStorageClient, type OwnerAppStorageGrant, type StorageRuntimeController } from "@keymaster/contracts";
import type { LifecycleScope } from "webloom-framework";

/** Storage derives the App namespace; the Worker revalidates the authoritative session at each I/O. */
export function createAppStorageClients(controller: StorageRuntimeController, providerScope?: LifecycleScope): AppStorageClients {
  return Object.freeze({
    bind(consumer, scope, binding) {
      consumer.capability(APP_STORAGE_CLIENTS_CAPABILITY);
      const assert = () => { scope.assertActive(); providerScope?.assertActive(); if (consumer.status !== "active") throw new Error("App storage gateway revoked"); };
      assert();
      const origin = canonicalOrigin(binding.origin);
      const appPublicKeyHex = assertAppPublicKeyHex(binding.appPublicKeyHex);
      if(!binding.authorizationId)throw new Error("App authorization is required");
      const grant: OwnerAppStorageGrant = Object.freeze({ bsvNetwork: binding.bsvNetwork, publicKeyHex: binding.publicKeyHex, walletPublicKeyHex: binding.walletPublicKeyHex, transportOrigin: binding.transportOrigin,
        sessionEpoch: binding.sessionEpoch, walletGeneration: binding.walletGeneration, runGeneration: binding.runGeneration, origin, authorizationId: binding.authorizationId, appPublicKeyHex,
        appStorageName: deriveAppStorageName({ appPublicKeyHex }),
        moduleId: deriveAppStorageModuleId(appPublicKeyHex), purposeId: "files",
      });
      const call = async <T>(operation: () => Promise<T>): Promise<T> => { assert(); const result = await operation(); assert(); return result; };
      const client: AppStorageClient = {
        list: input => call(() => controller.list(grant, input)),
        createDirectory: input => call(() => controller.createDirectory(grant, input)),
        deleteDirectory: input => call(() => controller.deleteDirectory(grant, input)),
        put: input => call(() => controller.put(grant, input)),
        putEncrypted: input => call(() => controller.putEncrypted(grant, input)),
        getEncrypted: input => call(() => controller.getEncrypted(grant, input)),
        getRange: input => call(() => controller.getRange(grant, input)),
        delete: input => call(() => controller.delete(grant, input)),
      };
      return Object.freeze(client);
    },
  } satisfies AppStorageClients);
}
