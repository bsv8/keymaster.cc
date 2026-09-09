import { describe, expect, it, vi } from "vitest";
import { WINDOW_P2P_COORDINATOR_CONTROL_CAPABILITY, WINDOW_P2P_EXECUTOR_CAPABILITY } from "@keymaster/contracts";
import { createKeymasterPluginHost as createPluginHost } from "@keymaster/runtime";
import { windowP2pPlugin, windowP2pSetup } from "./manifest.js";

vi.mock("./windowExecutor.js", () => ({
  installWindowP2pExecutor: vi.fn(() => () => undefined)
}));

describe("windowP2pPlugin manifest", () => {
  it("is a default-on non-disableable system owner", () => {
    expect(windowP2pPlugin.meta).toMatchObject({
      defaultEnabled: true,
      canDisable: false,
      displayGroup: "platform"
    });
    expect(windowP2pPlugin.units?.[0]?.provides).toEqual([
      WINDOW_P2P_EXECUTOR_CAPABILITY,
      WINDOW_P2P_COORDINATOR_CONTROL_CAPABILITY,
    ]);
  });

  it("provides the lane registry and rejects an independent disable", async () => {
    const host = createPluginHost({ runtime: "window-main", disableConfigPersistence: true, coordinatorForPlugin: () => ({
      getBootstrapSnapshot: () => ({ vaultStatus: "locked", sessionEpoch: "test" }),
      subscribeTopic: () => () => undefined
    }), runtimeUnitImplementationRegistry: {
      get: (pluginId, unitId) => pluginId === windowP2pPlugin.id && unitId === windowP2pPlugin.units?.[0]?.id
        ? windowP2pSetup
        : undefined,
    } });
    await host.register(windowP2pPlugin);

    expect(host.capabilities.has(WINDOW_P2P_EXECUTOR_CAPABILITY)).toBe(true);
    expect(await host.disable("window-p2p")).toEqual({ ok: false, reason: "Plugin is marked canDisable=false" });
  });
});
