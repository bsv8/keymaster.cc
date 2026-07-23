import { describe, expect, it } from "vitest";
import { observationLabel, statusLabel } from "./collectibles.js";

const t = (_key: string, values?: { defaultValue?: string }) => values?.defaultValue ?? "";

describe("system collectibles labels", () => {
  it("maps collectible status labels", () => {
    expect(statusLabel("ready", t)).toBe("就绪");
    expect(statusLabel("syncing", t)).toBe("同步中");
    expect(statusLabel("stale", t)).toBe("过期");
    expect(statusLabel("failed", t)).toBe("失败");
    expect(statusLabel("unsupported", t)).toBe("不支持");
  });

  it("maps collectible observation labels", () => {
    expect(observationLabel("unconfirmed", t)).toBe("WOC 已观察（未确认）");
    expect(observationLabel("confirmed", t)).toBe("WOC 已确认");
    expect(observationLabel(undefined, t)).toBeUndefined();
  });
});
