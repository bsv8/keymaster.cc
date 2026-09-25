// packages/plugin-woc/src/chainHeightReader.ts
// 页面侧链高度读取器：get / 订阅 / 退订。
//
// 设计缘由（2026-09-26）：
//   - 真正的节点读取只发生在 Coordinator 的 `chain.chain-height-sync` 后台
//     任务里（缺省 2 分钟一次，间隔可在「智能调度」里改）。页面不读节点，
//     也不自建 timer。
//   - 本 facade 只把 Coordinator 广播的 `chain.height` 主题转成
//     get / subscribe / unsubscribe，因此订阅是零成本的被动更新。
//   - 跨标签一致性由 Coordinator 单点广播保证：所有页面看到同一个高度。

import type {
  BsvNetwork,
  ChainHeightReader,
  ChainHeightSnapshot,
  CoordinatorChainHeightEvent,
} from "@keymaster/contracts";
import { emptyChainHeightSnapshot } from "@keymaster/contracts";

/** 页面侧实际使用的最小 Coordinator 面。 */
export interface ChainHeightCoordinatorClientLike {
  getChainHeightSnapshot(): ChainHeightSnapshot;
  subscribeTopic(topic: string, listener: (event: unknown) => void): () => void;
}

export interface ChainHeightReaderDeps {
  coordinatorClient: ChainHeightCoordinatorClientLike;
}

/**
 * 创建页面侧链高度读取器。
 *
 * 退订语义：`subscribe` 返回的句柄与 `unsubscribe(handler)` 等价；两者都只
 * 移除该 handler 自己的监听，不影响其它订阅者，也不会取消 Coordinator 主题
 * 订阅（主题订阅由本 facade 构造时一次性建立）。
 */
export function createChainHeightReader(deps: ChainHeightReaderDeps): ChainHeightReader {
  const { coordinatorClient } = deps;
  const handlers = new Set<(snapshot: ChainHeightSnapshot) => void>();
  let cached: ChainHeightSnapshot = readCurrent();

  function readCurrent(network?: BsvNetwork): ChainHeightSnapshot {
    const current = coordinatorClient.getChainHeightSnapshot();
    // 消费者可以问任意网络；当前只广播 mainnet。请求其它网络时不得把
    // mainnet 的读数冒充成该网络的高度。
    if (network && current.network !== network) return { ...emptyChainHeightSnapshot(network) };
    return { ...current };
  }

  function emit(): void {
    for (const handler of [...handlers]) {
      try { handler({ ...cached }); } catch { /* 单个订阅者失败不影响其它订阅者 */ }
    }
  }

  function notify(handler: (snapshot: ChainHeightSnapshot) => void): void {
    try { handler({ ...cached }); } catch { /* 单个订阅者失败不影响其它订阅者 */ }
  }

  // 主题订阅在 facade 构造时建立一次：Coordinator 会同步回放当前 baseline，
  // 因此构造完成时 cached 已经是 Coordinator 的真实读数，get() 不会返回空值。
  const unsubscribeTopic = coordinatorClient.subscribeTopic("chain.height", (event: unknown) => {
    // 只有完整合法的读数才允许进缓存：半个快照会让消费者把 provider 故障
    // 误判成「链回退了」。这里与 client / wire parser 的校验保持同一组不变量。
    const candidate = (event as CoordinatorChainHeightEvent | undefined)?.chainHeight;
    if (!candidate
      || !Number.isSafeInteger(candidate.height)
      || candidate.height < 0
      || typeof candidate.available !== "boolean"
      || (candidate.network !== "main" && candidate.network !== "test")) {
      return;
    }
    cached = { ...candidate };
    emit();
  });

  return {
    get: (network?: BsvNetwork) => readCurrent(network),
    subscribe(handler: (snapshot: ChainHeightSnapshot) => void): () => void {
      handlers.add(handler);
      notify(handler);
      return () => { handlers.delete(handler); };
    },
    unsubscribe(handler: (snapshot: ChainHeightSnapshot) => void): void {
      handlers.delete(handler);
    },
    /** 释放主题订阅；宿主 teardown 时调用。 */
    dispose: () => {
      unsubscribeTopic();
      handlers.clear();
    },
  };
}
