import type { PluginManifest, PluginContext } from "@keymaster/contracts";
import { WINDOW_P2P_COORDINATOR_CONTROL_CAPABILITY, WINDOW_P2P_EXECUTOR_CAPABILITY, type WindowP2pCoordinatorControl } from "@keymaster/contracts";
import { createWindowP2pLaneRegistry } from "./laneRegistry.js";
import { installWindowP2pExecutor } from "./windowExecutor.js";

/** 唯一 Window Host/lease/lane owner 的系统插件。 */
export const windowP2pPlugin: PluginManifest = {
  id: "window-p2p",
  name: "Window P2P",
  description: "唯一的 bitcoin-libp2p Host、executor lease 和受限网络 lane。",
  meta: {
    kind: "platform",
    startup: "optional",
    bootstrapStage: "owner-apps-ready",
    defaultEnabled: true,
    canDisable: false,
    providesCapabilities: [WINDOW_P2P_EXECUTOR_CAPABILITY, WINDOW_P2P_COORDINATOR_CONTROL_CAPABILITY],
    displayGroup: "platform"
  },
  dependencies: [],
  setup(ctx: PluginContext) {
    const coordinator = ctx.coordinator as WindowP2pCoordinatorControl | undefined;
    if (!coordinator) throw new Error("Window P2P Coordinator control is unavailable");
    ctx.provide(WINDOW_P2P_COORDINATOR_CONTROL_CAPABILITY, coordinator);
    const registry = createWindowP2pLaneRegistry();
    ctx.provide(WINDOW_P2P_EXECUTOR_CAPABILITY, registry);
    const cleanupExecutor = installWindowP2pExecutor(coordinator, registry);
    return () => {
      cleanupExecutor();
    };
  }
};
