import { describe, expect, it } from "vitest";
import {
  PAGE_UI_REGISTRY_CAPABILITY,
  WINDOW_P2P_EXECUTOR_CAPABILITY
} from "@keymaster/contracts";
import { SAT_SUBSCRIPTION_ROUTE_PATH, satSubscriptionPlugin } from "./manifest.js";

describe("satSubscriptionPlugin manifest", () => {
  it("declares its P2P and scoped page dependencies without a separate settings surface", () => {
    const unit = satSubscriptionPlugin.units?.find((candidate) => candidate.runtime === "window-main");
    expect(unit?.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: WINDOW_P2P_EXECUTOR_CAPABILITY }),
      expect.objectContaining({ capability: PAGE_UI_REGISTRY_CAPABILITY }),
    ]));
    expect(unit?.dependencies?.some(dependency => dependency.capability.id === "system-settings.registry")).toBe(false);
    expect(SAT_SUBSCRIPTION_ROUTE_PATH).toBe("/settings/system-status");
  });
});
