import type { MsFileService } from "@keymaster/contracts";
/** Only contract methods cross the capability boundary; implementation references stay private. */
export function createPublicMsFileService(service: MsFileService, assertActive: () => void): MsFileService {
  function call<T>(execute: () => T): T {
    assertActive();
    const result = execute();
    if (result instanceof Promise) return result.then(value => { assertActive(); return value; }) as T;
    assertActive();
    return result;
  }
  return Object.freeze(Object.assign(Object.create(null), {
    status: (...args: Parameters<MsFileService["status"]>) => call(() => service.status(...args)),
    subscribe: (...args: Parameters<MsFileService["subscribe"]>) => call(() => service.subscribe(...args)),
    getSettingsSnapshot: (...args: Parameters<MsFileService["getSettingsSnapshot"]>) => call(() => service.getSettingsSnapshot(...args)),
    getReadConcurrencySettings: (...args: Parameters<MsFileService["getReadConcurrencySettings"]>) => call(() => service.getReadConcurrencySettings(...args)),
    updateReadConcurrencySettings: (...args: Parameters<MsFileService["updateReadConcurrencySettings"]>) => call(() => service.updateReadConcurrencySettings(...args)),
    resetReadConcurrencySettings: (...args: Parameters<MsFileService["resetReadConcurrencySettings"]>) => call(() => service.resetReadConcurrencySettings(...args)),
    getMediaBlockReadConcurrency: (...args: Parameters<MsFileService["getMediaBlockReadConcurrency"]>) => call(() => service.getMediaBlockReadConcurrency(...args)),
    updateGlobalPriceSettings: (...args: Parameters<MsFileService["updateGlobalPriceSettings"]>) => call(() => service.updateGlobalPriceSettings(...args)),
    updateSellerSettings: (...args: Parameters<MsFileService["updateSellerSettings"]>) => call(() => service.updateSellerSettings(...args)),
    ...(service.getBitfsBuyerSettings ? { getBitfsBuyerSettings: (...args: Parameters<NonNullable<MsFileService["getBitfsBuyerSettings"]>>) => call(() => service.getBitfsBuyerSettings!(...args)) } : {}),
    ...(service.updateBitfsBuyerSettings ? { updateBitfsBuyerSettings: (...args: Parameters<NonNullable<MsFileService["updateBitfsBuyerSettings"]>>) => call(() => service.updateBitfsBuyerSettings!(...args)) } : {}),
    updateMediaBlockReadConcurrency: (...args: Parameters<MsFileService["updateMediaBlockReadConcurrency"]>) => call(() => service.updateMediaBlockReadConcurrency(...args)),
    upsertSupplier: (...args: Parameters<MsFileService["upsertSupplier"]>) => call(() => service.upsertSupplier(...args)),
    deleteSupplier: (...args: Parameters<MsFileService["deleteSupplier"]>) => call(() => service.deleteSupplier(...args)),
    probeSupplier: (...args: Parameters<MsFileService["probeSupplier"]>) => call(() => service.probeSupplier(...args)),
    updateAppPriceOverride: (...args: Parameters<MsFileService["updateAppPriceOverride"]>) => call(() => service.updateAppPriceOverride(...args)),
    clearAppPriceOverride: (...args: Parameters<MsFileService["clearAppPriceOverride"]>) => call(() => service.clearAppPriceOverride(...args)),
    listAppAuthorizations: (...args: Parameters<MsFileService["listAppAuthorizations"]>) => call(() => service.listAppAuthorizations(...args)),
    listPendingApprovals: (...args: Parameters<MsFileService["listPendingApprovals"]>) => call(() => service.listPendingApprovals(...args)),
    resolveApproval: (...args: Parameters<MsFileService["resolveApproval"]>) => call(() => service.resolveApproval(...args)),
    abortSession: (...args: Parameters<MsFileService["abortSession"]>) => call(() => service.abortSession(...args)),
    stat: (...args: Parameters<MsFileService["stat"]>) => call(() => service.stat(...args)),
    readSeed: (...args: Parameters<MsFileService["readSeed"]>) => call(() => service.readSeed(...args)),
    readBlock: (...args: Parameters<MsFileService["readBlock"]>) => call(() => service.readBlock(...args)),
    ...(service.publishBitfsDemand ? { publishBitfsDemand: (...args: Parameters<NonNullable<MsFileService["publishBitfsDemand"]>>) => call(() => service.publishBitfsDemand!(...args)) } : {}),
    ...(service.getBitfsDemand ? { getBitfsDemand: (...args: Parameters<NonNullable<MsFileService["getBitfsDemand"]>>) => call(() => service.getBitfsDemand!(...args)) } : {}),
    ...(service.startBitfsPurchase ? { startBitfsPurchase: (...args: Parameters<NonNullable<MsFileService["startBitfsPurchase"]>>) => call(() => service.startBitfsPurchase!(...args)) } : {}),
    ...(service.cancelBitfsPurchase ? { cancelBitfsPurchase: (...args: Parameters<NonNullable<MsFileService["cancelBitfsPurchase"]>>) => call(() => service.cancelBitfsPurchase!(...args)) } : {}),
    ...(service.cancelBitfsDemand ? { cancelBitfsDemand: (...args: Parameters<NonNullable<MsFileService["cancelBitfsDemand"]>>) => call(() => service.cancelBitfsDemand!(...args)) } : {}),
    connect: Object.freeze(Object.assign(Object.create(null), {
      stat: (...args: Parameters<MsFileService["connect"]["stat"]>) => call(() => service.connect.stat(...args)),
      readSeed: (...args: Parameters<MsFileService["connect"]["readSeed"]>) => call(() => service.connect.readSeed(...args)),
      readBlock: (...args: Parameters<MsFileService["connect"]["readBlock"]>) => call(() => service.connect.readBlock(...args)),
    } satisfies MsFileService["connect"])),
  } satisfies MsFileService));
}
