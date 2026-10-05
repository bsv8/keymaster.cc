// apps/web/src/shell/AppShell.guard.test.ts
// 单 Key 本地存储（docs/存储.md）之后的 AppShell 壳层守卫。
//
// 守卫要回答的问题只有一个：已经 unlocked 的钱包，唯一 Key 的公开身份
// 能不能读出来。
//   - normal：读得到。
//   - needs-repair：已解锁却读不到身份（状态不一致）。**不**做任何自动收敛
//     ——系统里只有一把 Key，没有「切到另一把」的退路，也不能把钱包重置回
//     uninitialized 来掩盖问题。
//   - diagnostic：读取抛错。fail closed，绝不把「读失败」当成「没有 Key」。
//
// 判定逻辑抽在 evaluateShellGuard 纯函数里，可以脱离 React runtime 单测。

import { describe, expect, it } from "vitest";
import { areShellGuardStatesEqual, evaluateShellGuard } from "./walletGuard.js";

const READY_KEY = { publicKeyHex: "02".padEnd(66, "1") };

describe("evaluateShellGuard: normal 状态", () => {
  it("vault.status 不是 unlocked 时直接 normal", async () => {
    expect(await evaluateShellGuard({
      vaultStatus: "locked",
      getCurrentKey: async () => undefined
    })).toEqual({ kind: "normal" });
  });

  it("vault.status = booting 时也直接 normal", async () => {
    expect(await evaluateShellGuard({
      vaultStatus: "booting",
      getCurrentKey: async () => undefined
    })).toEqual({ kind: "normal" });
  });

  it("已解锁且能读到唯一 Key 的身份时 normal", async () => {
    expect(await evaluateShellGuard({
      vaultStatus: "unlocked",
      getCurrentKey: async () => READY_KEY
    })).toEqual({ kind: "normal" });
  });
});

describe("evaluateShellGuard: needs-repair 状态", () => {
  it("已解锁但读不到身份时进入 needs-repair，并带上投影公钥用于诊断", async () => {
    expect(await evaluateShellGuard({
      vaultStatus: "unlocked",
      getCurrentKey: async () => undefined,
      projectedPublicKeyHex: READY_KEY.publicKeyHex
    })).toEqual({ kind: "needs-repair", publicKeyHex: READY_KEY.publicKeyHex });
  });

  it("未解锁时读不到身份也不进入 needs-repair", async () => {
    expect(await evaluateShellGuard({
      vaultStatus: "uninitialized",
      getCurrentKey: async () => undefined
    })).toEqual({ kind: "normal" });
  });

  it("读不到身份时没有「0 key 自动收敛」分支", async () => {
    // 关键不变量：needs-repair 不触发任何副作用。单 Key 钱包没有「回未初始化」
    // 这种退路——那要求重建钱包，会破坏用户本地数据。
    const state = await evaluateShellGuard({
      vaultStatus: "unlocked",
      getCurrentKey: async () => undefined
    });
    expect(state.kind).toBe("needs-repair");
  });
});

describe("evaluateShellGuard: diagnostic 状态", () => {
  it("读取抛错时 fail closed 成 diagnostic，不当成「没有 Key」", async () => {
    const state = await evaluateShellGuard({
      vaultStatus: "unlocked",
      getCurrentKey: async () => {
        throw new Error("indexedDB read failed");
      }
    });
    expect(state.kind).toBe("diagnostic");
    if (state.kind === "diagnostic") expect(state.error).toBe("indexedDB read failed");
  });

  it("抛非 Error 异常时也能正确归类为 diagnostic", async () => {
    const state = await evaluateShellGuard({
      vaultStatus: "unlocked",
      getCurrentKey: async () => {
        throw "string error";
      }
    });
    expect(state.kind).toBe("diagnostic");
    if (state.kind === "diagnostic") expect(state.error).toBe("string error");
  });
});

describe("ShellGuard 状态语义比较", () => {
  it("相同 normal 视为相等，避免重复 setState", () => {
    expect(areShellGuardStatesEqual({ kind: "normal" }, { kind: "normal" })).toBe(true);
  });

  it("相同 needs-repair 投影视为相等，不依赖对象引用", () => {
    expect(areShellGuardStatesEqual(
      { kind: "needs-repair", publicKeyHex: "02ab" },
      { kind: "needs-repair", publicKeyHex: "02ab" }
    )).toBe(true);
  });

  it("投影公钥变化时视为不相等", () => {
    expect(areShellGuardStatesEqual(
      { kind: "needs-repair", publicKeyHex: "02ab" },
      { kind: "needs-repair", publicKeyHex: "02cd" }
    )).toBe(false);
  });

  it("kind 不同时视为不相等", () => {
    expect(areShellGuardStatesEqual({ kind: "normal" }, { kind: "diagnostic", error: "x" })).toBe(false);
  });
});
