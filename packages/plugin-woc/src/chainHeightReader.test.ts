// packages/plugin-woc/src/chainHeightReader.test.ts
// 页面侧链高度读取器契约测试：get / 订阅 / 退订。
//
// 设计缘由：读取器只是 Coordinator `chain.height` 广播的投影，所以这里验证
// 三件事——订阅立刻拿到当前值、更新会被推给所有订阅者、退订后不再收到回调。

import { describe, expect, it } from "vitest";
import { createChainHeightReader, type ChainHeightCoordinatorClientLike } from "./chainHeightReader.js";
import type { ChainHeightSnapshot } from "@keymaster/contracts";

interface FakeCoordinator {
  client: ChainHeightCoordinatorClientLike;
  publish(snapshot: ChainHeightSnapshot): void;
  publishMalformed(value: unknown): void;
  topicUnsubscribed(): boolean;
}

function createFakeCoordinator(initial: ChainHeightSnapshot): FakeCoordinator {
  let snapshot = { ...initial };
  const listeners = new Set<(event: unknown) => void>();
  let unsubscribed = false;
  return {
    client: {
      getChainHeightSnapshot: () => ({ ...snapshot }),
      subscribeTopic: (_topic, listener) => {
        if (unsubscribed) return () => undefined;
        listeners.add(listener);
        // Coordinator 订阅时同步回放 baseline；读取器构造完成即可 get。
        listener({ topic: "chain.height", type: "chain.height.changed", chainHeight: { ...snapshot } });
        return () => {
          listeners.delete(listener);
          unsubscribed = true;
        };
      }
    },
    publish: (next) => {
      snapshot = { ...next };
      for (const listener of [...listeners]) {
        listener({ topic: "chain.height", type: "chain.height.changed", chainHeight: { ...snapshot } });
      }
    },
    publishMalformed: (value) => {
      for (const listener of [...listeners]) listener(value);
    },
    topicUnsubscribed: () => unsubscribed,
  };
}

const MAIN_HEIGHT: ChainHeightSnapshot = { height: 900_000, network: "main", available: true, updatedAtMs: 1, revision: 1 };

describe("createChainHeightReader", () => {
  it("构造完成即可 get：同步回放的 baseline 已经是 Coordinator 当前读数", () => {
    const coordinator = createFakeCoordinator(MAIN_HEIGHT);
    const reader = createChainHeightReader({ coordinatorClient: coordinator.client });
    expect(reader.get()).toEqual(MAIN_HEIGHT);
  });

  it("尚未同步过时 get 返回不可用快照，而不是高度 0 的假读数", () => {
    const coordinator = createFakeCoordinator({ height: 0, network: "main", available: false, revision: 0 });
    const reader = createChainHeightReader({ coordinatorClient: coordinator.client });
    expect(reader.get().available).toBe(false);
    expect(reader.get().height).toBe(0);
  });

  it("订阅时立即回调当前值，后续每次更新都推给订阅者", () => {
    const coordinator = createFakeCoordinator(MAIN_HEIGHT);
    const reader = createChainHeightReader({ coordinatorClient: coordinator.client });
    const seen: number[] = [];
    reader.subscribe((snapshot) => { seen.push(snapshot.height); });

    coordinator.publish({ height: 900_001, network: "main", available: true, updatedAtMs: 2, revision: 2 });
    coordinator.publish({ height: 900_002, network: "main", available: true, updatedAtMs: 3, revision: 3 });

    expect(seen).toEqual([900_000, 900_001, 900_002]);
    expect(reader.get().height).toBe(900_002);
  });

  it("subscribe 返回的句柄可以退订，退订后不再收到回调", () => {
    const coordinator = createFakeCoordinator(MAIN_HEIGHT);
    const reader = createChainHeightReader({ coordinatorClient: coordinator.client });
    const seen: number[] = [];
    const off = reader.subscribe((snapshot) => { seen.push(snapshot.height); });

    coordinator.publish({ height: 900_001, network: "main", available: true, updatedAtMs: 2, revision: 2 });
    off();
    coordinator.publish({ height: 900_002, network: "main", available: true, updatedAtMs: 3, revision: 3 });

    expect(seen).toEqual([900_000, 900_001]);
  });

  it("unsubscribe 与 subscribe 句柄等价，且只影响自己的 handler", () => {
    const coordinator = createFakeCoordinator(MAIN_HEIGHT);
    const reader = createChainHeightReader({ coordinatorClient: coordinator.client });
    const kept: number[] = [];
    const dropped: number[] = [];
    const handler = (snapshot: ChainHeightSnapshot) => { dropped.push(snapshot.height); };
    reader.subscribe(handler);
    reader.subscribe((snapshot) => { kept.push(snapshot.height); });

    reader.unsubscribe(handler);
    coordinator.publish({ height: 900_001, network: "main", available: true, updatedAtMs: 2, revision: 2 });

    expect(dropped).toEqual([900_000]);
    expect(kept).toEqual([900_000, 900_001]);
  });

  it("退订不影响其它订阅者，也不释放 Coordinator 主题订阅", () => {
    const coordinator = createFakeCoordinator(MAIN_HEIGHT);
    const reader = createChainHeightReader({ coordinatorClient: coordinator.client });
    const seen: number[] = [];
    const off = reader.subscribe((snapshot) => { seen.push(snapshot.height); });

    off();
    coordinator.publish({ height: 900_001, network: "main", available: true, updatedAtMs: 2, revision: 2 });

    expect(seen).toEqual([900_000]);
    // 主题订阅由 facade 构造时建立一次；单个 handler 退订不能释放它。
    expect(coordinator.topicUnsubscribed()).toBe(false);
    expect(reader.get().height).toBe(900_001);
  });

  it("询问其它网络时不把 mainnet 读数冒充成该网络高度", () => {
    const coordinator = createFakeCoordinator(MAIN_HEIGHT);
    const reader = createChainHeightReader({ coordinatorClient: coordinator.client });
    const testnet = reader.get("test");
    expect(testnet.network).toBe("test");
    expect(testnet.available).toBe(false);
  });

  it("忽略缺少完整高度读数的事件，不污染当前缓存", () => {
    const coordinator = createFakeCoordinator(MAIN_HEIGHT);
    const reader = createChainHeightReader({ coordinatorClient: coordinator.client });
    const seen: number[] = [];
    reader.subscribe((snapshot) => { seen.push(snapshot.height); });

    coordinator.publishMalformed({ topic: "chain.height", type: "chain.height.changed" });
    coordinator.publishMalformed({ topic: "chain.height", chainHeight: { height: "900123", network: "main", available: true, revision: 1 } });
    coordinator.publishMalformed({ topic: "chain.height", chainHeight: { height: 1.5, network: "main", available: true, revision: 1 } });
    coordinator.publishMalformed({ topic: "chain.height", chainHeight: { height: -1, network: "main", available: true, revision: 1 } });
    coordinator.publishMalformed({ topic: "chain.height", chainHeight: { height: 1, network: "regtest", available: true, revision: 1 } });
    coordinator.publishMalformed({ topic: "chain.height", chainHeight: { height: 1, network: "main", revision: 1 } });
    coordinator.publishMalformed(undefined);

    expect(seen).toEqual([900_000]);
    expect(reader.get()).toEqual(MAIN_HEIGHT);
  });

  it("单个订阅者抛错不影响其它订阅者，也不影响缓存", () => {
    const coordinator = createFakeCoordinator(MAIN_HEIGHT);
    const reader = createChainHeightReader({ coordinatorClient: coordinator.client });
    const seen: number[] = [];
    reader.subscribe(() => { throw new Error("boom"); });
    reader.subscribe((snapshot) => { seen.push(snapshot.height); });

    coordinator.publish({ height: 900_001, network: "main", available: true, updatedAtMs: 2, revision: 2 });
    expect(seen).toEqual([900_000, 900_001]);
    expect(reader.get().height).toBe(900_001);
  });

  it("dispose 释放主题订阅", () => {
    const coordinator = createFakeCoordinator(MAIN_HEIGHT);
    const reader = createChainHeightReader({ coordinatorClient: coordinator.client });
    reader.dispose?.();
    expect(coordinator.topicUnsubscribed()).toBe(true);
  });
});
