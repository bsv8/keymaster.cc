import type { PluginManifest, PluginContext } from "@keymaster/contracts";
import {
  SESSION_COORDINATOR_CLIENT_CAPABILITY,
  WINDOW_P2P_EXECUTOR_CAPABILITY,
  type SessionCoordinatorClient
} from "@keymaster/contracts";
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
    defaultEnabled: true,
    canDisable: false,
    providesCapabilities: [WINDOW_P2P_EXECUTOR_CAPABILITY],
    displayGroup: "platform"
  },
  dependencies: [
    { capability: SESSION_COORDINATOR_CLIENT_CAPABILITY, reason: "P2P lease 与 TypedSigner 由 Coordinator 管理" }
  ],
  setup(ctx: PluginContext) {
    const coordinator = ctx.get<SessionCoordinatorClient>(SESSION_COORDINATOR_CLIENT_CAPABILITY);
    const registry = createWindowP2pLaneRegistry();
    ctx.provide(WINDOW_P2P_EXECUTOR_CAPABILITY, registry);
    const cleanupExecutor = installWindowP2pExecutor(coordinator, registry);
    return () => {
      cleanupExecutor();
    };
  }
};
