import { WINDOW_P2P_WORKER_BRIDGE_CAPABILITY, type WindowP2pExecutorBridge } from "@keymaster/contracts/window-p2p";
import {
  defineBuiltinWorkerPlugin, SAT_SUBSCRIPTION_SERVICE_CAPABILITY, WOC_CAPABILITY, WOC_WORKER_BROADCAST_CAPABILITY,
  STORAGE_FILE_CLIENTS_CAPABILITY, VAULT_WALLET_STATE_CAPABILITY, MSFILE_SERVICE_CAPABILITY, MSFILE_CONTENT_CAPABILITY,
  type BorrowedModuleFileStore, type WocServiceHandle,
} from "@keymaster/contracts";
import { createMsFileWorkerBitfsService } from "./msfileWorkerBitfsService.js";
import { createMsFileContentService, createMsFileRemoteContentFetcher, createMsFileSellerPublicationEvidence } from "./coordinator.js";
import type { MsFileServiceImpl } from "./msfileService.js";

export function createMsfileWorkerPlugin(ports: {
  bindBridge(bridge: () => WindowP2pExecutorBridge | undefined): () => void;
  bindChain(access: () => WocServiceHandle | undefined): () => void;
  start(instanceId: string, stores: { ownerPublicKeyHex: string; settings: BorrowedModuleFileStore; appSettings: BorrowedModuleFileStore }, assertActive: () => void): Promise<{ service: MsFileServiceImpl; revoke(): void; dispose(): Promise<void> }>;
  control(control: Parameters<typeof createMsFileWorkerBitfsService>[1] extends (control: infer C) => unknown ? C : never,
    identity: { instanceId: string; sessionEpoch: string }, signal: AbortSignal): ReturnType<Parameters<typeof createMsFileWorkerBitfsService>[1]>;
}) {
  return defineBuiltinWorkerPlugin("msfile", [MSFILE_SERVICE_CAPABILITY, MSFILE_CONTENT_CAPABILITY], async context => {
    const offBridge = ports.bindBridge(() => { context.scope.assertActive(); return context.optionalCapability(WINDOW_P2P_WORKER_BRIDGE_CAPABILITY)?.bind(context.consumer, context.scope); });
    context.scope.onRevoke(offBridge);
    context.capability(SAT_SUBSCRIPTION_SERVICE_CAPABILITY);
    const unbind = ports.bindChain(() => {
      context.scope.assertActive();
      const query = context.optionalCapability(WOC_CAPABILITY);
      const broadcast = context.optionalCapability(WOC_WORKER_BROADCAST_CAPABILITY);
      return query && broadcast ? { ...query, broadcast: broadcast.broadcast.bind(broadcast) } : undefined;
    });
    context.scope.onRevoke(unbind);
    const files = context.capability(STORAGE_FILE_CLIENTS_CAPABILITY);
    const wallet = context.capability(VAULT_WALLET_STATE_CAPABILITY).bind(context.consumer, context.scope);
    const identity = wallet.snapshot();
    const ownerPublicKeyHex = identity.activePublicKeyHex;
    if (!ownerPublicKeyHex) throw new Error("MSFile requires an active owner");
    const runtime = await ports.start(context.instanceId, { ownerPublicKeyHex, settings: files.bind(context.consumer, context.scope, ""), appSettings: files.bind(context.consumer, context.scope, "app-settings") }, () => context.scope.assertActive());
    context.scope.onRevoke(runtime.revoke);
    context.onDispose(runtime.dispose);
    const assertOwner = () => {
      context.scope.assertActive();
      const current = wallet.snapshot();
      if (current.status !== "unlocked" || current.activePublicKeyHex !== ownerPublicKeyHex || current.sessionEpoch !== identity.sessionEpoch) throw new Error("MSFile owner session revoked");
    };
    const service = createMsFileWorkerBitfsService(runtime.service, async control => {
      assertOwner();
      const result = await ports.control(control, { instanceId: context.instanceId, sessionEpoch: identity.sessionEpoch }, context.scope.signal);
      assertOwner();
      return result;
    }, assertOwner);
    context.provide(MSFILE_SERVICE_CAPABILITY, service);
    context.provide(MSFILE_CONTENT_CAPABILITY, createMsFileContentService({
      store: files.bind(context.consumer, context.scope, ""), service,
      remote: createMsFileRemoteContentFetcher({ service }), publication: createMsFileSellerPublicationEvidence(service),
    }));
  });
}

export { createMsFileWorkerLifecycle, type MsFileWorkerStores } from "./workerLifecycle.js";

export { createMsFileWorkerRequests } from "./workerRequests.js";

export { createMsFileWorkerProjection } from "./workerProjection.js";
