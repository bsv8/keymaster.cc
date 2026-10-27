// 文件采购生命周期真值。一个 Owner 的同 Seed 只有一个 active 指针；
// 多卖家会话只是任务成员，资金回收与内容存在性均不改变该唯一约束。
import type { BorrowedModuleFileStore } from "@keymaster/contracts";

export interface BitfsPurchaseTask {
  taskId: string;
  demandId: string;
  state: "active" | "ended";
  endReason?: "completed" | "cancelled" | "failed" | "replaced";
  createdAt: string;
  endedAt?: string;
  sessionIds: string[];
  /** 一次性接管旧记录时保留原计划路径，后续新任务使用独立计划。 */
  legacyPlan?: boolean;
}
interface TaskIndex { version: 1; seedHashHex: string; revision: number; tasks: BitfsPurchaseTask[] }
const locks = new Map<string, Promise<void>>();

export function createBitfsPurchaseTasks(store: BorrowedModuleFileStore, owner: string, seed: string) {
  if (!/^[0-9a-f]{66}$/.test(owner) || !/^[0-9a-f]{64}$/.test(seed)) throw new Error("采购任务身份无效");
  const path = `purchase-tasks/${seed}.json`;
  const key = `${owner}:${seed}`;
  const read = async () => {
    const object = await store.get(path);
    if (!object) return undefined;
    const row = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(object.bytes)) as TaskIndex;
    if (row.version !== 1 || row.seedHashHex !== seed || !Number.isSafeInteger(row.revision) || !Array.isArray(row.tasks)
      || row.tasks.filter(t => t.state === "active").length > 1 || new Set(row.tasks.map(t => t.taskId)).size !== row.tasks.length) throw new Error("采购任务索引损坏");
    for (const task of row.tasks) {
      if (!/^[0-9a-z][0-9a-z._-]{0,127}$/.test(task.taskId) || !["active", "ended"].includes(task.state)
        || !Array.isArray(task.sessionIds) || typeof task.demandId !== "string"
        || !Number.isFinite(Date.parse(task.createdAt)) || (task.state === "ended" && (!task.endReason || !task.endedAt))) throw new Error("采购任务字段无效");
    }
    if (new Set(row.tasks.flatMap(t => t.sessionIds)).size !== row.tasks.reduce((n,t) => n+t.sessionIds.length,0)) throw new Error("卖家会话重复归属采购任务");
    return { row, revision: object.revision };
  };
  const mutate = async <T>(change: (row: TaskIndex) => T): Promise<T> => {
    const previous = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>(resolve => { release = resolve; });
    locks.set(key, tail);
    await previous;
    try {
      for (let attempt=0; attempt<8; attempt++) {
        const stored = await read();
        const row = structuredClone(stored?.row ?? { version: 1 as const, seedHashHex: seed, revision: 0, tasks: [] });
        const result = change(row);
        if (row.tasks.filter(t => t.state === "active").length > 1) throw new Error("同 Hash 只能有一个进行中任务");
        row.revision++;
        try { await store.put(path, new TextEncoder().encode(JSON.stringify(row)), stored ? { ifRevision: stored.revision } : { ifNoneMatch: true }); }
        catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "storage_conflict") continue;
          throw error;
        }
        return result;
      }
      throw new Error("采购任务并发修改冲突");
    } finally { release(); if (locks.get(key) === tail) locks.delete(key); }
  };
  return {
    async exists() { return Boolean(await read()); },
    async list() { return (await read())?.row.tasks ?? []; },
    /** 旧记录只在索引不存在时迁入；之后不再从 phase 推断生命周期。 */
    async initialize(tasks: BitfsPurchaseTask[]) { await mutate(row => { if (row.revision === 0) row.tasks = structuredClone(tasks); }); },
    async begin(taskId: string, demandId: string, now: number) {
      return mutate(row => {
        const active = row.tasks.find(t => t.state === "active");
        if (active) {
          if (active.taskId !== taskId && active.demandId !== demandId) throw new Error("同 Hash 已有进行中任务，请前往购买详情管理该任务");
          return active;
        }
        if (row.tasks.some(t => t.taskId === taskId)) throw new Error("已结束任务不能重新激活；请使用新报价");
        const task: BitfsPurchaseTask = { taskId, demandId, state: "active", createdAt: new Date(now).toISOString(), sessionIds: [] };
        row.tasks.push(task); return task;
      });
    },
    async attach(taskId: string, sessionId: string) { await mutate(row => {
      const task = row.tasks.find(t => t.taskId === taskId);
      if (!task || task.state !== "active") throw new Error("采购任务已结束，禁止新增卖家池");
      if (row.tasks.some(t => t.taskId !== taskId && t.sessionIds.includes(sessionId))) throw new Error("卖家会话已有采购归属");
      if (!task.sessionIds.includes(sessionId)) task.sessionIds.push(sessionId);
    }); },
    /** 删除历史后只留未结资金所需的成员关系；空索引保留迁移完成标记。 */
    async forgetSessions(ids: readonly string[]) { await mutate(row => {
      const forgotten = new Set(ids);
      row.tasks = row.tasks.map(task => ({ ...task, sessionIds: task.sessionIds.filter(id => !forgotten.has(id)) })).filter(task => task.sessionIds.length > 0);
    }); },
    /** 准入失败保留独立的已结束尝试；不接管或改变已有 active 任务。 */
    async recordFailedAttempt(sessionId: string, demandId: string, now: number) { await mutate(row => {
      if (row.tasks.some(t => t.sessionIds.includes(sessionId))) return;
      const reserved = row.tasks.find(t => t.taskId === sessionId);
      if (reserved) { reserved.sessionIds.push(sessionId); reserved.state = "ended"; reserved.endReason = "failed"; reserved.endedAt = new Date(now).toISOString(); return; }
      row.tasks.push({ taskId: sessionId, demandId, state: "ended", endReason: "failed", createdAt: new Date(now).toISOString(), endedAt: new Date(now).toISOString(), sessionIds: [sessionId] });
    }); },
    async end(taskId: string, reason: NonNullable<BitfsPurchaseTask["endReason"]>, now: number) { await mutate(row => {
      const task = row.tasks.find(t => t.taskId === taskId);
      if (!task) throw new Error("采购任务不存在");
      if (task.state === "ended") return;
      task.state = "ended"; task.endReason = reason; task.endedAt = new Date(now).toISOString();
    }); },
  };
}
