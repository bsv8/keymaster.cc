import { describe, expect, it, vi } from "vitest";
import { WINDOW_P2P_COORDINATOR_CONTROL_CAPABILITY, WINDOW_P2P_EXECUTOR_CAPABILITY } from "@keymaster/contracts";
import { createPluginHost } from "@keymaster/runtime";
import { windowP2pPlugin } from "./manifest.js";

vi.mock("./windowExecutor.js", () => ({
  installWindowP2pExecutor: vi.fn(() => () => undefined)
}));

describe("windowP2pPlugin manifest", () => {
  it("is a default-on non-disableable system owner", () => {
    expect(windowP2pPlugin.meta).toMatchObject({
      defaultEnabled: true,
      canDisable: false,
      providesCapabilities: [WINDOW_P2P_EXECUTOR_CAPABILITY, WINDOW_P2P_COORDINATOR_CONTROL_CAPABILITY]
    });
  });

  it("provides the lane registry and rejects an independent disable", async () => {
    const host = createPluginHost({ disableConfigPersistence: true, coordinatorForPlugin: () => ({
      getBootstrapSnapshot: () => ({ vaultStatus: "locked", sessionEpoch: "test" }),
      subscribeTopic: () => () => undefined
    }) });
    await host.register(windowP2pPlugin);

    expect(host.capabilities.has(WINDOW_P2P_EXECUTOR_CAPABILITY)).toBe(true);
    expect(await host.disable("window-p2p")).toEqual({ ok: false, reason: "Plugin is marked canDisable=false" });
  });
});
