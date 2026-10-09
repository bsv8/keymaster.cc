import { expect, it } from "vitest";
import type { CoordinatorTopicEvent } from "@keymaster/contracts";
import { canCoalesceStorageActivity } from "./storageActivityCoalescing.js";

const baseline: CoordinatorTopicEvent = {
  topic: "storage.state", type: "storage.state.changed", storageRevision: 1,
  sessionEpoch: "session", walletGeneration: "wallet", status: "ready",
  summary: null, activity: { reads: 1, writes: 0 },
};

it("coalesces only adjacent activity projections of the same committed authority", () => {
  expect(canCoalesceStorageActivity(baseline, { ...baseline, storageRevision: 2, activity: { reads: 0, writes: 0 } })).toBe(true);
  expect(canCoalesceStorageActivity(undefined, baseline)).toBe(false);
});

it("preserves session, wallet and status transitions", () => {
  expect(canCoalesceStorageActivity(baseline, { ...baseline, sessionEpoch: "next" })).toBe(false);
  expect(canCoalesceStorageActivity(baseline, { ...baseline, walletGeneration: "next" })).toBe(false);
  expect(canCoalesceStorageActivity(baseline, { ...baseline, status: "locked" })).toBe(false);
  expect(canCoalesceStorageActivity(baseline, { ...baseline, activity: undefined })).toBe(false);
});

it("preserves new summaries and business events", () => {
  expect(canCoalesceStorageActivity(baseline, { ...baseline, summary: { status: "ready", medium: "indexeddb", persistence: { persisted: false } } })).toBe(false);
  const asset: CoordinatorTopicEvent = { topic: "asset.data-changed", type: "asset.data-changed", sessionEpoch: "session", providerId: "p2pkh", publicKeyHex: "owner", assetDataRevision: 2, kinds: ["submission"] };
  expect(canCoalesceStorageActivity(baseline, asset)).toBe(false);
  expect(canCoalesceStorageActivity(asset, baseline)).toBe(false);
});
