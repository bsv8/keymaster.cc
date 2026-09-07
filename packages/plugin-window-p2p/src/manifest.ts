import type { PluginManifest, PluginSetup, PluginContext } from "@keymaster/contracts";
import { WINDOW_P2P_COORDINATOR_CONTROL_CAPABILITY, WINDOW_P2P_EXECUTOR_CAPABILITY, defineRuntimeUnitProvidedContracts, type WindowP2pCoordinatorControl } from "@keymaster/contracts";
import { createWindowP2pLaneRegistry } from "./laneRegistry.js";
import { installWindowP2pExecutor } from "./windowExecutor.js";

/** 唯一 Window Host/lease/lane owner 的系统插件。 */
const windowP2pPluginDefinition = {
  id: "window-p2p",
  name: "Window P2P",
  description: "唯一的 bitcoin-libp2p Host、executor lease 和受限网络 lane。",
  meta: {
    kind: "platform",
    startup: "optional",
    bootstrapStage: "owner-apps-ready",
    defaultEnabled: true,
    canDisable: false,
    displayGroup: "platform"
  },
  units: [{
    id: "window-p2p.window",
    execution: "window",
    lifetime: "root",
    provides: [WINDOW_P2P_EXECUTOR_CAPABILITY, WINDOW_P2P_COORDINATOR_CONTROL_CAPABILITY],
    providedContracts: defineRuntimeUnitProvidedContracts([
      WINDOW_P2P_EXECUTOR_CAPABILITY,
      WINDOW_P2P_COORDINATOR_CONTROL_CAPABILITY,
    ]),
  }, {
    id: "window-p2p.coordinator-worker",
    execution: "coordinator-worker",
    lifetime: "owner-session",
  }],
  setup(ctx: PluginContext) {
    const coordinator = ctx.coordinator as WindowP2pCoordinatorControl | undefined;
    if (!coordinator) throw new Error("Window P2P Coordinator control is unavailable");
    ctx.provide(WINDOW_P2P_COORDINATOR_CONTROL_CAPABILITY, coordinator);
    const registry = createWindowP2pLaneRegistry();
    ctx.provide(WINDOW_P2P_EXECUTOR_CAPABILITY, registry);
    // 施工单 001 的旧 executor spike 自己驱动同一条真实 Worker lease；
    // 只有明确进入 ?msfileSpike 的隔离页面时才停用正式 executor。验证构建
    // 同时承载正式 MSFile runtime 页面，不能因为构建级标志而误停正式装配。
    const spikeBuild = (globalThis as typeof globalThis & { __KEYMASTER_MSFILE_SPIKE__?: unknown }).__KEYMASTER_MSFILE_SPIKE__ === true;
    const legacyExecutorHarness = spikeBuild
      && typeof window !== "undefined"
      && new URLSearchParams(window.location.search).has("msfileSpike");
    const cleanupExecutor = legacyExecutorHarness ? () => undefined : installWindowP2pExecutor(coordinator, registry);
    return () => {
      // Window executor 的 dispose 需要等待 lease 先撤销、再关闭 lane/Host；
      // 把 Promise 传回 ResourceScope，页面销毁时才能纳入统一清理边界。
      return cleanupExecutor();
    };
  }
} satisfies PluginManifest & { setup: PluginSetup };

const { setup: windowP2pSetup, ...windowP2pPlugin } = windowP2pPluginDefinition;
export { windowP2pSetup, windowP2pPlugin };
