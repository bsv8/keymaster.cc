import type { CoordinatorMsFileControl, MsFileBitfsDemandSnapshot, MsFileService } from "@keymaster/contracts";
import { createPublicMsFileService } from "./publicMsFileService.js";

type BitfsControl = Extract<CoordinatorMsFileControl, { type: "bitfs.demand.publish" | "bitfs.demand.snapshot" | "bitfs.demand.cancel" | "bitfs.purchase.start" | "bitfs.purchase.cancel" }>;

/** Worker consumers use the same BitFS control queue as the Window proxy.
 * The local file runtime alone has no demand/payment methods. Compose the
 * existing owner-bound executor; never create a second buyer or funding store.
 * The executor must retain the coordinator's final I/O lease and epoch fence.
 */
export function createMsFileWorkerBitfsService(
  service: MsFileService,
  execute: (control: BitfsControl) => Promise<MsFileBitfsDemandSnapshot | undefined>,
  assertActive: () => void,
): MsFileService {
  const snapshot = async (control: BitfsControl): Promise<MsFileBitfsDemandSnapshot> => {
    const result = await execute(control);
    if (!result) throw new Error("MSFile BitFS control returned no demand snapshot");
    return result;
  };
  // Project first: spreading the implementation would lose prototype methods
  // and expose private references. The outer projection fences every result.
  return createPublicMsFileService({
    ...createPublicMsFileService(service, assertActive),
    publishBitfsDemand: seedHashHex => snapshot({ type: "bitfs.demand.publish", seedHashHex }),
    getBitfsDemand: seedHashHex => snapshot({ type: "bitfs.demand.snapshot", seedHashHex }),
    startBitfsPurchase: (seedHashHex, sessionId, maxFullBlockPriceSatoshis) => snapshot({
      type: "bitfs.purchase.start", seedHashHex, sessionId,
      ...(maxFullBlockPriceSatoshis === undefined ? {} : { maxFullBlockPriceSatoshis }),
    }),
    cancelBitfsPurchase: (seedHashHex, sessionId) => snapshot({ type: "bitfs.purchase.cancel", seedHashHex, sessionId }),
    cancelBitfsDemand: seedHashHex => execute({ type: "bitfs.demand.cancel", seedHashHex }).then(() => undefined),
  }, assertActive);
}
