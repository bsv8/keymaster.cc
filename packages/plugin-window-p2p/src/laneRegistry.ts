import type {
  WindowP2pExecutorLane,
  WindowP2pExecutorLaneContext,
  WindowP2pExecutorLaneRegistry
} from "@keymaster/contracts";

/** 公共 Window Host 的 lane 注册表；所有 lane 共享同一 attach/detach 生命周期。 */
export interface WindowP2pLaneRegistry extends WindowP2pExecutorLaneRegistry {
  /** 把集中并发/资源配置下发到已注册 lane。 */
  configure(config: unknown): void;
}

export function createWindowP2pLaneRegistry(): WindowP2pLaneRegistry {
  const lanes = new Map<string, WindowP2pExecutorLane>();
  let context: WindowP2pExecutorLaneContext | undefined;

  return {
    register(lane) {
      if (!lane || typeof lane.laneId !== "string" || lane.laneId.length === 0) {
        throw new Error("Window P2P lane id is invalid or already registered");
      }
      // 身份切换（切换桶/Key）会重建 owner-session 插件；旧实例的 teardown
      // 可能迟到，此时新实例会注册同一个 laneId。替换而不是拒绝：先停旧
      // lane，保证同一 laneId 同时最多一个活跃实例，也不让身份切换把插件
      // 打成 error-disabled。旧实例迟到的注销只能移除它自己。
      const previous = lanes.get(lane.laneId);
      if (previous && previous !== lane) {
        void Promise.resolve(previous.stop()).catch(() => undefined);
      }
      lanes.set(lane.laneId, lane);
      if (context) void Promise.resolve(lane.start(context)).catch(() => undefined);
      return () => {
        // 已经被新实例替换时，旧实例的注销不能误删新 lane。
        if (lanes.get(lane.laneId) !== lane) return;
        lanes.delete(lane.laneId);
        void Promise.resolve(lane.stop()).catch(() => undefined);
      };
    },
    async attach(nextContext) {
      // attach 前先 stop 旧 lane，避免 lease takeover 后旧连接残留。
      if (context) await this.detach();
      context = nextContext;
      try {
        for (const lane of lanes.values()) await lane.start(nextContext);
      } catch (error) {
        await this.detach();
        throw error;
      }
    },
    async detach() {
      const current = context;
      context = undefined;
      if (!current) return;
      for (const lane of lanes.values()) await Promise.resolve(lane.stop()).catch(() => undefined);
    },
    async dispatch(laneId, operation, signal) {
      const lane = lanes.get(laneId);
      if (!lane || !context) throw new Error(`Window P2P lane is unavailable: ${laneId}`);
      return lane.handle(operation, signal);
    },
    async rejectEvent(laneId, event, error) {
      const lane = lanes.get(laneId);
      if (!lane || !context) return;
      await Promise.resolve(lane.rejectEvent?.(event, error));
    },
    configure(config) {
      for (const lane of lanes.values()) {
        try { lane.configure?.(config); } catch { /* 配置不生效时由 lane 请求 fail closed */ }
      }
    }
  };
}
