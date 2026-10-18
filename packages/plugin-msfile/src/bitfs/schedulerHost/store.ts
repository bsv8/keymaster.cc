// 内核快照 + 命令 outbox 的原子持久化；沿用 bitfs-journal 的条件写（CAS）约定。

import type { BorrowedOwnerFileStore } from "@keymaster/contracts";
import type { Command, State } from "keymaster.cc-download-scheduler";

const FORMAT = "keymaster.scheduler-host";
const VERSION = 1;
const locks = new Map<string, Promise<void>>();

/** 已登记但尚未获得执行事实确认的命令；命令按 commandId 幂等执行。 */
export interface SchedulerOutboxEntry {
  commandId: string;
  /** 命令类型，仅供恢复时定位对账入口。 */
  type: string;
  /** 命令创建时的任务修订号，便于排查乱序。 */
  revision: number;
  /** 命令原文；重启后按 commandId 幂等重放。 */
  command: Command;
}

/** 持久化的调度器宿主快照：状态与 outbox 同事务落盘。 */
export interface SchedulerStoredSnapshot {
  format: typeof FORMAT;
  version: typeof VERSION;
  ownerPublicKeyHex: string;
  network: string;
  taskId: string;
  seedHashHex: string;
  state: State;
  outbox: SchedulerOutboxEntry[];
  /** 宿主快照自身修订号；存储条件写另用 storageRevision。 */
  revision: number;
}

/** 读取结果带上存储修订号，供下一次条件写使用。 */
export interface SchedulerLoadedSnapshot {
  snapshot: SchedulerStoredSnapshot;
  storageRevision: string;
}

export interface SchedulerSnapshotStore {
  load(): Promise<SchedulerLoadedSnapshot | undefined>;
  /** 原子保存状态与 outbox；并发修改冲突时抛出。 */
  save(input: { state: State; outbox: readonly SchedulerOutboxEntry[] }): Promise<SchedulerLoadedSnapshot>;
}

function assertObject(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function validate(raw: unknown, owner: string, network: string, taskId: string): SchedulerStoredSnapshot {
  const row = assertObject(raw, "调度器快照损坏");
  if (row.format !== FORMAT || row.version !== VERSION) throw new Error("调度器快照版本不受支持");
  if (row.ownerPublicKeyHex !== owner) throw new Error("调度器快照不属于当前 Key");
  if (row.network !== network) throw new Error("调度器快照网络不匹配");
  if (row.taskId !== taskId) throw new Error("调度器快照任务不匹配");
  if (typeof row.seedHashHex !== "string" || row.seedHashHex.length === 0) throw new Error("调度器快照缺少 Seed Hash");
  if (!Number.isSafeInteger(row.revision) || (row.revision as number) < 1) throw new Error("调度器快照修订号无效");
  const state = assertObject(row.state, "调度器快照缺少内核状态");
  if (!Array.isArray(row.outbox)) throw new Error("调度器快照缺少 outbox");
  const outbox = row.outbox.map((item): SchedulerOutboxEntry => {
    const entry = assertObject(item, "调度器 outbox 条目损坏");
    if (typeof entry.commandId !== "string" || entry.commandId.length === 0) throw new Error("调度器 outbox 缺少命令编号");
    if (typeof entry.type !== "string" || entry.type.length === 0) throw new Error("调度器 outbox 缺少命令类型");
    if (!Number.isSafeInteger(entry.revision) || (entry.revision as number) < 0) throw new Error("调度器 outbox 修订号无效");
    const command = assertObject(entry.command, "调度器 outbox 缺少命令原文");
    if (command.commandId !== entry.commandId || command.type !== entry.type) throw new Error("调度器 outbox 命令与索引不一致");
    return { commandId: entry.commandId, type: entry.type, revision: entry.revision as number, command: command as unknown as Command };
  });
  return {
    format: FORMAT, version: VERSION, ownerPublicKeyHex: owner, network, taskId,
    seedHashHex: row.seedHashHex, state: state as unknown as State, outbox, revision: row.revision as number,
  };
}

export function createSchedulerSnapshotStore(input: {
  store: BorrowedOwnerFileStore;
  ownerPublicKeyHex: string;
  network: string;
  taskId: string;
}): SchedulerSnapshotStore {
  const owner = input.ownerPublicKeyHex.toLowerCase();
  const network = input.network;
  const taskId = input.taskId;
  const path = `scheduler/tasks/${taskId}.json`;
  const lockKey = `${owner}:${network}:${taskId}`;

  const read = async (): Promise<SchedulerLoadedSnapshot | undefined> => {
    const object = await input.store.get(path);
    if (!object) return undefined;
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(object.bytes)); }
    catch { throw new Error("调度器快照损坏"); }
    if (typeof object.revision !== "string" || object.revision.length === 0) throw new Error("调度器快照缺少存储修订号");
    return { snapshot: validate(raw, owner, network, taskId), storageRevision: object.revision };
  };

  return {
    load: read,
    async save({ state, outbox }: { state: State; outbox: readonly SchedulerOutboxEntry[] }): Promise<SchedulerLoadedSnapshot> {
      const previous = locks.get(lockKey) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => { release = resolve; });
      locks.set(lockKey, current);
      await previous;
      try {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const stored = await read();
          const next: SchedulerStoredSnapshot = {
            format: FORMAT, version: VERSION, ownerPublicKeyHex: owner, network, taskId,
            seedHashHex: state.seedHash, state, outbox: outbox.map((entry) => ({ ...entry })),
            revision: (stored?.snapshot.revision ?? 0) + 1,
          };
          const encoded = new TextEncoder().encode(`${JSON.stringify(next)}\n`);
          try {
            await input.store.put(path, encoded, stored ? { ifRevision: stored.storageRevision } : { ifNoneMatch: true });
          } catch { continue; }
          const after = await read();
          if (after?.snapshot.revision === next.revision) return after;
        }
        throw new Error("调度器快照并发修改冲突；已停止推进以避免资金决策分叉");
      } finally {
        release();
        if (locks.get(lockKey) === current) locks.delete(lockKey);
      }
    },
  };
}
