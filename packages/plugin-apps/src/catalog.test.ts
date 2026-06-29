// packages/plugin-apps/src/catalog.test.ts
// 校验 app 清单的纯函数测试。
//
// 设计缘由（施工单 2026-06-29 002 硬切换）：
//   - 校验逻辑必须允许"部分记录坏掉但 host 不崩"：坏记录走 invalid 列表，
//     后续 UI 对坏记录显示明确错误态。
//   - id 重复的记录归到 duplicates 列表；保留先出现的 ok entry。
//   - 不引入复杂 schema 系统；不走远端加载。

import { describe, expect, it } from "vitest";
import { loadCatalog, validateAppEntry, validateCatalog } from "./catalog.js";

describe("validateAppEntry", () => {
  it("合法记录通过", () => {
    const row = validateAppEntry({
      id: "justnote",
      name: "Justnote",
      summary: "Notes",
      appOrigin: "https://justnote.apps.bsv8.com",
      appUrl: "https://justnote.apps.bsv8.com/",
      claims: []
    });
    expect(row.kind).toBe("ok");
    if (row.kind === "ok") {
      expect(row.entry.id).toBe("justnote");
      expect(row.entry.appOrigin).toBe("https://justnote.apps.bsv8.com");
      expect(row.entry.claims).toEqual([]);
    }
  });

  it("缺 id → invalid", () => {
    const row = validateAppEntry({
      name: "X",
      appOrigin: "https://x.com",
      appUrl: "https://x.com/"
    });
    expect(row.kind).toBe("invalid");
    if (row.kind === "invalid") {
      expect(row.entry.reason).toBe("missing id");
    }
  });

  it("缺 name → invalid", () => {
    const row = validateAppEntry({
      id: "x",
      appOrigin: "https://x.com",
      appUrl: "https://x.com/"
    });
    expect(row.kind).toBe("invalid");
    if (row.kind === "invalid") {
      expect(row.entry.reason).toBe("missing name");
    }
  });

  it("缺 appOrigin → invalid", () => {
    const row = validateAppEntry({
      id: "x",
      name: "X",
      appUrl: "https://x.com/"
    });
    expect(row.kind).toBe("invalid");
    if (row.kind === "invalid") {
      expect(row.entry.reason).toBe("missing appOrigin");
    }
  });

  it("appOrigin 不是 exact origin → invalid", () => {
    const row = validateAppEntry({
      id: "x",
      name: "X",
      appOrigin: "not-a-url",
      appUrl: "https://x.com/"
    });
    expect(row.kind).toBe("invalid");
    if (row.kind === "invalid") {
      expect(row.entry.reason).toBe("invalid appOrigin");
    }
  });

  it("appUrl 与 appOrigin 不一致 → invalid", () => {
    const row = validateAppEntry({
      id: "x",
      name: "X",
      appOrigin: "https://x.com",
      appUrl: "https://other.com/"
    });
    expect(row.kind).toBe("invalid");
    if (row.kind === "invalid") {
      expect(row.entry.reason).toBe("appOrigin does not match appUrl.origin");
    }
  });

  it("appUrl 非法 → invalid", () => {
    const row = validateAppEntry({
      id: "x",
      name: "X",
      appOrigin: "https://x.com",
      appUrl: "not-a-url"
    });
    expect(row.kind).toBe("invalid");
    if (row.kind === "invalid") {
      expect(row.entry.reason).toBe("invalid appUrl");
    }
  });

  it("claims 不是数组时按空数组处理", () => {
    const row = validateAppEntry({
      id: "x",
      name: "X",
      appOrigin: "https://x.com",
      appUrl: "https://x.com/",
      claims: "not-array"
    });
    expect(row.kind).toBe("ok");
    if (row.kind === "ok") {
      expect(row.entry.claims).toEqual([]);
    }
  });

  it("顶层不是对象 → invalid", () => {
    const row = validateAppEntry("not-an-object");
    expect(row.kind).toBe("invalid");
  });
});

describe("validateCatalog", () => {
  it("整个清单不是数组时返回空", () => {
    const out = validateCatalog({ not: "array" });
    expect(out.ok).toEqual([]);
    expect(out.invalid.length).toBe(1);
    expect(out.duplicates).toEqual([]);
  });

  it("空数组 → 空结果", () => {
    const out = validateCatalog([]);
    expect(out.ok).toEqual([]);
    expect(out.invalid).toEqual([]);
    expect(out.duplicates).toEqual([]);
  });

  it("id 重复时先出现的入 ok，后出现的入 duplicates", () => {
    const out = validateCatalog([
      {
        id: "x",
        name: "X",
        appOrigin: "https://x.com",
        appUrl: "https://x.com/"
      },
      {
        id: "x",
        name: "X2",
        appOrigin: "https://x.com",
        appUrl: "https://x.com/"
      }
    ]);
    expect(out.ok.length).toBe(1);
    expect(out.duplicates.length).toBe(1);
    expect(out.duplicates[0]?.name).toBe("X2");
  });

  it("坏记录走 invalid 列表，不影响其它 ok 记录", () => {
    const out = validateCatalog([
      { id: "good", name: "Good", appOrigin: "https://g.com", appUrl: "https://g.com/" },
      { id: "bad", name: "Bad" }, // 缺 appOrigin / appUrl
      { id: "good2", name: "Good2", appOrigin: "https://g2.com", appUrl: "https://g2.com/" }
    ]);
    expect(out.ok.length).toBe(2);
    expect(out.invalid.length).toBe(1);
    expect(out.invalid[0]?.id).toBe("bad");
  });
});

describe("loadCatalog (实际 JSON)", () => {
  it("至少包含 justnote，且配置合法", () => {
    const out = loadCatalog();
    expect(out.ok.length).toBeGreaterThanOrEqual(1);
    const justnote = out.ok.find((e) => e.id === "justnote");
    expect(justnote).toBeTruthy();
    expect(justnote?.appOrigin).toBe("https://justnote.apps.bsv8.com");
    expect(justnote?.appUrl).toBe("https://justnote.apps.bsv8.com/");
    // 真实约束：appOrigin === new URL(appUrl).origin
    expect(new URL(justnote!.appUrl).origin).toBe(justnote!.appOrigin);
  });
});
