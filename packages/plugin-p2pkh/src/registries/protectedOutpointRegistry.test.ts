// 受保护 outpoint registry 回归测试。

import { describe, expect, it, vi } from "vitest";
import type { ProtectedOutpoint, ProtectedOutpointProvider } from "@keymaster/contracts";
import { createProtectedOutpointRegistry } from "./protectedOutpointRegistry.js";

function provider(
  id: string,
  ownerPluginId: string,
  outpoint: { txid: string; vout: number; network: "main" | "test" }
): ProtectedOutpointProvider {
  return {
    id,
    ownerPluginId,
    listProtectedOutpoints: () => [{
      ...outpoint,
      ownerPluginId,
      kind: "test",
    }]
  };
}

function mutableProvider(
  id: string,
  ownerPluginId: string,
  initial: Array<{ txid: string; vout: number; network: "main" | "test" }>
): ProtectedOutpointProvider & { setItems(items: Array<{ txid: string; vout: number; network: "main" | "test" }>): void; emitChange(): void } {
  let items = [...initial];
  let onChangeHandler: (() => void) | undefined;
  return {
    id,
    ownerPluginId,
    listProtectedOutpoints: () => items.map((item) => ({
      ...item,
      ownerPluginId,
      kind: "test"
    })),
    onChange(handler) {
      onChangeHandler = handler;
      return () => {
        if (onChangeHandler === handler) onChangeHandler = undefined;
      };
    },
    setItems(next) {
      items = [...next];
    },
    emitChange() {
      onChangeHandler?.();
    }
  };
}

describe("createProtectedOutpointRegistry", () => {
  it("registers providers and reports protected outpoints", async () => {
    const registry = createProtectedOutpointRegistry();
    registry.register(provider("a", "token-bsv21", { txid: "tx1", vout: 0, network: "main" }));
    await Promise.resolve();

    expect(registry._ids()).toEqual(["a"]);
    expect(registry.list()).toEqual([{
      txid: "tx1",
      vout: 0,
      network: "main",
      ownerPluginId: "token-bsv21",
      kind: "test"
    }]);
    expect(registry.isProtected({ txid: "tx1", vout: 0, network: "main" })).toBe(true);
  });

  it("claims only the matching owner plugin protected inputs", async () => {
    const registry = createProtectedOutpointRegistry();
    registry.register(provider("a", "token-bsv21", { txid: "tx1", vout: 0, network: "main" }));
    await Promise.resolve();

    const claimed = await registry.claimProtectedInputs({
      ownerPluginId: "token-bsv21",
      network: "main",
      inputs: [{ txid: "tx1", vout: 0 }]
    });
    expect(claimed.claimIds).toHaveLength(1);

    await expect(registry.claimProtectedInputs({
      ownerPluginId: "collectible-1satordinals",
      network: "main",
      inputs: [{ txid: "tx1", vout: 0 }]
    })).rejects.toThrow(/belongs to token-bsv21/);
  });

  it("unregister removes only the specified provider", async () => {
    const registry = createProtectedOutpointRegistry();
    registry.register(provider("a", "token-bsv21", { txid: "tx1", vout: 0, network: "main" }));
    registry.register(provider("b", "collectible-1satordinals", { txid: "tx2", vout: 1, network: "test" }));
    await Promise.resolve();

    registry.unregister("a");
    await Promise.resolve();

    expect(registry._ids()).toEqual(["b"]);
    expect(registry.isProtected({ txid: "tx1", vout: 0, network: "main" })).toBe(false);
    expect(registry.isProtected({ txid: "tx2", vout: 1, network: "test" })).toBe(true);
  });

  it("filters by network and public key when listing", async () => {
    const registry = createProtectedOutpointRegistry();
    registry.register({
      id: "a",
      ownerPluginId: "token-bsv21",
      listProtectedOutpoints: () => [
        { txid: "tx1", vout: 0, network: "main", ownerPluginId: "token-bsv21", publicKeyHex: "pk1" },
        { txid: "tx2", vout: 1, network: "test", ownerPluginId: "token-bsv21", publicKeyHex: "pk2" }
      ]
    });
    await Promise.resolve();

    expect(registry.list({ network: "main" })).toHaveLength(1);
    expect(registry.list({ publicKeyHex: "pk2" })).toHaveLength(1);
  });

  it("drops stale claims when a provider refresh removes the protected outpoint", async () => {
    const registry = createProtectedOutpointRegistry();
    const p = mutableProvider("a", "token-bsv21", [{ txid: "tx1", vout: 0, network: "main" }]);
    registry.register(p);
    await Promise.resolve();

    await registry.claimProtectedInputs({
      ownerPluginId: "token-bsv21",
      network: "main",
      inputs: [{ txid: "tx1", vout: 0 }]
    });
    expect(registry.isProtected({ txid: "tx1", vout: 0, network: "main" })).toBe(true);

    p.setItems([]);
    p.emitChange();
    await Promise.resolve();

    expect(registry.isProtected({ txid: "tx1", vout: 0, network: "main" })).toBe(false);
    await expect(registry.claimProtectedInputs({
      ownerPluginId: "token-bsv21",
      network: "main",
      inputs: [{ txid: "tx1", vout: 0 }]
    })).resolves.toEqual({ claimIds: [] });
  });

  it("clears stale claims when unregister removes the provider", async () => {
    const registry = createProtectedOutpointRegistry();
    registry.register(provider("a", "token-bsv21", { txid: "tx2", vout: 1, network: "main" }));
    await Promise.resolve();

    await registry.claimProtectedInputs({
      ownerPluginId: "token-bsv21",
      network: "main",
      inputs: [{ txid: "tx2", vout: 1 }]
    });
    expect(registry.isProtected({ txid: "tx2", vout: 1, network: "main" })).toBe(true);

    registry.unregister("a");

    expect(registry.isProtected({ txid: "tx2", vout: 1, network: "main" })).toBe(false);
    await expect(registry.claimProtectedInputs({
      ownerPluginId: "token-bsv21",
      network: "main",
      inputs: [{ txid: "tx2", vout: 1 }]
    })).resolves.toEqual({ claimIds: [] });
  });

  it("notifies listeners when stale claims are pruned", async () => {
    const registry = createProtectedOutpointRegistry();
    const change = vi.fn();
    registry.onChange(change);
    const p = mutableProvider("a", "token-bsv21", [{ txid: "tx3", vout: 0, network: "main" }]);
    registry.register(p);
    await Promise.resolve();

    expect(change).toHaveBeenCalledTimes(1);

    await registry.claimProtectedInputs({
      ownerPluginId: "token-bsv21",
      network: "main",
      inputs: [{ txid: "tx3", vout: 0 }]
    });
    expect(change).toHaveBeenCalledTimes(2);

    p.setItems([]);
    p.emitChange();
    await Promise.resolve();

    expect(change).toHaveBeenCalledTimes(3);
  });

  it("does not publish a late refresh after a provider is unregistered", async () => {
    let resolveList!: (items: ProtectedOutpoint[]) => void;
    const pending = new Promise<ProtectedOutpoint[]>((resolve) => {
      resolveList = resolve;
    });
    const registry = createProtectedOutpointRegistry();
    registry.register({
      id: "pending",
      ownerPluginId: "token-bsv21",
      listProtectedOutpoints: () => pending,
    });

    registry.unregister("pending");
    resolveList([{
      txid: "late",
      vout: 0,
      network: "main",
      ownerPluginId: "token-bsv21",
      kind: "test",
    }]);
    await Promise.resolve();

    expect(registry._ids()).toEqual([]);
    expect(registry.list()).toEqual([]);
  });

  it("contains a rejected detached refresh during provider teardown", async () => {
    let rejectList!: (reason?: unknown) => void;
    const pending = new Promise<ProtectedOutpoint[]>((_resolve, reject) => {
      rejectList = reject;
    });
    const registry = createProtectedOutpointRegistry();
    registry.register({
      id: "cancelled",
      ownerPluginId: "token-bsv21",
      listProtectedOutpoints: () => pending,
    });

    registry.unregister("cancelled");
    rejectList(Object.assign(new Error("Owner storage request was cancelled"), { code: "storage_unavailable" }));
    await Promise.resolve();

    expect(registry._ids()).toEqual([]);
    expect(registry.list()).toEqual([]);
  });
});

// 同一插件登记多个 provider（Forum 的专用资金与自有 Forum 输出都属于 `forum`）。
// 按插件粒度清理 claim 会让其中一个 provider 的刷新/注销清掉另一个的在途占用，
// 于是第二次 claim 意外成功——占用保护形同虚设。
describe("同插件多个 provider 的 claim 隔离", () => {
  const FUNDING = { txid: "aa".repeat(32), vout: 0, network: "main" as const };
  const SELF_OUTPUT = { txid: "bb".repeat(32), vout: 1, network: "main" as const };

  it("登记第二个 provider 不会清掉第一个 provider 已有的 claim", async () => {
    const registry = createProtectedOutpointRegistry();
    const funding = mutableProvider("protocol-funding:forum:task-1", "forum", [FUNDING]);
    registry.register(funding);
    await Promise.resolve();
    const claimed = await registry.claimProtectedInputs({
      ownerPluginId: "forum", network: "main", inputs: [{ txid: FUNDING.txid, vout: FUNDING.vout }],
    });

    // 自有输出 provider 登记并刷新：专用资金的占用必须还在。
    const selfOutputs = mutableProvider("forum-self-outputs", "forum", [SELF_OUTPUT]);
    registry.register(selfOutputs);
    await Promise.resolve();
    await Promise.resolve();

    // 在途占用仍在：第二次 claim 必须被挡住。
    await expect(registry.claimProtectedInputs({
      ownerPluginId: "forum", network: "main", inputs: [{ txid: FUNDING.txid, vout: FUNDING.vout }],
    })).rejects.toThrow(/already claimed/u);
    await registry.releaseClaims(claimed.claimIds);
  });

  it("自有输出 provider 自身刷新（集合变化）也不会清掉专用资金的 claim", async () => {
    const registry = createProtectedOutpointRegistry();
    registry.register(mutableProvider("protocol-funding:forum:task-1", "forum", [FUNDING]));
    await Promise.resolve();
    const claimed = await registry.claimProtectedInputs({
      ownerPluginId: "forum", network: "main", inputs: [{ txid: FUNDING.txid, vout: FUNDING.vout }],
    });

    const selfOutputs = mutableProvider("forum-self-outputs", "forum", [SELF_OUTPUT]);
    registry.register(selfOutputs);
    await Promise.resolve();
    selfOutputs.setItems([]);
    selfOutputs.emitChange();
    await Promise.resolve();
    await Promise.resolve();

    await expect(registry.claimProtectedInputs({
      ownerPluginId: "forum", network: "main", inputs: [{ txid: FUNDING.txid, vout: FUNDING.vout }],
    })).rejects.toThrow(/already claimed/u);
    await registry.releaseClaims(claimed.claimIds);
  });

  it("注销其中一个 provider 不影响另一个 provider 保护的 claim", async () => {
    const registry = createProtectedOutpointRegistry();
    registry.register(mutableProvider("protocol-funding:forum:task-1", "forum", [FUNDING]));
    await Promise.resolve();
    const claimed = await registry.claimProtectedInputs({
      ownerPluginId: "forum", network: "main", inputs: [{ txid: FUNDING.txid, vout: FUNDING.vout }],
    });
    registry.register(mutableProvider("forum-self-outputs", "forum", [SELF_OUTPUT]));
    await Promise.resolve();

    registry.unregister("forum-self-outputs");
    await Promise.resolve();

    await expect(registry.claimProtectedInputs({
      ownerPluginId: "forum", network: "main", inputs: [{ txid: FUNDING.txid, vout: FUNDING.vout }],
    })).rejects.toThrow(/already claimed/u);
    await registry.releaseClaims(claimed.claimIds);
  });

  it("真的没有任何 provider 保护时才回收 claim", async () => {
    const registry = createProtectedOutpointRegistry();
    const funding = mutableProvider("protocol-funding:forum:task-1", "forum", [FUNDING]);
    registry.register(funding);
    await Promise.resolve();
    const claimed = await registry.claimProtectedInputs({
      ownerPluginId: "forum", network: "main", inputs: [{ txid: FUNDING.txid, vout: FUNDING.vout }],
    });

    registry.unregister("protocol-funding:forum:task-1");
    await Promise.resolve();

    // 保护真的没了：登记回来的同一个 outpoint 可以重新占用，
    // 说明旧 claim 确实被回收，而不是永远卡住。
    registry.register(mutableProvider("protocol-funding:forum:task-1", "forum", [FUNDING]));
    await Promise.resolve();
    const again = await registry.claimProtectedInputs({
      ownerPluginId: "forum", network: "main", inputs: [{ txid: FUNDING.txid, vout: FUNDING.vout }],
    });
    expect(again.claimIds).toHaveLength(1);
    await registry.releaseClaims(claimed.claimIds);
    await registry.releaseClaims(again.claimIds);
  });
});
