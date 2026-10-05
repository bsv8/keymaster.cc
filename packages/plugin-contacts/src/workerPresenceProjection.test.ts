import { expect, it, vi } from "vitest";
import type { ContactPresenceMap, CoordinatorContactsPresenceEvent } from "@keymaster/contracts";
import { createWorkerPresenceProjection } from "./workerPresenceProjection.js";
it("never publishes an old presence query into a replacement owner's epoch", async () => {
  let epoch = "first";
  let complete!: (value: ContactPresenceMap) => void;
  const service = { getPresenceSnapshot: vi.fn(() => new Promise<ContactPresenceMap>(resolve => { complete = resolve; })) };
  const publish = vi.fn(() => ({}) as CoordinatorContactsPresenceEvent);
  const projection = createWorkerPresenceProjection({ service: () => service, session: () => ({ owner: "owner", epoch }), publish });
  projection.publish();
  await vi.waitFor(() => expect(service.getPresenceSnapshot).toHaveBeenCalledOnce());
  epoch = "second";
  projection.reset();
  complete({});
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(publish).not.toHaveBeenCalled();
  expect(projection.current()).toBeUndefined();
});

it("returns stale-epoch rather than a previous owner's late RPC snapshot", async () => {
  let epoch = "first";
  let complete!: (value: ContactPresenceMap) => void;
  const service = { getPresenceSnapshot: () => new Promise<ContactPresenceMap>(resolve => { complete = resolve; }) };
  const projection = createWorkerPresenceProjection({ service: () => service, session: () => ({ owner: "owner", epoch }), publish: () => ({}) as CoordinatorContactsPresenceEvent });
  const pending = projection.snapshot("request", "first");
  epoch = "second";
  complete({});
  expect(await pending).toEqual({ requestId: "request", sessionEpoch: "second", ack: { status: "stale-epoch" } });
});
