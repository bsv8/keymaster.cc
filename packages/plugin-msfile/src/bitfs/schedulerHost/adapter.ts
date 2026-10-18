// 下载策略器内核适配器：组装/恢复任务、投递事件、收集命令并与 outbox 一起持久化。

import {
  createTask, nextWakeAt, restoreTask, step, view,
  type Command, type Content, type Event, type Payload, type State, type View,
} from "keymaster.cc-download-scheduler";
import { MonotonicClock, schedulerEventTimes } from "./clock.js";
import { schedulerKernelConfig, type SchedulerHostSettings } from "./settings.js";
import type { SchedulerOutboxEntry, SchedulerSnapshotStore } from "./store.js";

export interface SchedulerAdapterInit {
  store: SchedulerSnapshotStore;
  clock: MonotonicClock;
  /** 宿主任务编号（owner + network + seedHash 级唯一）；内核 taskId 直接使用它。 */
  taskId: string;
  seedHash: string;
  settings: SchedulerHostSettings;
  manifestKnown: boolean;
  content: Content[];
  reused?: string[];
}

export interface SchedulerEventInput {
  /** 稳定事件编号：同一事实在重启和重放后必须复用同一编号。 */
  eventId: string;
  payload: Payload;
  /** 事实发生时刻；缺省与 receivedAt 相同。 */
  occurredAt?: number;
}

export class SchedulerAdapter {
  private constructor(
    private readonly store: SchedulerSnapshotStore,
    private readonly clock: MonotonicClock,
    private state: State,
    private outbox: SchedulerOutboxEntry[],
  ) {}

  /** 恢复已有快照；没有则以设置建新任务并立即落盘。 */
  static async open(init: SchedulerAdapterInit): Promise<SchedulerAdapter> {
    const stored = await init.store.load();
    if (stored) {
      const state = restoreTask(stored.snapshot.state);
      return new SchedulerAdapter(init.store, init.clock, state, stored.snapshot.outbox.map((entry) => ({ ...entry })));
    }
    const state = createTask({
      taskId: init.taskId,
      seedHash: init.seedHash,
      config: schedulerKernelConfig(init.settings),
      content: init.content,
      manifestKnown: init.manifestKnown,
      ...(init.reused === undefined ? {} : { reused: init.reused }),
    });
    const saved = await init.store.save({ state, outbox: [] });
    return new SchedulerAdapter(init.store, init.clock, saved.snapshot.state, []);
  }

  /**
   * 投递一个事实并推进内核；命令登记进 outbox 后与状态一起原子保存。
   * 返回本次新产生的命令，由执行层按 commandId 幂等执行。
   */
  async handle(input: SchedulerEventInput): Promise<Command[]> {
    const receivedAt = this.clock.now();
    const times = schedulerEventTimes(input.occurredAt ?? receivedAt, receivedAt);
    const event = { ...input.payload, eventId: input.eventId, taskId: this.state.taskId, ...times } as Event;
    const result = step(this.state, event);
    this.state = result.state;
    for (const command of result.commands) {
      if (!this.outbox.some((entry) => entry.commandId === command.commandId)) {
        this.outbox.push({ commandId: command.commandId, type: command.type, revision: command.revision, command });
      }
    }
    await this.store.save({ state: this.state, outbox: this.outbox });
    return result.commands;
  }

  /** 命令对应的执行结果已经作为事实落盘后，从 outbox 移除。 */
  async settle(commandId: string): Promise<void> {
    const next = this.outbox.filter((entry) => entry.commandId !== commandId);
    if (next.length === this.outbox.length) return;
    this.outbox = next;
    await this.store.save({ state: this.state, outbox: next });
  }

  view(): View { return view(this.state); }

  /** 宿主按此重建定时器；重启后直接由恢复的 state 计算。 */
  nextWakeAt(): number | null { return nextWakeAt(this.state); }

  snapshot(): State { return this.state; }

  pendingCommands(): readonly SchedulerOutboxEntry[] { return this.outbox; }
}
