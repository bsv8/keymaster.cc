// packages/plugin-token-stas/src/manifest.test.ts
// STAS manifest setup 测试：
//   - vault.unlocked 不直接触发 token-stas.sync（由 P2PKH resource-ready 统一驱动）
//   - active-key change 不直接触发 token-stas.sync
//   - p2pkh resource 事件触发 token-stas.sync
//   - 无 snapshot → "first-sync" reason（跳过冷却）
//   - 有 snapshot → "p2pkh.resources-ready" reason（受冷却合并）
//   - dispose 后事件不再触发

import { describe, expect, it, vi, beforeEach } from "vitest";

// --- 模块 mock ---

// 可配置的 db.list 返回值
let mockDbListResult: unknown[] = [];

vi.mock("./stasDb.js", () => ({
  createStasDb: vi.fn(() => ({
    put: vi.fn(),
    replaceAll: vi.fn(),
    list: vi.fn(() => Promise.resolve(mockDbListResult)),
    close: vi.fn(),
  })),
}));

vi.mock("./stasService.js", () => ({
  createStasService: vi.fn(() => ({
    listActiveKeyTokens: vi.fn().mockResolvedValue([]),
  })),
  P2PKH_CAPABILITY: "p2pkh.service",
}));

vi.mock("./stasSync.js", () => ({
  createStasSyncTask: vi.fn(() => ({
    id: "token-stas.sync",
    pluginId: "plugin-token-stas",
    label: { key: "stas.task.sync", fallback: "STAS 同步" },
    description: { key: "stas.task.sync.description", fallback: "" },
    schedule: { group: "asset-holdings", defaultIntervalMs: 900_000, minIntervalMs: 300_000 },
    defaultEnabled: true,
    keyScope: () => undefined,
    canRun: () => false,
    run: vi.fn(),
  })),
}));

vi.mock("./stasTokenProvider.js", () => ({
  createStasTokenProvider: vi.fn(() => ({
    id: "stas",
    name: { key: "stas.provider.name", fallback: "STAS" },
    order: 20,
    listTokens: vi.fn().mockResolvedValue([]),
    getToken: vi.fn().mockResolvedValue(undefined),
    listActivity: vi.fn().mockResolvedValue([]),
    onChange: vi.fn(() => () => {}),
  })),
}));

import { stasTokenPlugin } from "./manifest.js";

// --- messageBus mock ---
const messageBusHandlers = new Map<string, (...args: unknown[]) => void>();

const mockMessageBus = {
  subscribe: vi.fn((type: string, handler: (...args: unknown[]) => void) => {
    messageBusHandlers.set(type, handler);
    return () => {
      messageBusHandlers.delete(type);
    };
  }),
};

function emitMessageBus(type: string, payload?: unknown) {
  const handler = messageBusHandlers.get(type);
  handler?.(payload);
}

// --- assetDataNotifier mock ---
const dataNotifierListeners: Array<(event: { providerId: string; kinds: string[]; publicKeyHex?: string }) => void> = [];

const mockDataNotifier = {
  emit: vi.fn(),
  subscribe: vi.fn((handler: (event: { providerId: string; kinds: string[]; publicKeyHex?: string }) => void) => {
    dataNotifierListeners.push(handler);
    return () => {
      const idx = dataNotifierListeners.indexOf(handler);
      if (idx >= 0) dataNotifierListeners.splice(idx, 1);
    };
  }),
};

// --- 构造 mock ctx ---
function createMockCtx() {
  const trigger = vi.fn();
  const register = vi.fn();
  const tokenRegister = vi.fn();
  const onActiveChange = vi.fn().mockReturnValue(() => {});
  const onGlobalSettingsChange = vi.fn().mockReturnValue(() => {});

  const capabilities = new Map<string, unknown>([
    ["p2pkh.service", { onGlobalSettingsChange }],
    ["woc.stas.service", {}],
    ["keyspace.service", { onActiveChange, active: () => ({ activePublicKeyHex: "pk1" }), isInitializing: () => false, openKeyStorage: vi.fn() }],
    ["token.registry", { register: tokenRegister }],
    ["background.registry", { register }],
    ["runtime.messageBus", mockMessageBus],
    ["vault.service", { status: () => "unlocked" }],
    ["background.service", { trigger }],
    ["asset.dataNotifier", mockDataNotifier],
  ]);

  const ctx = {
    get: vi.fn((key: string) => capabilities.get(key)),
    has: vi.fn(() => true),
  };

  return { ctx, trigger, register };
}

// --- 测试 ---

describe("stasTokenPlugin manifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    messageBusHandlers.clear();
    dataNotifierListeners.length = 0;
    mockDbListResult = [];
  });

  it("vault.unlocked 不直接触发 token-stas.sync", async () => {
    const { ctx, trigger } = createMockCtx();
    stasTokenPlugin.setup!(ctx as never);

    emitMessageBus("vault.unlocked");

    // 等待微任务完成
    await vi.waitFor(() => {
      // vault.unlocked 不应触发 sync
      expect(trigger).not.toHaveBeenCalled();
    });
  });

  it("p2pkh resource 事件触发 token-stas.sync（无 snapshot → first-sync）", async () => {
    mockDbListResult = [];
    const { ctx, trigger } = createMockCtx();
    stasTokenPlugin.setup!(ctx as never);

    dataNotifierListeners.forEach((h) => h({
      providerId: "p2pkh",
      kinds: ["resource"],
      publicKeyHex: "pk1",
    }));

    await vi.waitFor(() => {
      expect(trigger).toHaveBeenCalledWith("token-stas.sync", "first-sync");
    });
  });

  it("p2pkh resource 事件触发 token-stas.sync（有 snapshot → p2pkh.resources-ready）", async () => {
    mockDbListResult = [{ symbol: "TOK", network: "main", address: "addr1" }];
    const { ctx, trigger } = createMockCtx();
    stasTokenPlugin.setup!(ctx as never);

    dataNotifierListeners.forEach((h) => h({
      providerId: "p2pkh",
      kinds: ["resource"],
      publicKeyHex: "pk1",
    }));

    await vi.waitFor(() => {
      expect(trigger).toHaveBeenCalledWith("token-stas.sync", "p2pkh.resources-ready");
    });
  });

  it("p2pkh resource 事件不匹配 active key 时不触发", async () => {
    const { ctx, trigger } = createMockCtx();
    stasTokenPlugin.setup!(ctx as never);

    dataNotifierListeners.forEach((h) => h({
      providerId: "p2pkh",
      kinds: ["resource"],
      publicKeyHex: "pk_other",
    }));

    await vi.waitFor(() => {
      expect(trigger).not.toHaveBeenCalled();
    });
  });

  it("dispose 后事件不再触发", () => {
    const { ctx, trigger } = createMockCtx();
    const dispose = stasTokenPlugin.setup!(ctx as never) as unknown as (() => void) | undefined;

    // 先确认 vault.unlocked 不触发（新行为）
    emitMessageBus("vault.unlocked");
    expect(trigger).toHaveBeenCalledTimes(0);

    // dispose
    dispose?.();

    // 再次 emit，trigger 仍不被调用
    emitMessageBus("vault.unlocked");
    expect(trigger).toHaveBeenCalledTimes(0);
  });
});
