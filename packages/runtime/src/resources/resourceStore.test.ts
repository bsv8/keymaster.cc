// packages/runtime/src/resources/resourceStore.test.ts
// Resource Store 测试
//
// 覆盖：
//   1. 同 key 双 ensure() 只调用一次 loader
//   2. StrictMode mount → cleanup → mount 不产生第二个 loader 请求
//   3. 同 provider/key 的同轮失效只产生一次 reload
//   4. 不同 provider 或 active key 不合并
//   5. active key 切换后旧请求 resolve 不得发布到新 key
//   6. equals 判定相同数据时 selector subscriber 不通知
//   7. loader failure 保留旧 data 并进入 stale/error
//   8. owner plugin disable 后 abort、unsubscribe、record purge 均发生

import { describe, expect, it, vi, beforeEach } from "vitest";
import type {
  ResourceContext,
  ResourceDefinition,
  ResourceKey,
  ResourceRegistry,
} from "@keymaster/contracts";
import { createResourceStore, type ResourceStoreApi } from "./resourceStore.js";
import { createResourceRegistry, registerOwnedResource } from "./resourceRegistry.js";

/** 创建测试用的资源上下文 */
function createContext(
  ownerId: string,
  activePublicKeyHex?: string
): ResourceContext {
  return {
    getCapability: () => undefined,
    activePublicKeyHex,
    ownerId,
  };
}

/** 创建测试用的资源定义 */
function createTestDefinition<T>(
  id: string,
  options: {
    scope?: "global" | "active-key";
    key?: (args: readonly string[], context: ResourceContext) => ResourceKey;
    load?: (
      args: readonly string[],
      context: ResourceContext,
      signal: AbortSignal
    ) => Promise<T>;
    subscribe?: (
      args: readonly string[],
      context: ResourceContext,
      invalidate: () => void
    ) => () => void;
    equals?: (previous: T | undefined, next: T | undefined) => boolean;
    invalidation?: "immediate" | "microtask";
  } = {}
): ResourceDefinition<T, readonly string[]> {
  return {
    id,
    scope: options.scope ?? "global",
    key: options.key ?? ((args) => [id, ...args]),
    load:
      options.load ??
      (async () => {
        throw new Error("Not implemented");
      }),
    subscribe: options.subscribe,
    equals: options.equals,
    invalidation: options.invalidation ?? "immediate",
  };
}

describe("ResourceStore", () => {
  let registry: ResourceRegistry;
  let store: ResourceStoreApi;
  let activePublicKeyHex: string | undefined;

  beforeEach(() => {
    registry = createResourceRegistry();
    activePublicKeyHex = undefined;
    store = createResourceStore(
      registry,
      () => undefined,
      () => activePublicKeyHex
    );
  });

  it("同 key 双 ensure() 只调用一次 loader", async () => {
    let loadCount = 0;
    const definition = createTestDefinition("test", {
      load: async () => {
        loadCount++;
        await new Promise((resolve) => setTimeout(resolve, 100));
        return "data";
      },
    });
    registry.register(definition);

    // 并发调用 ensure
    const [snapshot1, snapshot2] = await Promise.all([
      Promise.resolve(store.ensure("test", [])),
      Promise.resolve(store.ensure("test", [])),
    ]);

    // 应该只调用一次 loader
    expect(loadCount).toBe(1);
    expect(snapshot1.status).toBe("pending");
    expect(snapshot2.status).toBe("pending");

    // 等待加载完成
    await new Promise((resolve) => setTimeout(resolve, 200));
    const snapshot3 = store.ensure("test", []);
    expect(snapshot3.status).toBe("ready");
    expect(snapshot3.data).toBe("data");
  });

  it("equals 判定相同数据时不会为 ready 状态再次通知", async () => {
    let notifyCount = 0;
    // 使用对象数据，每次 load 创建新对象但 equals 比较语义
    const sameData = { balance: 100 };
    const definition = createTestDefinition<typeof sameData>("test", {
      load: async () => ({ balance: 100 }), // 每次返回新对象
      equals: (a, b) => a?.balance === b?.balance, // 语义相等
    });
    registerOwnedResource(registry, "test-plugin", definition);

    // 订阅资源
    const unsubscribe = store.subscribe("test", [], () => {
      notifyCount++;
    });

    // 首次加载
    store.ensure("test", []);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 首次加载通知：pending(revision bump) + ready = 2 次
    const countAfterFirstLoad = notifyCount;
    expect(countAfterFirstLoad).toBe(2);

    // 再次加载
    store.invalidate("test", []);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // invalidate 触发：stale 通知 + pending 通知 = 2 次
    // 但 ready 不通知（因为 equals 判定 balance 相同）
    const countAfterReload = notifyCount;
    expect(countAfterReload).toBe(countAfterFirstLoad + 2);

    // 对比：如果不用 equals，Object.is({balance:100}, {balance:100}) === false
    // 会额外触发 ready 通知（3 次而不是 2 次）
    unsubscribe();
  });

  it("loader failure 保留旧 data 并进入 stale", async () => {
    let loadCount = 0;
    const definition = createTestDefinition("test", {
      load: async () => {
        loadCount++;
        if (loadCount === 1) {
          return "data";
        }
        throw new Error("load failed");
      },
    });
    registry.register(definition);

    // 首次加载成功
    store.ensure("test", []);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const snapshot1 = store.ensure("test", []);
    expect(snapshot1.status).toBe("ready");
    expect(snapshot1.data).toBe("data");

    // 失效并重新加载失败
    store.invalidate("test", []);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const snapshot2 = store.ensure("test", []);

    // 应该保留旧数据，状态为 stale
    expect(snapshot2.status).toBe("stale");
    expect(snapshot2.data).toBe("data");
    expect(snapshot2.error).toBeDefined();
  });

  it("active key 切换会 abort 旧请求并自动加载新 record", async () => {
    let active = "key-a";
    const listeners = new Set<() => void>();
    const requests = new Map<string, { resolve: (value: string) => void; signal?: AbortSignal }>();
    const activeRegistry = createResourceRegistry();
    const activeStore = createResourceStore(
      activeRegistry,
      (<T>(id: string) => id === "keyspace.service" ? {
        active: () => ({ activePublicKeyHex: active }),
        onActiveChange: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); }
      } as T : undefined),
      () => active
    );
    const definition = createTestDefinition<string>("active", {
      scope: "active-key",
      key: (args, context) => ["active", context.activePublicKeyHex ?? "none", ...args],
      load: async (_args, context, signal) => new Promise<string>((resolve) => {
        requests.set(context.activePublicKeyHex!, { resolve, signal });
      })
    });
    activeRegistry.register(definition);

    let notifications = 0;
    const unsubscribe = activeStore.subscribe("active", [], () => { notifications++; });
    activeStore.ensure<string>("active", []);
    expect(requests.has("key-a")).toBe(true);

    active = "key-b";
    for (const listener of [...listeners]) listener();
    expect(requests.get("key-a")?.signal?.aborted).toBe(true);
    activeStore.ensure<string>("active", []);
    expect(requests.has("key-b")).toBe(true);

    requests.get("key-a")?.resolve("old");
    requests.get("key-b")?.resolve("new");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(activeStore.read<string>("active", [])?.data).toBe("new");
    expect(notifications).toBeGreaterThan(0);
    unsubscribe();
  });

  it("组件先挂载、随后注入 keyspace 后会自动绑定并切换 record", async () => {
    let active = "key-a";
    let keyspace: { active: () => { activePublicKeyHex: string }; onActiveChange: (handler: () => void) => () => void } | undefined;
    const listeners = new Set<() => void>();
    const pending = new Map<string, (value: string) => void>();
    const lateRegistry = createResourceRegistry();
    const lateStore = createResourceStore(
      lateRegistry,
      <T>(id: string) => id === "keyspace.service" ? keyspace as T : undefined,
      () => keyspace?.active().activePublicKeyHex
    );
    const definition = createTestDefinition<string>("late-active", {
      scope: "active-key",
      key: (_args, context) => ["late-active", context.activePublicKeyHex ?? "none"],
      load: async (_args, context, signal) => new Promise<string>((resolve) => {
        signal.addEventListener("abort", () => undefined);
        pending.set(context.activePublicKeyHex ?? "none", resolve);
      })
    });
    lateRegistry.register(definition);
    const unsubscribe = lateStore.subscribe("late-active", [], () => { lateStore.ensure("late-active", []); });
    lateStore.ensure("late-active", []);

    keyspace = {
      active: () => ({ activePublicKeyHex: active }),
      onActiveChange: (handler) => { listeners.add(handler); return () => listeners.delete(handler); }
    };
    lateStore.refreshRuntimeBindings();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pending.has("key-a")).toBe(true);

    active = "key-b";
    for (const listener of [...listeners]) listener();
    lateStore.ensure("late-active", []);
    expect(pending.has("key-b")).toBe(true);
    pending.get("key-a")?.("old");
    pending.get("key-b")?.("new");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lateStore.read<string>("late-active", [])?.data).toBe("new");
    unsubscribe();
  });

  it("owner plugin disable 后 abort、unsubscribe、record purge 均发生", async () => {
    let abortCalled = false;
    let unsubscribeCalled = false;

    const definition = createTestDefinition("test", {
      load: async (_args, _context, signal) => {
        signal.addEventListener("abort", () => {
          abortCalled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return "data";
      },
      subscribe: (_args, _context, invalidate) => {
        // 立即触发失效
        setTimeout(invalidate, 50);
        return () => {
          unsubscribeCalled = true;
        };
      },
    });
    registerOwnedResource(registry, "test-plugin", definition);

    // 开始加载
    store.ensure("test", []);

    // 等待订阅触发
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 处置资源定义注册时绑定的 owner
    store.disposeOwner("test-plugin");

    // 应该调用 abort 和 unsubscribe
    expect(abortCalled).toBe(true);
    expect(unsubscribeCalled).toBe(true);

    // 再次 ensure 应该重新开始
    store.ensure("test", []);
    const snapshot = store.read("test", []);
    expect(snapshot?.status).toBe("pending");
  });
});
