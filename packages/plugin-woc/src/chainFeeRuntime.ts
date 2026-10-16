import { CHAIN_FEE_SYNC_TASK_ID, emptyChainFeeSnapshots, parseWocFeeRecommendation, resolveChainFeeSnapshot,
  type BackgroundTaskDefinition, type BsvNetwork, type ChainFeePolicies, type ChainFeeSnapshots, type WocFeeRecommendation } from "@keymaster/contracts";

export function createChainFeeRuntime(deps: { policies(): ChainFeePolicies; publish(snapshots: ChainFeeSnapshots): void }) {
  let values = emptyChainFeeSnapshots();
  const snapshot = (): ChainFeeSnapshots => {
    const policies = deps.policies();
    return structuredClone({ main: resolveChainFeeSnapshot("main", policies.main, values.main), test: resolveChainFeeSnapshot("test", policies.test, values.test) });
  };
  function changed() { deps.publish(snapshot()); }
  function task(network: () => BsvNetwork, read: (network: BsvNetwork, signal: AbortSignal) => Promise<WocFeeRecommendation>): BackgroundTaskDefinition & { unitId: string } {
    return { id: CHAIN_FEE_SYNC_TASK_ID, pluginId: "woc", unitId: "woc.coordinator-worker", label: { key: "woc.task.fees", fallback: "Network fee recommendation" },
      async run(context) {
        const selected = network();
        const attempted = Date.now();
        try {
          const recommendation = parseWocFeeRecommendation(await read(selected, context.signal));
          context.assertSessionFresh?.();
          if (context.signal.aborted) throw new Error("Fee recommendation read was aborted");
          values[selected] = { ...values[selected], recommendation, updatedAtMs: Date.now(), lastAttemptAtMs: attempted };
          delete values[selected].error;
          changed();
        } catch (error) {
          // 取消/旧实例的迟到结果不能污染当前投影；普通失败保留上次成功建议值。
          context.assertSessionFresh?.();
          if (context.signal.aborted) throw error;
          values[selected] = { ...values[selected], lastAttemptAtMs: attempted, error: error instanceof Error ? error.message.slice(0, 4096) : String(error).slice(0, 4096) };
          changed();
          throw error;
        }
      } };
  }
  return { snapshot, changed, task, reset: () => { values = emptyChainFeeSnapshots(); } };
}
