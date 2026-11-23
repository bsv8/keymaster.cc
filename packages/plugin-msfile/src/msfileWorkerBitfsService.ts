import type { CoordinatorMsFileControl, MsFileBitfsDemandSnapshot, MsFileService } from "@keymaster/contracts";
import { createPublicMsFileService } from "./publicMsFileService.js";

type BitfsControl = Extract<CoordinatorMsFileControl, { type: "bitfs.demand.snapshot" }>;

/** Worker consumers use the same BitFS control queue as the Window proxy.
 * The local file runtime alone has no demand/payment methods. Compose the
 * existing owner-bound executor; never create a second buyer or funding store.
 * The executor must retain the coordinator's final I/O lease and epoch fence.
 */
export function createMsFileWorkerBitfsService(
  service: MsFileService,
  execute: (control: BitfsControl) => Promise<MsFileBitfsDemandSnapshot | undefined>,
  assertActive: () => void,
  connectContent?: MsFileService["connectContent"],
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
    connectContent,
    getBitfsDemand: seedHashHex => snapshot({ type: "bitfs.demand.snapshot", seedHashHex }),
  }, assertActive);
}
