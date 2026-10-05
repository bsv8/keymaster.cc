import type { ContactPresenceMap, ContactsService, CoordinatorContactsPresenceEvent, CoordinatorResponse } from "@keymaster/contracts";

interface PresenceProjectionPorts {
  service(): Pick<ContactsService, "getPresenceSnapshot"> | undefined;
  session(): { owner: string | null; epoch: string };
  publish(input: { type: "contacts.presence.changed"; activePublicKeyHex: string | null; presence: ContactPresenceMap }): CoordinatorContactsPresenceEvent;
}
/** Contacts owns its serial, session-fenced presence projection. */
export function createWorkerPresenceProjection(ports: PresenceProjectionPorts) {
  let tail: Promise<void> = Promise.resolve();
  let cached: CoordinatorContactsPresenceEvent | undefined;
  let generation = 0;
  function publish(): void {
    const service = ports.service();
    const session = ports.session();
    const token = generation;
    const run = tail.then(async () => {
      let presence: ContactPresenceMap = {};
      if (service && session.owner) {
        try { presence = await service.getPresenceSnapshot?.() ?? {}; }
        catch { /* An unreadable local snapshot projects all contacts offline. */ }
      }
      const current = ports.session();
      if (token !== generation || service !== ports.service() || session.owner !== current.owner || session.epoch !== current.epoch) return;
      cached = ports.publish({ type: "contacts.presence.changed", activePublicKeyHex: session.owner, presence });
    });
    tail = run.then(() => undefined, () => undefined);
  }
  async function snapshot(requestId: string, expectedEpoch: string): Promise<CoordinatorResponse> {
    const service = ports.service();
    const session = ports.session();
    const token = generation;
    const stale = () => token !== generation || service !== ports.service() || session.owner !== ports.session().owner || session.epoch !== ports.session().epoch;
    const staleResult = (): CoordinatorResponse => ({ requestId, sessionEpoch: ports.session().epoch, ack: { status: "stale-epoch" } });
    if (expectedEpoch !== session.epoch) return staleResult();
    try {
      const presence = session.owner ? await service?.getPresenceSnapshot?.() ?? {} : {};
      if (stale()) return staleResult();
      return { requestId, sessionEpoch: session.epoch, ack: { status: "ok" }, operationResult: presence };
    } catch (error) {
      if (stale()) return staleResult();
      return { requestId, sessionEpoch: session.epoch, ack: { status: "error", message: error instanceof Error ? error.message : String(error) } };
    }
  }
  return { publish, snapshot, current: () => cached, reset: () => { generation += 1; cached = undefined; tail = Promise.resolve(); } };
}
