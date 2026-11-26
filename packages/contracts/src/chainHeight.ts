// packages/contracts/src/chainHeight.ts
// 区块链高度读取契约。
//
// 设计缘由（2026-09-26）：
//   - 链高度是全系统共享的公共链状态，不属于任何 key，也不落盘。
//   - 真值只来自节点（WoC `/chain/info`），不得由本地时钟或已确认交易
//     高度推算；因此本契约只暴露「已经读到的值」和它的来源时间。
//   - 刷新由后台任务 `chain.chain-height-sync` 按同步管理的间隔驱动；
//     本契约不负责定时，业务插件也不能在这里新建 timer。

import { defineCapability } from "webloom-framework";
import type { BsvNetwork } from "./vault.js";

/** 节点在同一次响应中报告的最佳链高度和区块哈希。 */
export interface ChainTip {
  height: number;
  blockHash: string;
}

/** 调用方先检查 available，再使用链尖数据。 */
export type ChainHeightSnapshot = {
  /** 该高度所属网络。 */
  network: BsvNetwork;
  /** 此快照所对应的成功读取时间（Unix 毫秒）；available=false 时省略。 */
  updatedAtMs?: number;
  /** 链尖或可用性变化时递增。 */
  revision: number;
} & ({ available: true } & ChainTip | { available: false; height: 0; blockHash?: never });

/**
 * 链高度读取器：系统内 get / 订阅 / 退订 的唯一入口。
 *
 * 设计缘由：读取是同步的纯内存操作，订阅不会发起网络请求；真正的网络读取
 * 由后台同步任务按用户设置的间隔完成。因此消费方既能立即拿到当前值，也能在
 * 链尖或可用性变化时被动收到更新。
 */
export interface ChainHeightReader {
  /** 同步读取当前链高度快照；不会触发网络请求。 */
  get(): ChainHeightSnapshot;
  /**
   * 立即收到当前快照，随后在高度、区块哈希或可用性变化时收到新快照。
   * 返回的函数就是退订句柄：调用后该 handler 不再收到任何回调。
   */
  subscribe(handler: (snapshot: ChainHeightSnapshot) => void): () => void;
  /** 宿主 teardown 时释放底层主题订阅；必须幂等。 */
  dispose?(): void;
}

/** 尚无任何可信节点读数时使用的空快照。 */
export function emptyChainHeightSnapshot(network: BsvNetwork = "main"): ChainHeightSnapshot {
  return { height: 0, network, available: false, revision: 0 };
}

/** 链高度读取 capability。 */
export const CHAIN_HEIGHT_READER_CAPABILITY = defineCapability<ChainHeightReader>({
  kind: "local",
  id: "chain-height.reader",
  version: "1",
});

/** 链高度资源 id；页面用 Resource Store 订阅跨标签的链高度更新。 */
export const CHAIN_HEIGHT_RESOURCE_ID = "chain.height";
