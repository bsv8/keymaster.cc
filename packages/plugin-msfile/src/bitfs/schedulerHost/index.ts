// 下载策略器宿主适配层：设置映射、单调时钟、快照持久化与内核适配器。

export { SchedulerAdapter, type SchedulerAdapterInit, type SchedulerEventInput } from "./adapter.js";
export { SchedulerCommandExecutor, type SchedulerCommandPorts } from "./executor.js";
export { MonotonicClock, schedulerEventId, schedulerEventTimes } from "./clock.js";
export {
  SCHEDULER_HOST_DEFAULTS, schedulerKernelConfig, schedulerSeatSplit,
  type SchedulerHostSettings,
} from "./settings.js";
export {
  createSchedulerSnapshotStore, type SchedulerLoadedSnapshot,
  type SchedulerOutboxEntry, type SchedulerSnapshotStore, type SchedulerStoredSnapshot,
} from "./store.js";
