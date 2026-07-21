import { describe, expect, it, vi } from "vitest";
import { createTransferFeatureCapability } from "./transferFeature.js";

describe("transfer feature capability", () => {
  it("sorts every hook locally and returns idempotent disposers", () => {
    const feature = createTransferFeatureCapability();
    const offLate = feature.registerSource({ id: "z", order: 10, label: "Z" });
    feature.registerSource({ id: "a", order: 10, label: "A" });
    feature.registerQuoteProvider({ id: "quote", order: 2, quote: async () => null });
    feature.registerReviewSection({ id: "review", order: 1, component: () => null });
    feature.registerSubmitHandler({ id: "submit", order: 1, submit: async () => null });
    expect(feature.listSources().map((item) => item.id)).toEqual(["a", "z"]);
    expect(feature.listQuoteProviders().map((item) => item.id)).toEqual(["quote"]);
    expect(feature.listReviewSections().map((item) => item.id)).toEqual(["review"]);
    expect(feature.listSubmitHandlers().map((item) => item.id)).toEqual(["submit"]);
    offLate(); offLate();
    expect(feature.listSources().map((item) => item.id)).toEqual(["a"]);
  });

  it("rejects duplicate ids and notifies subscribers", () => {
    const feature = createTransferFeatureCapability();
    const listener = vi.fn();
    const unsubscribe = feature.subscribe(listener);
    feature.registerSource({ id: "source", order: 1, label: "Source" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(() => feature.registerSource({ id: "source", order: 2, label: "Duplicate" })).toThrow(/already registered/);
    const off = feature.registerSource({ id: "other", order: 2, label: "Other" });
    off();
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
  });
});
