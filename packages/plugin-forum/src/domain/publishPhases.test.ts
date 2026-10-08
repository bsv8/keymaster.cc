import { describe, expect, it } from "vitest";

import type { ForumPublishPhase } from "@keymaster/contracts";

import { canAdvancePublishPhase } from "./forumService.js";

/**
 * 发布阶段的合法前驱图。
 *
 * 这张图是「多页不重复发布」的落点：阶段只能沿图前进，所以第二个页面即使读到
 * 同一份记录，也会因为阶段已经推进而落到对账而不是重新构造。
 */
describe("发布阶段推进", () => {
  it("只允许沿合法前驱推进", () => {
    // 正常链路。
    expect(canAdvancePublishPhase("draft", "signed")).toBe(true);
    expect(canAdvancePublishPhase("signed", "quoted")).toBe(true);
    expect(canAdvancePublishPhase("quoted", "budget-confirmed")).toBe(true);
    expect(canAdvancePublishPhase("budget-confirmed", "funding-prepared")).toBe(true);
    expect(canAdvancePublishPhase("funding-prepared", "raw-prepared")).toBe(true);
    expect(canAdvancePublishPhase("raw-prepared", "awaiting-index")).toBe(true);
    expect(canAdvancePublishPhase("awaiting-index", "indexed-confirmed")).toBe(true);
  });

  it("拒绝回退与跳跃：防止两个页面互相覆盖阶段", () => {
    const forbidden: readonly (readonly [ForumPublishPhase, ForumPublishPhase])[] = [
      // 已经派发/已观测的阶段不能回到草稿或签名。
      ["awaiting-index", "draft"],
      ["indexed-confirmed", "draft"],
      ["indexed-confirmed", "signed"],
      ["reconciling", "draft"],
      // 预算确认之前不能直接准备 raw。
      ["quoted", "raw-prepared"],
      ["signed", "raw-prepared"],
      ["draft", "quoted"],
      // 报价之前不能确认费用。
      ["signed", "budget-confirmed"],
    ];
    for (const [from, to] of forbidden) {
      expect(canAdvancePublishPhase(from, to), `${from} → ${to}`).toBe(false);
    }
  });

  it("同阶段推进允许：重复对账是正常的", () => {
    for (const phase of ["reconciling", "awaiting-index", "indexed-mempool"] as const) {
      expect(canAdvancePublishPhase(phase, phase)).toBe(true);
    }
  });

  it("失败后可以重新起草或回到对账，但不能凭空进入已观测", () => {
    expect(canAdvancePublishPhase("failed", "draft")).toBe(true);
    expect(canAdvancePublishPhase("failed", "reconciling")).toBe(true);
    expect(canAdvancePublishPhase("failed", "indexed-confirmed")).toBe(false);
    expect(canAdvancePublishPhase("failed", "raw-prepared")).toBe(false);
  });
});