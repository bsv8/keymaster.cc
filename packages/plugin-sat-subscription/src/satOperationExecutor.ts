import type { CoordinatorSatOperation, SatSubscriptionAdminService, SatSubscriptionService, SatSubscriptionSpiService } from "@keymaster/contracts";
import type { SatSubscriptionHandle } from "./satProvider.js";
export interface SatOperationServices {
  admin: SatSubscriptionAdminService;
  service: SatSubscriptionService;
  spi: SatSubscriptionSpiService;
  handle: Pick<SatSubscriptionHandle, "refreshSubscriptions">;
}
/** Sat owns control dispatch; the caller keeps authentication and the final I/O lease. */
export async function executeSatOperation(operation: CoordinatorSatOperation, runtime: SatOperationServices, afterOwnerSettingsChanged?: () => Promise<void>): Promise<unknown> {
  let value: unknown;
  switch (operation.type) {
    case "ensure":
      value = null;
      break;
    case "admin.getSettings":
      value = await runtime.admin.getSettingsSnapshot();
      break;
    case "admin.upsertSupplier":
      await runtime.admin.upsertSupplier(operation.config);
      value = null;
      break;
    case "admin.deleteSupplier":
      await runtime.admin.deleteSupplier(operation.supplierId);
      value = null;
      break;
    case "admin.setOwnerSettings":
      await runtime.admin.setOwnerSettings(operation.settings);
      await afterOwnerSettingsChanged?.();
      value = null;
      break;
    case "admin.refreshSubscriptions":
      value = await runtime.handle.refreshSubscriptions(operation.input);
      break;
    case "admin.getBilling":
      value = await runtime.admin.getBilling(operation.input);
      break;
    case "service.publish": value = await runtime.service.publish(operation.input); break;
    case "spi.getInformation": value = await runtime.spi.getInformation(operation.input); break;
    case "spi.prepareTopUp": value = await runtime.spi.prepareTopUp(operation.input); break;
    case "spi.submitTopUp": value = await runtime.spi.submitTopUp(operation.preview); break;
    case "spi.collectNew": value = await runtime.spi.collectNew(operation.input); break;
    case "spi.retryCollect": value = await runtime.spi.retryCollect(operation.input); break;
    case "spi.collect": value = await runtime.spi.collect(operation.input); break;
  }
  return value;
}
