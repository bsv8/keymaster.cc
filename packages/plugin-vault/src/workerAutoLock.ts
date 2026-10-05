import type { CoordinatorResponse, CoordinatorVaultStatus, SessionEpoch } from "@keymaster/contracts";
import { AUTO_LOCK_NEVER_TIMEOUT_MS, isValidAutoLockTimeoutMs, normalizeAutoLockTimeoutMs } from "@keymaster/contracts";

export interface WorkerAutoLockPorts {
  session(): { sessionEpoch: SessionEpoch; runGeneration: string; vaultStatus: CoordinatorVaultStatus };
  timeout(): number | undefined;
  commitTimeout(timeoutMs: number): void;
  deadline(): number | undefined;
  commitDeadline(deadline: number | undefined): void;
  keepUnlocked(): boolean;
  persistTimeout(timeoutMs: number): Promise<void>;
  publishSettings(): void;
  lock(): Promise<unknown>;
}
/** The authoritative Vault session owns one timer, including seller keep-unlocked policy. */
export function createWorkerAutoLock(ports: WorkerAutoLockPorts) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  function pause(): void {
    generation += 1;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    ports.commitDeadline(undefined);
  }
  function reset(): void {
    pause();
    if (ports.keepUnlocked()) return;
    const timeoutMs = normalizeAutoLockTimeoutMs(ports.timeout());
    ports.commitTimeout(timeoutMs);
    if (timeoutMs === AUTO_LOCK_NEVER_TIMEOUT_MS) return;
    const session = ports.session();
    const token = generation;
    ports.commitDeadline(Date.now() + timeoutMs);
    timer = setTimeout(() => {
      if (token !== generation) return;
      timer = undefined;
      const current = ports.session();
      const deadline = ports.deadline();
      if (current.sessionEpoch === session.sessionEpoch && current.runGeneration === session.runGeneration
        && current.vaultStatus === "unlocked" && deadline && Date.now() >= deadline) void ports.lock();
    }, timeoutMs);
  }
  async function update(requestId: string, request: { kind: "autolock.settings.update"; settings: { timeoutMs: number }; expectedSessionEpoch: SessionEpoch }): Promise<CoordinatorResponse> {
    const epoch = ports.session().sessionEpoch;
    if (request.expectedSessionEpoch !== epoch && request.expectedSessionEpoch !== "boot" && request.expectedSessionEpoch !== "locked") {
      return { requestId, sessionEpoch: epoch, ack: { status: "stale-epoch" } };
    }
    const timeoutMs = request.settings?.timeoutMs;
    if (!isValidAutoLockTimeoutMs(timeoutMs)) return { requestId, sessionEpoch: epoch, ack: { status: "validation-error", message: "Invalid auto-lock timeout" } };
    // The combined legacy settings snapshot remains one atomic authority transaction.
    await ports.persistTimeout(timeoutMs);
    ports.commitTimeout(timeoutMs);
    if (ports.session().vaultStatus === "unlocked") reset();
    else pause();
    ports.publishSettings();
    return { requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "accepted" } };
  }
  return { reset, pause, update };
}
