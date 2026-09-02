import { describe, expect, it } from "vitest";
import { WINDOW_P2P_EXECUTOR_CAPABILITY } from "@keymaster/contracts";
import { satSubscriptionPlugin } from "./manifest.js";

describe("satSubscriptionPlugin manifest", () => {
  it("is a default-on, non-disableable system plugin attached to Window P2P", () => {
    expect(satSubscriptionPlugin.meta).toMatchObject({
      defaultEnabled: true,
      canDisable: false,
    });
    expect(satSubscriptionPlugin.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: WINDOW_P2P_EXECUTOR_CAPABILITY }),
    ]));
  });
});
