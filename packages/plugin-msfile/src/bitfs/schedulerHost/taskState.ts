import type { BorrowedModuleFileStore, MsFileBitfsTaskSnapshot } from "@keymaster/contracts";
import { restoreTask, view, type State, type View } from "keymaster-trade-scheduler";
import type { BitfsSessionRecord } from "../sessionJournal.js";
import { createSchedulerSnapshotStore } from "./store.js";

/** 从唯一持久快照读取任务事实，不能依赖当前进程是否还有连接或适配器。
 * taskId 是宿主购买执行编号（快照文件定位键）；内核下载对象身份只看 seedHash。 */
export async function readSchedulerTaskState(input: {
  store: BorrowedModuleFileStore; ownerPublicKeyHex: string; network: string; taskId: string;
}): Promise<State | undefined> {
  const stored = await createSchedulerSnapshotStore(input).load();
  if (!stored) return undefined;
  const state = restoreTask(stored.snapshot.state);
  if (state.seedHash !== stored.snapshot.seedHashHex) throw new Error("调度器状态与任务索引不一致");
  return state;
}

/** 不复制失败真值，只把内核已有状态投影为界面字段。 */
export function schedulerTaskFields(state: State): Pick<MsFileBitfsTaskSnapshot, "schedulerState" | "message"> {
  const current = view(state);
  const failure = current.failure;
  return {
    schedulerState: {
      execution: current.execution, content: current.content, funds: current.funds,
      inFlight: current.facts.inFlight,
      failure: failure ? { code: failure.code, required: failure.required } : null,
    },
    message: failure ? `资金申请不足：本次需求 ${failure.required} sats。已停止新增工作；已安排购买继续验货付款，费用池独立结算。` : null,
  };
}

/** 结束文件任务不等于丢弃资金责任；这里只在正常收尾已明确时结束生命周期。 */
/** 成功终结仍要求内容与资金两轴均已明确，不以任意单池 completed 代替任务完成。 */
export function schedulerSessionResponsibilitiesSettled(records: readonly (Pick<BitfsSessionRecord, "phase" | "evidence" | "pendingTxid" | "pendingAuthorizationId"> | undefined)[]): boolean {
  return records.every(record => record && !record.pendingTxid && !record.pendingAuthorizationId
    && (!record.evidence.some(name => name === "funding-transaction" || name === "kind2-opening-request")
      || ["completed", "cancelled", "refunded", "failed"].includes(record.phase)));
}

export function schedulerSuccessSettled(current: View): boolean {
  return !current.failure && current.execution === "finished" && current.content === "complete"
    && current.facts.inFlight === 0 && (current.funds === "none" || current.funds === "settled");
}

export function schedulerFailureSettled(current: View): boolean {
  return !!current.failure && current.execution === "stopped" && (current.funds === "none" || current.funds === "settled");
}
