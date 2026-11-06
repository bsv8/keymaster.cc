// 下载策略器内核适配器：组装/恢复任务、投递事件、收集命令并与 outbox 一起持久化。

import {
  createDownloadScheduler,
  nextWakeAt, restoreTask, step, view,
  type Command, type Config, type CreateTaskInput, type DownloadScheduler,
  type Event, type Payload, type State, type View,
} from "keymaster-trade-scheduler";
import { traceDev } from "@keymaster/contracts";
import { MonotonicClock, schedulerEventTimes } from "./clock.js";
import { schedulerKernelConfig, type SchedulerHostSettings } from "./settings.js";
import type { SchedulerOutboxEntry, SchedulerSnapshotStore } from "./store.js";

export interface SchedulerAdapterInit {
  store: SchedulerSnapshotStore;
  clock: MonotonicClock;
  /** 宿主任务编号（owner + network + seedHash 级唯一）；内核 taskId 直接使用它。 */
  taskId: string;
  seedHash: string;
  /** 已按本地字节重验的文件信息；缺省表示种子未知，内核先购买 Seed。 */
  fileInfo?: {
    fileBytes: number;
    blockBytes: number;
    blockHashes: string[];
    reusedBlockHashes?: string[];
  };
}

/** 同一 owner/network 生命周期内共享的调度器实例（配置相同则复用）。 */
const sharedSchedulers = new Map<string, { configJson: string; scheduler: DownloadScheduler }>();

/** 取回或创建该 owner/network 的共享实例；配置变化时重建，不影响已创建任务。 */
export function sharedDownloadScheduler(key: string, settings: SchedulerHostSettings): DownloadScheduler {
  const config: Config = schedulerKernelConfig(settings);
  const configJson = JSON.stringify(config);
  const cached = sharedSchedulers.get(key);
  if (cached && cached.configJson === configJson) return cached.scheduler;
  const scheduler = createDownloadScheduler(config);
  sharedSchedulers.set(key, { configJson, scheduler });
  return scheduler;
}

export interface SchedulerEventInput {
  /** 稳定事件编号：同一事实在重启和重放后必须复用同一编号。 */
  eventId: string;
  payload: Payload;
  /** 事实发生时刻；缺省与 receivedAt 相同。 */
  occurredAt?: number;
}

export class SchedulerAdapter {
  private mutationTail: Promise<void> = Promise.resolve();
  private retired = false;

  /** 撤销运行代际并等已进入的原子写完成；不删除任何责任或 outbox。 */
  retire(): Promise<void> {
    this.retired = true;
    return this.mutationTail;
  }

  /** 只串行化状态提交，不在锁内执行会回灌事件的协议命令。 */
  private mutate<T>(run: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(run);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private constructor(
    private readonly store: SchedulerSnapshotStore,
    private readonly clock: MonotonicClock,
    private state: State,
    private outbox: SchedulerOutboxEntry[],
  ) {}

  /** 恢复已有快照；没有则以设置建新任务并立即落盘。 */
  static async open(init: SchedulerAdapterInit & { scheduler: DownloadScheduler }): Promise<SchedulerAdapter> {
    const stored = await init.store.load();
    if (stored) {
      const state = restoreTask(stored.snapshot.state);
      return new SchedulerAdapter(init.store, init.clock, state, stored.snapshot.outbox.map((entry) => ({ ...entry })));
    }
    const create: CreateTaskInput = { taskId: init.taskId, seedHash: init.seedHash };
    if (init.fileInfo) {
      create.fileBytes = init.fileInfo.fileBytes;
      create.blockBytes = init.fileInfo.blockBytes;
      create.blockHashes = init.fileInfo.blockHashes;
      if (init.fileInfo.reusedBlockHashes !== undefined) create.reusedBlockHashes = init.fileInfo.reusedBlockHashes;
    }
    const state = init.scheduler.createTask(create);
    const saved = await init.store.save({ state, outbox: [] });
    return new SchedulerAdapter(init.store, init.clock, saved.snapshot.state, []);
  }

  /**
   * 投递一个事实并推进内核；命令登记进 outbox 后与状态一起原子保存。
   * 返回本次新产生的命令，由执行层按 commandId 幂等执行。
   */
  handle(input: SchedulerEventInput): Promise<Command[]> {
    return this.mutate(async () => {
      if (this.retired) return [];
      const receivedAt = this.clock.now();
      const times = schedulerEventTimes(input.occurredAt ?? receivedAt, receivedAt);
      const event = { ...input.payload, eventId: input.eventId, taskId: this.state.taskId, ...times } as Event;
      traceDev("keymaster.scheduler", "event.start", () => ({taskId: this.state.taskId, revision: this.state.revision, event}));
      const result = step(this.state, event);
      const next = [...this.outbox];
      for (const command of result.commands) {
        if (!next.some((entry) => entry.commandId === command.commandId)) {
          next.push({ commandId: command.commandId, type: command.type, revision: command.revision, command });
        }
      }
      await this.store.save({ state: result.state, outbox: next });
      this.state = result.state;
      this.outbox = next;
      traceDev("keymaster.scheduler", "event.committed", () => ({taskId: this.state.taskId, eventId: event.eventId,
        revision: this.state.revision, failure: this.state.failure, commands: result.commands, pools: this.state.pools, spent: this.state.spent,
        pendingCommandIds: next.map(entry => entry.commandId)}));
      return result.commands;
    });
  }

  /** 命令对应的执行结果已经作为事实落盘后，从 outbox 移除。 */
  settle(commandId: string): Promise<void> {
    return this.mutate(async () => {
      if (this.retired) return;
      const next = this.outbox.filter((entry) => entry.commandId !== commandId);
      if (next.length === this.outbox.length) return;
      await this.store.save({ state: this.state, outbox: next });
      this.outbox = next;
      traceDev("keymaster.scheduler", "command.settled", () => ({taskId: this.state.taskId, commandId, pendingCommandIds: next.map(entry => entry.commandId)}));
    });
  }

  view(): View { return view(this.state); }

  /** 宿主按此重建定时器；重启后直接由恢复的 state 计算。 */
  nextWakeAt(): number | null { return nextWakeAt(this.state); }

  snapshot(): State { return this.state; }

  pendingCommands(): readonly SchedulerOutboxEntry[] { return this.outbox; }
}
