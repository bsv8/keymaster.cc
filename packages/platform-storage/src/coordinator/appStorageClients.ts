import { APP_STORAGE_CLIENTS_CAPABILITY, deriveAppStorageName, deriveThirdPartyStorageModuleId, type AppStorageClients, type AppStorageClient, type OwnerAppStorageGrant, type StorageRuntimeController } from "@keymaster/contracts";
import { isIssuedKeymasterConsumer } from "@keymaster/runtime/storage";
import type { LifecycleScope } from "webloom-framework";

/** Storage derives the App namespace; the Worker revalidates the authoritative session at each I/O. */
export function createAppStorageClients(controller: StorageRuntimeController, providerScope?: LifecycleScope): AppStorageClients {
  return Object.freeze({
    bind(consumer, scope, binding) {
      if (!isIssuedKeymasterConsumer(consumer, scope) || consumer.status !== "active" || consumer.pluginId !== "protocol") throw new Error("App storage requires the issued Connect gateway consumer");
      consumer.capability(APP_STORAGE_CLIENTS_CAPABILITY);
      const assert = () => { scope.assertActive(); providerScope?.assertActive(); if (consumer.status !== "active") throw new Error("App storage gateway revoked"); };
      assert();
      if (!binding.connectSessionId || !binding.transportOrigin || !binding.walletGeneration || !binding.sessionEpoch || !binding.runGeneration || !binding.appIdentity?.publisherPublicKeyHex || !binding.appIdentity.appId || !binding.appIdentity.identityDigestHex) throw new Error("App storage requires a verified session binding");
      const appIdentity = Object.freeze({ ...binding.appIdentity });
      const grant: OwnerAppStorageGrant = Object.freeze({ connectSessionId: binding.connectSessionId, transportOrigin: binding.transportOrigin,
        sessionEpoch: binding.sessionEpoch, walletGeneration: binding.walletGeneration, runGeneration: binding.runGeneration, appIdentity,
        appStorageName: deriveAppStorageName(appIdentity),
        moduleId: deriveThirdPartyStorageModuleId(appIdentity.publisherPublicKeyHex, appIdentity.appId), purposeId: "files",
      });
      const call = async <T>(operation: () => Promise<T>): Promise<T> => { assert(); const result = await operation(); assert(); return result; };
      const client: AppStorageClient = {
        list: input => call(() => controller.list(grant, input)),
        createDirectory: input => call(() => controller.createDirectory(grant, input)),
        deleteDirectory: input => call(() => controller.deleteDirectory(grant, input)),
        put: input => call(() => controller.put(grant, input)),
        getRange: input => call(() => controller.getRange(grant, input)),
        delete: input => call(() => controller.delete(grant, input)),
      };
      return Object.freeze(client);
    },
  } satisfies AppStorageClients);
}
