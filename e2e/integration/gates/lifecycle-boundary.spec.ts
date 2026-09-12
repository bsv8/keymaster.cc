import { expect, test } from "@playwright/test";
import type {
  ChannelMessageReceivedEventData,
  ChannelRuntime,
  ProtectedOutpoint,
  ProtectedOutpointProvider,
} from "@keymaster/contracts";
import { createLifecycleScope } from "webloom-framework";
import { createScopedChannelRuntime } from "../../../packages/runtime/src/lifecycle/scopedChannelRuntime.js";
import { createProtectedOutpointRegistry } from "../../../packages/runtime/src/registries/protectedOutpointRegistry.js";
import { LIFECYCLE_BOUNDARY_GATE } from "../support/scenarioMetadata.js";

export const GATE_ID = LIFECYCLE_BOUNDARY_GATE.id;
export const GATE_METADATA = LIFECYCLE_BOUNDARY_GATE;

/**
 * 业务结果：锁定、插件停用或 owner 切换后，旧实例不能继续接收消息、重新订阅，
 * 也不能把迟到的旧资源结果发布成新的保护状态。
 *
 * 本 Gate 使用生产 lifecycle/registry 实现和最小受控 adapter；它证明撤权顺序、
 * 二次门禁和迟到结果隔离，不把 Node fake 当成真实 SharedWorker 网络证据。
 */
test(GATE_ID + "：撤权先于 drain 并隔离迟到资源结果", async () => {
  const scope = createLifecycleScope({ kind: "plugin-instance" });
  const calls: string[] = [];
  const subscriptions = new Set<(event: ChannelMessageReceivedEventData) => void>();
  const base: ChannelRuntime = {
    isReady: () => true,
    publish: async () => {
      calls.push("publish");
      return { messageId: "published" };
    },
    publishPrivate: async () => ({ messageId: "private" }),
    subscriptionSet: async (channels) => {
      calls.push(channels.length === 0 ? "unsubscribe" : "subscribe");
      return { channels };
    },
    subscribe: (handler) => {
      subscriptions.add(handler);
      return () => subscriptions.delete(handler);
    },
    subscribePrivate: () => () => undefined,
  };
  const runtime = createScopedChannelRuntime(base, scope);
  const received: string[] = [];

  await runtime.subscriptionSet(["inbox"]);
  runtime.subscribe((event) => received.push(event.messageId));
  const event = {
    channel: "inbox",
    publisherPublicKeyHex: "02".padEnd(66, "0"),
    messageId: "before-revoke",
    content: null,
  } satisfies ChannelMessageReceivedEventData;
  for (const handler of subscriptions) handler(event);
  expect(received).toEqual(["before-revoke"]);

  // revoke 是同步安全边界：先移除回调、提交空订阅，再允许异步 dispose/drain。
  scope.revoke("owner session changed");
  expect(calls).toEqual(["subscribe", "unsubscribe"]);
  expect(runtime.isReady()).toBe(false);
  for (const handler of subscriptions) handler({ ...event, messageId: "late-old-event" });
  expect(received).toEqual(["before-revoke"]);
  await expect(runtime.subscriptionSet(["new-owner-inbox"])).rejects.toThrow(/revoked/iu);
  await expect(runtime.publish({ channel: "inbox", content: null })).rejects.toThrow(/revoked|stopping/iu);
  await scope.dispose();
  expect(calls).toEqual(["subscribe", "unsubscribe"]);
});

test(GATE_ID + "：provider 注销后迟到刷新不能复活保护 outpoint", async () => {
  let resolveList: ((items: ProtectedOutpoint[]) => void) | undefined;
  const provider: ProtectedOutpointProvider = {
    id: "late-token-provider",
    ownerPluginId: "token-bsv21",
    listProtectedOutpoints: () => new Promise<ProtectedOutpoint[]>((resolve) => {
      resolveList = resolve;
    }),
  };
  const registry = createProtectedOutpointRegistry();
  registry.register(provider);
  registry.unregister(provider.id);

  resolveList?.([{
    txid: "late-txid",
    vout: 0,
    network: "test",
    ownerPluginId: "token-bsv21",
    kind: "test",
  }]);
  // 等待 detached refresh 的 Promise 完成；没有固定 sleep，条件是刷新任务本身完成。
  await Promise.resolve();
  await Promise.resolve();
  expect(registry._ids()).toEqual([]);
  expect(registry.isProtected({ txid: "late-txid", vout: 0, network: "test" })).toBe(false);
});
