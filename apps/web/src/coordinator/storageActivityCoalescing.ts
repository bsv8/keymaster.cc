import type { CoordinatorTopicEvent } from "@keymaster/contracts";

/** Activity is a current counter projection, never an I/O history or authority event. */
export function canCoalesceStorageActivity(previous: CoordinatorTopicEvent | undefined, next: CoordinatorTopicEvent): boolean {
  return previous?.topic === "storage.state" && next.topic === "storage.state"
    && previous.activity !== undefined && next.activity !== undefined
    && previous.sessionEpoch === next.sessionEpoch
    && previous.walletGeneration === next.walletGeneration
    && previous.status === next.status
    // Activity publications retain these exact committed authority objects.
    // A new summary/recovery projection must be delivered even if its text
    // happens to match; we never merge wallet transitions or business events.
    && previous.summary === next.summary
    && previous.authorityRecovery === next.authorityRecovery;
}
