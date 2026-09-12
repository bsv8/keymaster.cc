// 把 Channel runtime 绑定到一个插件实例作用域。
//
// Channel 的物理连接由 Coordinator 统一拥有；这里只负责实例级的两件事：
//   1. 作用域撤权后立即拒绝新的 publish / subscribe 调用，并阻止迟到事件
//      进入旧插件回调；
//   2. 作用域撤权时立即提交一次空订阅，释放当前 caller 的逻辑订阅。
//
// 空订阅清理故意不携带已经 abort 的 scope.signal。取消旧的“设置订阅”请求
// 不等于释放 caller；释放请求必须继续送到 Coordinator，物理退订是否完成仍
// 由 Coordinator 的 ChannelSubscriptionMux 和最终 I/O lease 决定。

import type {
  ChannelHashRequestPublishParams,
  ChannelMessageReceivedEventData,
  ChannelPrivateMessageEvent,
  ChannelPublishParams,
  ChannelPublishResult,
  ChannelRuntime,
  ChannelSubscriptionSetResult,
} from "@keymaster/contracts";
import type { LifecycleScope } from "webloom-framework";
import { LifecycleScopeRevokedError } from "webloom-framework";

interface LinkedSignal {
  signal: AbortSignal;
  dispose(): void;
}

function linkSignals(scopeSignal: AbortSignal, requestSignal?: AbortSignal): LinkedSignal {
  if (!requestSignal) return { signal: scopeSignal, dispose: () => undefined };
  if (scopeSignal.aborted) {
    const controller = new AbortController();
    controller.abort(scopeSignal.reason);
    return { signal: controller.signal, dispose: () => undefined };
  }
  if (requestSignal.aborted) {
    const controller = new AbortController();
    controller.abort(requestSignal.reason);
    return { signal: controller.signal, dispose: () => undefined };
  }
  const controller = new AbortController();
  const abortFrom = (source: AbortSignal): void => {
    try {
      controller.abort(source.reason);
    } catch {
      controller.abort();
    }
  };
  const onScopeAbort = (): void => abortFrom(scopeSignal);
  const onRequestAbort = (): void => abortFrom(requestSignal);
  scopeSignal.addEventListener("abort", onScopeAbort, { once: true });
  requestSignal.addEventListener("abort", onRequestAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      scopeSignal.removeEventListener("abort", onScopeAbort);
      requestSignal.removeEventListener("abort", onRequestAbort);
    },
  };
}

function registerCallback(
  scope: LifecycleScope,
  cleanup: () => void,
  resourceId: string,
): () => void {
  let active = true;
  let removeRevoke: () => void = () => undefined;
  let removeDispose: () => void = () => undefined;
  const runCleanup = (): void => {
    if (!active) return;
    active = false;
    removeRevoke();
    removeDispose();
    cleanup();
  };
  removeRevoke = scope.onRevoke(runCleanup);
  removeDispose = scope.onDispose(runCleanup, resourceId);
  return runCleanup;
}

/** 创建绑定一个插件实例的 Channel 视图；不改变 Coordinator 的物理连接。 */
export function createScopedChannelRuntime(base: ChannelRuntime, scope: LifecycleScope): ChannelRuntime {
  let subscriptionUsed = false;
  let subscriptionRelease: Promise<void> | undefined;

  const releaseSubscription = (): Promise<void> => {
    if (!subscriptionUsed) return Promise.resolve();
    if (subscriptionRelease) return subscriptionRelease;
    // 直接调用而不是放进 Promise.then：scope.revoke() 后页面可能马上关闭
    // MessagePort，必须在同一个同步调用栈内把“释放 caller”消息 post 出去。
    try {
      subscriptionRelease = Promise.resolve(base.subscriptionSet([])).then(() => undefined);
    } catch (error) {
      subscriptionRelease = Promise.reject(error);
    }
    // revoke() 不等待异步结果；接住迟到失败，让 scope.dispose() 或调用方
    // 继续观察同一个 Promise，而不是制造 unhandled rejection。
    subscriptionRelease.catch(() => undefined);
    return subscriptionRelease;
  };

  // revoke 是同步权限边界，必须在 scope.dispose() 之前释放逻辑 caller。
  const removeScopeRevoke = scope.onRevoke(() => {
    void releaseSubscription().catch(() => undefined);
  });
  scope.onDispose(async () => {
    removeScopeRevoke();
    await releaseSubscription();
  }, `channel-runtime:${scope.identity.instanceId}`);

  const call = async <T>(
    requestSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    scope.assertActive();
    const linked = linkSignals(scope.signal, requestSignal);
    try {
      return await operation(linked.signal);
    } finally {
      linked.dispose();
    }
  };

  const runtime: ChannelRuntime = {
    isReady: (): boolean => {
      if (scope.state !== "active") return false;
      try {
        return base.isReady();
      } catch {
        return false;
      }
    },

    publish: (input: ChannelPublishParams, signal?: AbortSignal): Promise<ChannelPublishResult> =>
      call(signal, (linkedSignal) => base.publish(input, linkedSignal)),

    publishPrivate: (
      input: { recipientPublicKeyHex: string; protocol: string; content: import("@keymaster/contracts").JSONValue },
      signal?: AbortSignal,
    ): Promise<ChannelPublishResult> => call(signal, (linkedSignal) => base.publishPrivate(input, linkedSignal)),

    subscriptionSet: async (channels: string[], signal?: AbortSignal): Promise<ChannelSubscriptionSetResult> => {
      // 旧 service 的 teardown 可能在 scope 已撤权后才调用；只允许它提交
      // 空集合，不能借这个兼容路径重新订阅或发布。
      if (scope.state !== "active") {
        if (channels.length !== 0) throw new LifecycleScopeRevokedError();
        await releaseSubscription();
        return { channels: [] };
      }
      if (channels.length === 0) {
        // 释放是生命周期清理，不允许调用方的 signal 把它截断；否则页面
        // 可能在本地认为已释放，而 Coordinator 仍保留旧 caller。
        await releaseSubscription();
        return { channels: [] };
      }
      subscriptionUsed = true;
      return call(signal, (linkedSignal) => base.subscriptionSet(channels, linkedSignal));
    },

    subscribe: (handler: (event: ChannelMessageReceivedEventData) => void): (() => void) => {
      scope.assertActive();
      let active = true;
      const unsubscribe = base.subscribe((event) => {
        // base bus 可能已经取出一批回调；撤权与事件分发交错时仍要二次门禁。
        if (!active || scope.state !== "active") return;
        handler(event);
      });
      const cleanup = registerCallback(scope, () => {
        try { unsubscribe(); } finally { active = false; }
      }, `channel-subscription:${scope.identity.instanceId}`);
      return cleanup;
    },

    subscribePrivate: (handler: (event: ChannelPrivateMessageEvent) => void): (() => void) => {
      scope.assertActive();
      let active = true;
      const unsubscribe = base.subscribePrivate((event) => {
        if (!active || scope.state !== "active") return;
        handler(event);
      });
      const cleanup = registerCallback(scope, () => {
        try { unsubscribe(); } finally { active = false; }
      }, `channel-private-subscription:${scope.identity.instanceId}`);
      return cleanup;
    },
  };

  if (base.publishHashRequest) {
    runtime.publishHashRequest = (
      input: ChannelHashRequestPublishParams,
      signal?: AbortSignal,
    ): Promise<ChannelPublishResult> => call(signal, (linkedSignal) => base.publishHashRequest!(input, linkedSignal));
  }
  return runtime;
}
