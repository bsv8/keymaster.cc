// packages/plugin-token-stas/src/manifest.test.ts
// STAS manifest setup 测试：
//   1. vault.unlocked 触发 token-stas.sync
//   2. key.deleted 调用 db.deleteByPublicKey
//   3. dispose 后事件不再触发

import { describe, expect, it, vi, beforeEach } from "vitest";

// --- 模块 mock ---

vi.mock("./stasDb.js", () => ({
  createStasDb: vi.fn(),
}));

vi.mock("./stasService.js", () => ({
  createStasService: vi.fn(),
  P2PKH_CAPABILITY: "p2pkh.service",
}));

vi.mock("./stasSync.js", () => ({
  createStasSyncTask: vi.fn(),
}));

vi.mock("./stasTokenProvider.js", () => ({
  createStasTokenProvider: vi.fn(),
}));

import { createStasDb } from "./stasDb.js";
import { stasTokenPlugin } from "./manifest.js";

// --- 模块级 spy ---
let deleteByPublicKeySpy: ReturnType<typeof vi.fn>;

// --- messageBus mock ---
// 设计缘由：mock subscribe 将 handler 存入 Map，
// 并提供 emit 辅助函数模拟事件触发。
// unsubscribe 从 Map 中移除 handler，模拟真实 messageBus 行为。
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

function resetMocks() {
  messageBusHandlers.clear();
  mockMessageBus.subscribe.mockClear();
  deleteByPublicKeySpy = vi.fn().mockResolvedValue(undefined);

  vi.mocked(createStasDb).mockReturnValue({
    put: vi.fn(),
    replaceByPublicKey: vi.fn(),
    listByPublicKey: vi.fn(),
    deleteByPublicKey: deleteByPublicKeySpy,
  } as unknown as ReturnType<typeof createStasDb>);
}

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
    ["keyspace.service", { onActiveChange, active: () => ({}) }],
    ["token.registry", { register: tokenRegister }],
    ["background.registry", { register }],
    ["runtime.messageBus", mockMessageBus],
    ["vault.service", { status: () => "unlocked" }],
    ["background.service", { trigger }],
    ["asset.dataNotifier", {}],
  ]);

  const ctx = {
    get: vi.fn((key: string) => capabilities.get(key)),
    has: vi.fn((key: string) => capabilities.has(key)),
  };

  return { ctx, trigger, register };
}

// --- 测试 ---

describe("stasTokenPlugin manifest", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("vault.unlocked 触发 token-stas.sync", () => {
    const { ctx, trigger } = createMockCtx();
    stasTokenPlugin.setup!(ctx as never);

    emitMessageBus("vault.unlocked");

    expect(trigger).toHaveBeenCalledWith("token-stas.sync", "vault-unlocked");
  });

  it("key.deleted 调用 db.deleteByPublicKey", async () => {
    const { ctx } = createMockCtx();
    stasTokenPlugin.setup!(ctx as never);

    emitMessageBus("key.deleted", { publicKeyHex: "pk123" });

    // deleteByPublicKey 是异步的（void 前缀），等待 microtask
    await vi.waitFor(() => {
      expect(deleteByPublicKeySpy).toHaveBeenCalledWith("pk123");
    });
  });

  it("dispose 后事件不再触发", () => {
    const { ctx, trigger } = createMockCtx();
    const dispose = stasTokenPlugin.setup!(ctx as never) as unknown as (() => void) | undefined;

    // 先确认正常触发
    emitMessageBus("vault.unlocked");
    expect(trigger).toHaveBeenCalledTimes(1);

    // dispose 会调用 offUnlocked()，从 messageBus 中注销 handler
    dispose?.();

    // 再次 emit，trigger 不应再被调用
    emitMessageBus("vault.unlocked");
    expect(trigger).toHaveBeenCalledTimes(1);
  });
});
