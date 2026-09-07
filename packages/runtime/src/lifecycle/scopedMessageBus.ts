// 把共享 MessageBus 绑定到一个插件实例作用域。
//
// MessageBus 本身不拥有插件生命周期；这个 facade 负责把 subscribe/handle
// 的取消句柄登记到 scope，并把请求 signal 与 scope.signal 合并。这样锁屏、
// 切 Key、禁用插件时，迟到的请求只能收到取消，不能继续使用旧实例。

import type {
  DispatchOptions,
  HandlerOptions,
  Message,
  MessageBus,
  MessageHandler,
  PublishOptions,
  RequestOptions,
} from "@keymaster/contracts";
import { LifecycleScopeRevokedError } from "@keymaster/contracts";
import type { LifecycleScope } from "@keymaster/contracts";

interface MergedSignal {
  signal: AbortSignal;
  dispose(): void;
}

function mergeSignals(scopeSignal: AbortSignal, requestSignal?: AbortSignal): MergedSignal {
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
  const abortFrom = (source: AbortSignal) => {
    try {
      controller.abort(source.reason);
    } catch {
      controller.abort();
    }
  };
  const onScopeAbort = () => abortFrom(scopeSignal);
  const onRequestAbort = () => abortFrom(requestSignal);
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

function withScopeCleanup(scope: LifecycleScope, cleanup: () => void): () => void {
  let active = true;
  let removeRevoke: () => void = () => {};
  let removeDispose: () => void = () => {};
  const runCleanup = () => {
    if (!active) return;
    active = false;
    removeRevoke();
    removeDispose();
    cleanup();
  };
  // revoke 是同步安全边界。不能等异步 dispose，否则旧实例在 stopping
  // 窗口内仍能收到 publish / request 的入口调用。
  removeRevoke = scope.onRevoke(runCleanup);
  removeDispose = scope.onDispose(runCleanup, "message-bus-registration");
  return () => {
    if (!active) return;
    active = false;
    removeRevoke();
    removeDispose();
    cleanup();
  };
}

/** 创建绑定到指定插件实例的 MessageBus 视图。 */
export function createScopedMessageBus(base: MessageBus, scope: LifecycleScope): MessageBus {
  return {
    publish<TPayload>(type: string, payload: TPayload, options?: PublishOptions): string {
      scope.assertActive();
      return base.publish(type, payload, options);
    },

    subscribe<TPayload>(type: string, handler: (payload: TPayload) => void): () => void {
      scope.assertActive();
      const unsubscribe = base.subscribe<TPayload>(type, (payload) => {
        // base bus 可能已经取出一批 subscriber，撤权与 publish 可以在
        // 同一轮同步调用中交错；这里再做一次同步门禁，避免旧回调执行。
        if (scope.state !== "active") return;
        handler(payload);
      });
      return withScopeCleanup(scope, unsubscribe);
    },

    dispatch<TPayload>(type: string, payload: TPayload, options: DispatchOptions): string {
      scope.assertActive();
      const merged = mergeSignals(scope.signal, options.signal);
      const cleanup = withScopeCleanup(scope, merged.dispose);
      try {
        return base.dispatch(type, payload, {
          ...options,
          signal: merged.signal,
          onSettled: () => {
            cleanup();
            options.onSettled?.();
          },
        });
      } catch (error) {
        cleanup();
        throw error;
      }
    },

    request<TPayload, TResult>(type: string, payload: TPayload, options: RequestOptions): Promise<TResult> {
      scope.assertActive();
      const merged = mergeSignals(scope.signal, options.signal);
      // request 有完成边界，正常完成时可以提前移除外部 signal 监听；
      // scope dispose 仍会负责尚未完成的请求。
      const cleanup = withScopeCleanup(scope, merged.dispose);
      let request: Promise<TResult>;
      try {
        request = base.request<TPayload, TResult>(type, payload, {
          ...options,
          signal: merged.signal,
          onSettled: () => {
            cleanup();
            options.onSettled?.();
          },
        });
      } catch (error) {
        cleanup();
        return Promise.reject(error);
      }
      return request.finally(cleanup);
    },

    handle<TPayload, TResult>(
      type: string,
      handler: MessageHandler<TPayload, TResult>,
      options?: HandlerOptions
    ): () => void {
      scope.assertActive();
      const scopedHandler: MessageHandler<TPayload, TResult> = (message: Message<TPayload>) => {
        if (scope.state !== "active") {
          throw new LifecycleScopeRevokedError(
            `Lifecycle scope "${scope.identity.scopeId}" is ${scope.state}`
          );
        }
        const merged = mergeSignals(scope.signal, message.signal);
        try {
          const result = handler({ ...message, signal: merged.signal });
          if (result && typeof (result as PromiseLike<TResult>).then === "function") {
            return Promise.resolve(result).finally(merged.dispose) as Promise<TResult>;
          }
          merged.dispose();
          return result;
        } catch (error) {
          merged.dispose();
          throw error;
        }
      };
      const unregister = base.handle(type, scopedHandler, options);
      return withScopeCleanup(scope, unregister);
    },

    snapshot() {
      return base.snapshot();
    },

    onSnapshot(handler) {
      scope.assertActive();
      const unsubscribe = base.onSnapshot(handler);
      return withScopeCleanup(scope, unsubscribe);
    },
  };
}
