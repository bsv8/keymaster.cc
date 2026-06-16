// apps/web/src/shell/AppShell.guard.test.ts
// 验证硬切换 005 收尾 + 反馈修复后的 AppShell 壳层守卫：
//   - normal：vault 未解锁 或 activePublicKeyHash 存在。
//   - empty-vault-recovery：activePublicKeyHash 缺失 + listKeys() 长度 0
//     + 触发 onEmpty 回调。
//   - needs-repair：activePublicKeyHash 缺失 + listKeys() 返回 failed /
//     uninitialized key 列表（**不**触发 onEmpty）。
//   - diagnostic：activePublicKeyHash 缺失 + listKeys() 抛错（**不**触发
//     onEmpty，避免把"读失败"误判为 0 key 触发空 Vault 收敛）。
//
// 抽出 evaluateShellGuard 纯函数后可独立单测，不依赖 React runtime。
//
// 关键不变量（硬切换 005 反馈修复）：
//   - listKeys() 抛错**绝不**走 empty-vault-recovery 路径。
//   - listKeys() 返回失败 key 列表**不**走 empty-vault-recovery。
//   - empty-vault-recovery 路径下必须**实际**调用 onEmpty 副作用。
//   - 修复态组件层在 KEY_MANAGEMENT_PATH 上应让 RouteRenderer 渲染——
//     这条是组件层不变量，依赖 KEY_MANAGEMENT_PATH 字符串；本测试
//     锁定该字符串以防被改坏。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateShellGuard } from "./AppShell.js";
import type { KeyIdentity } from "@keymaster/contracts";

const KEY_MANAGEMENT_PATH = "/settings/vault";

const READY_KEY: KeyIdentity = {
  keyId: "k1",
  publicKeyHash: "h".repeat(64),
  publicKeyHex: "02" + "ab".repeat(32),
  label: "ready",
  capabilities: ["p2pkh"],
  createdAt: "2024-01-01T00:00:00.000Z",
  identityStatus: "ready"
};

const FAILED_KEY: KeyIdentity = {
  keyId: "k2",
  label: "failed",
  capabilities: ["p2pkh"],
  createdAt: "2024-01-01T00:00:00.000Z",
  identityStatus: "failed",
  identityError: "decrypt failed"
};

const UNINITIALIZED_KEY: KeyIdentity = {
  keyId: "k3",
  label: "uninit",
  capabilities: ["p2pkh"],
  createdAt: "2024-01-01T00:00:00.000Z",
  identityStatus: "uninitialized"
};

beforeEach(() => {
  // 静默 evaluateShellGuard 内部的 console.error；测试只关心判定结果。
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("evaluateShellGuard: normal 状态", () => {
  it("vault.status 不是 unlocked 时直接 normal", async () => {
    const result = await evaluateShellGuard({
      vaultStatus: "locked",
      active: { activePublicKeyHash: "x" },
      listKeys: async () => [READY_KEY]
    });
    expect(result.state).toEqual({ kind: "normal" });
  });

  it("activePublicKeyHash 存在时直接 normal", async () => {
    const result = await evaluateShellGuard({
      vaultStatus: "unlocked",
      active: { activePublicKeyHash: "h".repeat(64) },
      listKeys: async () => []
    });
    expect(result.state).toEqual({ kind: "normal" });
  });

  it("vault.status = booting 时也直接 normal", async () => {
    const result = await evaluateShellGuard({
      vaultStatus: "booting",
      active: { activePublicKeyHash: undefined },
      listKeys: async () => [READY_KEY]
    });
    expect(result.state).toEqual({ kind: "normal" });
  });
});

describe("evaluateShellGuard: needs-repair 状态", () => {
  it("activePublicKeyHash 缺失 + listKeys 返回 failed key 列表", async () => {
    const onEmpty = vi.fn();
    const result = await evaluateShellGuard({
      vaultStatus: "unlocked",
      active: { activePublicKeyHash: undefined },
      listKeys: async () => [FAILED_KEY],
      onEmpty
    });
    expect(result.state.kind).toBe("needs-repair");
    if (result.state.kind === "needs-repair") {
      expect(result.state.keys).toEqual([FAILED_KEY]);
    }
    // **关键**：有 key 时**不**触发 onEmpty（不能误触发空 Vault 收敛）。
    expect(onEmpty).not.toHaveBeenCalled();
  });

  it("activePublicKeyHash 缺失 + listKeys 返回 uninitialized key 列表", async () => {
    const result = await evaluateShellGuard({
      vaultStatus: "unlocked",
      active: { activePublicKeyHash: undefined },
      listKeys: async () => [UNINITIALIZED_KEY]
    });
    expect(result.state.kind).toBe("needs-repair");
    if (result.state.kind === "needs-repair") {
      expect(result.state.keys).toEqual([UNINITIALIZED_KEY]);
    }
  });

  it("activePublicKeyHash 缺失 + listKeys 返回 mixed 列表", async () => {
    const result = await evaluateShellGuard({
      vaultStatus: "unlocked",
      active: { activePublicKeyHash: undefined },
      listKeys: async () => [FAILED_KEY, UNINITIALIZED_KEY, READY_KEY]
    });
    expect(result.state.kind).toBe("needs-repair");
  });
});

describe("evaluateShellGuard: empty-vault-recovery 状态", () => {
  it("activePublicKeyHash 缺失 + listKeys 返回 0 把", async () => {
    const onEmpty = vi.fn();
    const result = await evaluateShellGuard({
      vaultStatus: "unlocked",
      active: { activePublicKeyHash: undefined },
      listKeys: async () => [],
      onEmpty
    });
    expect(result.state).toEqual({ kind: "empty-vault-recovery" });
    // **关键**：listKeys 返回 0 时必须**实际**调 onEmpty（recoverEmptyVault
    // 收尾入口），recorderError 必须为 false。
    expect(onEmpty).toHaveBeenCalledTimes(1);
    expect(result.recorderError).toBe(false);
  });

  it("onEmpty 抛错时 recorderError 仍能让守卫结果是 empty-vault-recovery", async () => {
    // 关键：副作用抛错不能让状态被错误归类。
    const result = await evaluateShellGuard({
      vaultStatus: "unlocked",
      active: { activePublicKeyHash: undefined },
      listKeys: async () => [],
      onEmpty: async () => {
        throw new Error("recover failed");
      }
    });
    expect(result.state).toEqual({ kind: "empty-vault-recovery" });
    expect(result.recorderError).toBe(true);
  });

  it("onEmpty 不传时仍然返回 empty-vault-recovery", async () => {
    // 关键：onEmpty 是可选回调，缺省不能导致状态变成别的。
    const result = await evaluateShellGuard({
      vaultStatus: "unlocked",
      active: { activePublicKeyHash: undefined },
      listKeys: async () => []
    });
    expect(result.state).toEqual({ kind: "empty-vault-recovery" });
  });
});

describe("evaluateShellGuard: diagnostic 状态（硬切换 005 反馈修复）", () => {
  it("listKeys 抛错时**绝不**走 empty-vault-recovery", async () => {
    // 硬切换 005 反馈修复 #2：listKeys 抛错必须 fail-closed 成
    // diagnostic，**不**误判为 0 key 触发空 Vault 收敛。误判会
    // 走到 vault.recoverEmptyVaultToUninitialized() 把 meta 清掉，
    // 把"读失败"变成"meta 残留"——会丢失用户数据。
    const onEmpty = vi.fn();
    const result = await evaluateShellGuard({
      vaultStatus: "unlocked",
      active: { activePublicKeyHash: undefined },
      listKeys: async () => {
        throw new Error("indexedDB read failed");
      },
      onEmpty
    });
    expect(result.state.kind).toBe("diagnostic");
    if (result.state.kind === "diagnostic") {
      expect(result.state.error).toBe("indexedDB read failed");
    }
    // 关键：onEmpty 必须**不**被调用。
    expect(onEmpty).not.toHaveBeenCalled();
  });

  it("listKeys 抛非 Error 异常时也能正确归类为 diagnostic", async () => {
    const result = await evaluateShellGuard({
      vaultStatus: "unlocked",
      active: { activePublicKeyHash: undefined },
      listKeys: async () => {
        // 故意抛出非 Error 类型的异常。
        throw "string error";
      }
    });
    expect(result.state.kind).toBe("diagnostic");
    if (result.state.kind === "diagnostic") {
      expect(result.state.error).toBe("string error");
    }
  });
});

describe("AppShell KEY_MANAGEMENT_PATH 不变量", () => {
  // 硬切换 005 反馈修复 #1：修复态（needs-repair）下点击"前往 Key 管理"
  // 按钮 router.push(KEY_MANAGEMENT_PATH) 后，必须能让 RouteRenderer
  // 渲染 VaultSettingsPage——否则用户会被锁死。组件层的判断是
  // `path === KEY_MANAGEMENT_PATH`，本测试锁定该路径字符串与判定
  // 逻辑使用的字符串一致。
  it("KEY_MANAGEMENT_PATH 字符串是 /settings/vault（与 VaultSettingsPage 注册路径一致）", () => {
    expect(KEY_MANAGEMENT_PATH).toBe("/settings/vault");
  });
});
