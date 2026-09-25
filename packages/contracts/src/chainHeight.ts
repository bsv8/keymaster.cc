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

/** 链高度快照；这是系统内唯一的链高度形态。 */
export interface ChainHeightSnapshot {
  /**
   * 节点报告的最佳链高度。
   * `available=false` 时为 0，调用方必须先看 available，不得直接使用 height。
   */
  height: number;
  /** 该高度所属网络。 */
  network: BsvNetwork;
  /** 是否存在可信的节点读数；false 表示还没有成功读取过。 */
  available: boolean;
  /** 最近一次成功读取的本地时间（Unix 毫秒）；available=false 时省略。 */
  updatedAtMs?: number;
  /** 窗口内单调递增版本；只有高度或可用性变化时才递增。 */
  revision: number;
}

/**
 * 链高度读取器：系统内 get / 订阅 / 退订 的唯一入口。
 *
 * 设计缘由：读取是同步的纯内存操作，订阅不会发起网络请求；真正的网络读取
 * 由后台同步任务按用户设置的间隔完成。因此消费方既能立即拿到当前值，也能在
 * 每次后台同步成功后被动收到更新，而不必各自轮询节点。
 */
export interface ChainHeightReader {
  /** 同步读取当前链高度快照；不会触发网络请求。 */
  get(network?: BsvNetwork): ChainHeightSnapshot;
  /**
   * 订阅链高度变化。
   * 返回的函数就是退订句柄：调用后该 handler 不再收到任何回调。
   */
  subscribe(handler: (snapshot: ChainHeightSnapshot) => void): () => void;
  /** 退订指定 handler；与 `subscribe` 返回的句柄等价，便于显式退订。 */
  unsubscribe(handler: (snapshot: ChainHeightSnapshot) => void): void;
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
