// packages/runtime/src/registries/collectibleTransferRegistry.test.ts
// collectible transfer handler 选择规则回归测试。
//
// 关键不变量（施工单 004 / contracts/collectibleTransfer.ts）：
//   1. supports 过滤：handler.supports(ref) === true 才进入候选。
//   2. 候选按 order 升序；同 order 再按 I18nText fallback 二级稳定排序。
//   3. 平台页面在拿到候选集后再做"order 冲突抛英文错误"判定；registry
//      只负责"返回排序后的候选集"，不主动抛错。
//   4. supports 抛错时视为不支持（registry 内部 catch）。

import { describe, expect, it } from "vitest";
import type {
  CollectibleRef,
  CollectibleTransferHandler
} from "@keymaster/contracts";
import { createCollectibleTransferRegistry } from "./collectibleTransferRegistry.js";

function handler(
  id: string,
  order: number | undefined,
  supports: (ref: CollectibleRef) => boolean,
  nameFallback: string
): CollectibleTransferHandler {
  return {
    id,
    name: { key: `${id}.name`, fallback: nameFallback },
    order,
    supports,
    component: () => null
  };
}

const REF: CollectibleRef = { providerId: "1sat", collectibleId: "txid:0" };

describe("createCollectibleTransferRegistry - listSupporting", () => {
  it("无 handler 时返回空数组", () => {
    const reg = createCollectibleTransferRegistry();
    expect(reg.listSupporting(REF)).toEqual([]);
  });

  it("全部 handler 不 supports 时返回空数组", () => {
    const reg = createCollectibleTransferRegistry();
    reg.register(handler("a", 0, () => false, "A"));
    reg.register(handler("b", 10, () => false, "B"));
    expect(reg.listSupporting(REF)).toEqual([]);
  });

  it("仅 supports 的 handler 进入候选", () => {
    const reg = createCollectibleTransferRegistry();
    reg.register(handler("no", 0, () => false, "No"));
    reg.register(handler("yes", 5, () => true, "Yes"));
    const got = reg.listSupporting(REF);
    expect(got.map((h) => h.id)).toEqual(["yes"]);
  });

  it("候选按 order 升序", () => {
    const reg = createCollectibleTransferRegistry();
    reg.register(handler("a", 20, () => true, "A"));
    reg.register(handler("b", 5, () => true, "B"));
    reg.register(handler("c", 100, () => true, "C"));
    const got = reg.listSupporting(REF);
    expect(got.map((h) => h.id)).toEqual(["b", "a", "c"]);
  });

  it("同 order 时按 I18nText fallback 二级稳定排序", () => {
    const reg = createCollectibleTransferRegistry();
    reg.register(handler("z", 5, () => true, "Z-name"));
    reg.register(handler("a", 5, () => true, "A-name"));
    const got = reg.listSupporting(REF);
    expect(got.map((h) => h.id)).toEqual(["a", "z"]);
  });

  it("handler.supports 抛错时视为不支持", () => {
    const reg = createCollectibleTransferRegistry();
    reg.register(handler("boom", 0, () => { throw new Error("bad"); }, "Boom"));
    reg.register(handler("ok", 0, () => true, "Ok"));
    const got = reg.listSupporting(REF);
    expect(got.map((h) => h.id)).toEqual(["ok"]);
  });

  it("order 缺省时按 0 处理", () => {
    const reg = createCollectibleTransferRegistry();
    reg.register(handler("no-order", undefined, () => true, "No"));
    reg.register(handler("hi", 10, () => true, "Hi"));
    reg.register(handler("lo", -5, () => true, "Lo"));
    const got = reg.listSupporting(REF);
    expect(got.map((h) => h.id)).toEqual(["lo", "no-order", "hi"]);
  });

  it("重复 id 注册抛错", () => {
    const reg = createCollectibleTransferRegistry();
    reg.register(handler("dup", 0, () => true, "Dup"));
    expect(() => reg.register(handler("dup", 1, () => true, "Dup"))).toThrow(/already registered/);
  });

  it("unregister 移除 handler；id 不存在抛错", () => {
    const reg = createCollectibleTransferRegistry();
    reg.register(handler("a", 0, () => true, "A"));
    reg.unregister("a");
    expect(reg.listSupporting(REF)).toEqual([]);
    expect(() => reg.unregister("a")).toThrow(/not registered/);
  });
});