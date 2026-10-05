import { createFixtureHost as createPluginHost } from "@keymaster/runtime/test-support";
import { describe, expect, it, vi } from "vitest";
import { WINDOW_P2P_COORDINATOR_CONTROL_CAPABILITY, WINDOW_P2P_EXECUTOR_CAPABILITY } from "@keymaster/contracts";

import { windowP2pPlugin, windowP2pSetup } from "./manifest.js";

vi.mock("./windowExecutor.js", () => ({
  installWindowP2pExecutor: vi.fn(() => () => undefined)
}));

describe("windowP2pPlugin manifest", () => {

  it("provides the lane registry and clears its capability on revocation", async () => {
    const host = createPluginHost({ runtime: "window-main",  coordinatorForPlugin: () => ({
      getBootstrapSnapshot: () => ({ vaultStatus: "locked", sessionEpoch: "test" }),
      subscribeTopic: () => () => undefined
    }), runtimeUnitImplementationRegistry: {
      get: (pluginId, unitId) => pluginId === windowP2pPlugin.id && unitId === windowP2pPlugin.units?.[0]?.id
        ? windowP2pSetup
        : undefined,
    } });
    await host.register(windowP2pPlugin);

    expect(host.capabilities.has(WINDOW_P2P_EXECUTOR_CAPABILITY)).toBe(true);
    await host.revoke("window-p2p", "test revocation");
    expect(host.capabilities.has(WINDOW_P2P_EXECUTOR_CAPABILITY)).toBe(false);
    expect(host.state("window-p2p").kind).toBe("blocked");
  });
});
