import { openMsFileRepository, type MsFileRepositoryStores } from "./storage/msfileRepository.js";
import { createMsFileService, type MsFileServiceImplDeps } from "./msfileService.js";
import { createMsFileLocalContentSource } from "./bitfs/localContentSource.js";

export interface MsFileWorkerServiceDependencies extends Omit<MsFileServiceImplDeps, "repository" | "localSource"> {
  stores: MsFileRepositoryStores;
  assertFresh(): void;
}

/** Owns service initialization and disposes candidates that cannot become ready. */
export async function createMsFileWorkerService(deps: MsFileWorkerServiceDependencies) {
  const repository = await openMsFileRepository(deps.stores);
  deps.assertFresh();
  const service = createMsFileService({ repository, transport: deps.transport, localSource: createMsFileLocalContentSource(deps.stores.settings), onSellerSettingsChanged: deps.onSellerSettingsChanged, notifyStateChange: deps.notifyStateChange });
  try {
    await service.waitUntilInitialized();
    deps.assertFresh();
    return service;
  } catch (error) {
    service.dispose();
    throw error;
  }
}
