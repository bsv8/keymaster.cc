import { describe, expect, it } from "vitest";
import {
  SYSTEM_SETTINGS_REGISTRY_CAPABILITY,
  SYSTEM_STATUS_REGISTRY_CAPABILITY,
  WINDOW_P2P_EXECUTOR_CAPABILITY
} from "@keymaster/contracts";
import { SAT_SUBSCRIPTION_ROUTE_PATH, satSubscriptionPlugin } from "./manifest.js";

describe("satSubscriptionPlugin manifest", () => {
  it("is a default-on, non-disableable system plugin attached to Window P2P", () => {
    expect(satSubscriptionPlugin).toMatchObject({
      defaultEnabled: true,
      canDisable: false,
    });
    const unit = satSubscriptionPlugin.units?.find((candidate) => candidate.runtime === "window-main");
    expect(unit?.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: WINDOW_P2P_EXECUTOR_CAPABILITY }),
      expect.objectContaining({ capability: SYSTEM_STATUS_REGISTRY_CAPABILITY }),
    ]));
    expect(unit?.dependencies).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: SYSTEM_SETTINGS_REGISTRY_CAPABILITY }),
    ]));
    expect(SAT_SUBSCRIPTION_ROUTE_PATH).toBe("/settings/system-status");
  });
});
