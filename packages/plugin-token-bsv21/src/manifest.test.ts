// packages/plugin-token-bsv21/src/manifest.test.ts
// bsv21TokenPlugin.setup() 的行为测试：
//   - vault.unlocked 触发 token-bsv21.sync
//   - key.deleted 调用 db.deleteByPublicKey
//   - dispose 后事件不再触发

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── 模块级 mock ──────────────────────────────────────────────────
// createBsv21Db / createBsv21Service / createBsv21SyncTask / createBsv21TokenProvider
// 都在 setup() 内部调用，测试只需验证 manifest 的事件绑定逻辑，
// 不需要真实 IndexedDB 或 WOC 网络。全部 mock 掉。

const deleteByPublicKeyFn = vi.fn().mockResolvedValue(undefined);

vi.mock("./bsv21Db.js", () => ({
  createBsv21Db: () => ({
    put: vi.fn(),
    replaceByPublicKey: vi.fn(),
    listByPublicKey: vi.fn().mockResolvedValue([]),
    deleteByPublicKey: deleteByPublicKeyFn,
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
            onActiveChange: onActiveChangeFn,
            isInitializing: () => false,
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
          return { emit: vi.fn(), subscribe: vi.fn() };
        default:
          throw new Error(`unexpected capability: ${cap}`);
      }
    }),
    has: vi.fn(
      (cap: string) =>
        cap === "background.service" ||
        cap === "asset.dataNotifier" ||
        cap === "p2pkh.service"
    ),
  };

  // 动态 import 避免 hoisted vi.mock 影响
  const { bsv21TokenPlugin } = await import("./manifest.js");
  const dispose = bsv21TokenPlugin.setup(ctx as never) as unknown as (() => void) | undefined;

  return { dispose, triggerFn, deleteByPublicKeyFn, messageBusListeners, ctx };
}

// ── 用例 ──────────────────────────────────────────────────────────

describe("bsv21TokenPlugin.setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deleteByPublicKeyFn.mockClear();
  });

  it("vault.unlocked 触发 token-bsv21.sync", async () => {
    const { messageBusListeners, triggerFn } = await setupManifest();

    const handlers = messageBusListeners.get("vault.unlocked");
    expect(handlers).toBeDefined();
    handlers!.forEach((h) => h(undefined));

    expect(triggerFn).toHaveBeenCalledWith("token-bsv21.sync", "vault-unlocked");
  });

  it("key.deleted 调用 db.deleteByPublicKey", async () => {
    const { messageBusListeners, deleteByPublicKeyFn } = await setupManifest();

    const handlers = messageBusListeners.get("key.deleted");
    expect(handlers).toBeDefined();
    handlers!.forEach((h) => h({ publicKeyHex: "pk123" }));

    expect(deleteByPublicKeyFn).toHaveBeenCalledWith("pk123");
  });

  it("dispose 后事件不再触发", async () => {
    const { dispose, messageBusListeners, triggerFn } = await setupManifest();

    // 先 dispose，退订所有 listener
    dispose?.();

    // emit vault.unlocked
    const handlers = messageBusListeners.get("vault.unlocked");
    expect(handlers).toBeDefined();
    handlers!.forEach((h) => h(undefined));

    expect(triggerFn).not.toHaveBeenCalled();
  });
});
