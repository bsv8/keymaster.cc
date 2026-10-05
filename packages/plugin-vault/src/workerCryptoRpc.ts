import type { HandlerCallContext } from "webloom-framework";
import type { CoordinatorCryptoOperation, CoordinatorCryptoResult } from "@keymaster/contracts";
import type { WorkerKeyIdentity, createWorkerKeySession } from "./workerKeySession.js";

export interface WorkerCryptoRpcDependencies {
  authorize(call: HandlerCallContext): void;
  identity(): WorkerKeyIdentity;
  keySession: ReturnType<typeof createWorkerKeySession>;
  withIoLease(signal: AbortSignal, execute: () => Promise<CoordinatorCryptoResult>): Promise<CoordinatorCryptoResult>;
}
/** Only operation DTOs cross the realm boundary. */
export function createWorkerCryptoRpc(deps: WorkerCryptoRpcDependencies) {
  return async (request: CoordinatorCryptoOperation, call: HandlerCallContext): Promise<CoordinatorCryptoResult> => {
    deps.authorize(call);
    if (call.signal.aborted) throw new Error("Coordinator crypto request was cancelled");
    const captured = deps.identity();
    if (!captured.unlocked || !deps.keySession.hasKey()) throw Object.assign(new Error("Coordinator crypto is unavailable"), { code: "service_unavailable" });
    const result = await deps.withIoLease(call.signal, () => deps.keySession.execute(request));
    const current = deps.identity();
    if (call.signal.aborted || captured.sessionEpoch !== current.sessionEpoch || !current.unlocked) {
      throw Object.assign(new Error("Coordinator crypto session became stale"), { code: "service_reference_stale" });
    }
    return result;
  };
}
