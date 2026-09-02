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
      if (!lane || typeof lane.laneId !== "string" || lane.laneId.length === 0 || lanes.has(lane.laneId)) {
        throw new Error("Window P2P lane id is invalid or already registered");
      }
      lanes.set(lane.laneId, lane);
      if (context) void Promise.resolve(lane.start(context)).catch(() => undefined);
      return () => {
        if (!lanes.delete(lane.laneId)) return;
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
