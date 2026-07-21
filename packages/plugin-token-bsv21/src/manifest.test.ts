// packages/plugin-token-bsv21/src/manifest.test.ts
// bsv21TokenPlugin.setup() 的行为测试：
//   - vault.unlocked 不直接触发 token-bsv21.sync（由 P2PKH resource-ready 统一驱动）
//   - active-key change 不直接触发 token-bsv21.sync
//   - p2pkh resource 事件触发 token-bsv21.sync
//   - 无 snapshot → "first-sync" reason（跳过冷却）
//   - 有 snapshot → "p2pkh.resources-ready" reason（受冷却合并）
//   - dispose 后事件不再触发

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── 模块级 mock ──────────────────────────────────────────────────
// createBsv21Db / createBsv21Service / createBsv21SyncTask / createBsv21TokenProvider
// 都在 setup() 内部调用，测试只需验证 manifest 的事件绑定逻辑，
// 不需要真实 IndexedDB 或 WOC 网络。全部 mock 掉。

// 可配置的 db.list 返回值
let mockDbListResult: unknown[] = [];

vi.mock("./bsv21Db.js", () => ({
  createBsv21Db: () => ({
    put: vi.fn(),
    replaceAll: vi.fn(),
    list: vi.fn(() => Promise.resolve(mockDbListResult)),
    close: vi.fn(),
  }),
}));

vi.mock("./bsv21Service.js", async () => {
  const actual = await vi.importActual<typeof import("./bsv21Service.js")>("./bsv21Service.js");
  return {
    ...actual,
    createBsv21Service: vi.fn(() => ({
      listActiveKeyTokens: vi.fn().mockResolvedValue([]),
      getToken: vi.fn().mockResolvedValue(null),
    })),
  };
});

vi.mock("./bsv21Sync.js", () => ({
  createBsv21SyncTask: vi.fn(() => ({
    id: "token-bsv21.sync",
    pluginId: "plugin-token-bsv21",
    label: { key: "bsv21.task.sync", fallback: "BSV-21 同步" },
    description: { key: "bsv21.task.sync.description", fallback: "" },
    schedule: { group: "asset-holdings", defaultIntervalMs: 900_000, minIntervalMs: 300_000 },
    defaultEnabled: true,
    keyScope: () => undefined,
    canRun: () => false,
    run: vi.fn(),
  })),
}));

vi.mock("./bsv21TokenProvider.js", () => ({
  createBsv21TokenProvider: vi.fn(() => ({
    id: "bsv21",
    name: { key: "bsv21.provider.name", fallback: "BSV-21" },
    order: 10,
    listTokens: vi.fn().mockResolvedValue([]),
    getToken: vi.fn().mockResolvedValue(undefined),
    listActivity: vi.fn().mockResolvedValue([]),
    onChange: vi.fn(() => () => {}),
  })),
}));

// ── 测试 ─────────────────────────────────────────────────────────

/** 构建 mock ctx 并调用 bsv21TokenPlugin.setup()。 */
async function setupManifest() {
  const triggerFn = vi.fn();
  const registerToken = vi.fn();
  const registerBackground = vi.fn();
  const onActiveChangeFn = vi.fn(() => () => {});
  const onGlobalSettingsChangeFn = vi.fn(() => () => {});

  // messageBus 需要真正存储 handler，以便测试中手动 emit
  const messageBusListeners = new Map<string, Array<(payload: unknown) => void>>();

  // assetDataNotifier 需要真正存储 handler，以便测试中手动 emit
  const dataNotifierListeners: Array<(event: { providerId: string; kinds: string[]; publicKeyHex?: string }) => void> = [];

  const ctx = {
    get: vi.fn((cap: string) => {
      switch (cap) {
        case "p2pkh.service":
          return {
            listResources: vi.fn().mockResolvedValue([]),
            getGlobalSettings: () => ({ includeTestnet: false }),
            onGlobalSettingsChange: onGlobalSettingsChangeFn,
          };
        case "woc.bsv21.service":
          return { listAddressTokens: vi.fn(), getAddressTokenBalance: vi.fn() };
        case "keyspace.service":
          return {
            active: () => ({ activePublicKeyHex: "pk1" }),
            onActiveKeyChanged: onActiveChangeFn,
            isInitializing: () => false,
            openKeyStorage: vi.fn(),
          };
        case "token.registry":
          return { register: registerToken };
        case "background.registry":
          return { register: registerBackground };
        case "runtime.messageBus":
          return {
            publish: vi.fn(),
            subscribe: vi.fn((topic: string, handler: (payload: unknown) => void) => {
              const list = messageBusListeners.get(topic) ?? [];
              list.push(handler);
              messageBusListeners.set(topic, list);
              return () => {
                const idx = list.indexOf(handler);
                if (idx >= 0) list.splice(idx, 1);
              };
            }),
          };
        case "vault.service":
          return { status: () => "unlocked" };
        case "background.service":
          return { trigger: triggerFn };
        case "asset.dataNotifier":
          return {
            emit: vi.fn(),
            subscribe: vi.fn((handler: (event: { providerId: string; kinds: string[]; publicKeyHex?: string }) => void) => {
              dataNotifierListeners.push(handler);
              return () => {
                const idx = dataNotifierListeners.indexOf(handler);
                if (idx >= 0) dataNotifierListeners.splice(idx, 1);
              };
            }),
          };
        default:
          throw new Error(`unexpected capability: ${cap}`);
      }
    }),
    has: vi.fn(() => true),
  };

  // 动态 import 避免 hoisted vi.mock 影响
  const { bsv21TokenPlugin } = await import("./manifest.js");
  const dispose = bsv21TokenPlugin.setup(ctx as never) as unknown as (() => void) | undefined;

  return { dispose, triggerFn, messageBusListeners, dataNotifierListeners, ctx };
}

// ── 用例 ──────────────────────────────────────────────────────────

describe("bsv21TokenPlugin.setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbListResult = [];
  });

  it("vault.unlocked 不直接触发 token-bsv21.sync", async () => {
    const { messageBusListeners, triggerFn } = await setupManifest();

    const handlers = messageBusListeners.get("vault.unlocked");
    expect(handlers).toBeDefined();
    handlers!.forEach((h) => h(undefined));

    // 等待微任务完成
    await vi.waitFor(() => {
      // vault.unlocked 不应触发 sync
      expect(triggerFn).not.toHaveBeenCalled();
    });
  });

  it("p2pkh resource 事件触发 token-bsv21.sync（无 snapshot → first-sync）", async () => {
    // mockDbListResult 默认为空数组 → 无 snapshot
    mockDbListResult = [];
    const { dataNotifierListeners, triggerFn } = await setupManifest();

    dataNotifierListeners.forEach((h) => h({
      providerId: "p2pkh",
      kinds: ["resource"],
      publicKeyHex: "pk1",
    }));

    await vi.waitFor(() => {
      expect(triggerFn).toHaveBeenCalledWith("token-bsv21.sync", "first-sync");
    });
  });

  it("p2pkh resource 事件触发 token-bsv21.sync（有 snapshot → p2pkh.resources-ready）", async () => {
    // 有 snapshot
    mockDbListResult = [{ origin: "tok1", network: "main", address: "addr1" }];
    const { dataNotifierListeners, triggerFn } = await setupManifest();

    dataNotifierListeners.forEach((h) => h({
      providerId: "p2pkh",
      kinds: ["resource"],
      publicKeyHex: "pk1",
    }));

    await vi.waitFor(() => {
      expect(triggerFn).toHaveBeenCalledWith("token-bsv21.sync", "p2pkh.resources-ready");
    });
  });

  it("p2pkh resource 事件不匹配 active key 时不触发", async () => {
    const { dataNotifierListeners, triggerFn } = await setupManifest();

    dataNotifierListeners.forEach((h) => h({
      providerId: "p2pkh",
      kinds: ["resource"],
      publicKeyHex: "pk_other",
    }));

    await vi.waitFor(() => {
      expect(triggerFn).not.toHaveBeenCalled();
    });
  });

  it("dispose 后事件不再触发", async () => {
    const { dispose, messageBusListeners, dataNotifierListeners, triggerFn } = await setupManifest();

    // 先 dispose，退订所有 listener
    dispose?.();

    // emit vault.unlocked
    const handlers = messageBusListeners.get("vault.unlocked");
    expect(handlers).toBeDefined();
    // 退订后 handler 列表应为空
    expect(handlers).toHaveLength(0);

    // emit p2pkh resource
    expect(dataNotifierListeners).toHaveLength(0);

    expect(triggerFn).not.toHaveBeenCalled();
  });
});
