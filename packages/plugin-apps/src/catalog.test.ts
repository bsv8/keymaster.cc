// packages/plugin-apps/src/catalog.test.ts
// 校验 app 清单的纯函数测试。
//
// 设计缘由（施工单 2026-06-29 002 硬切换）：
//   - 校验逻辑必须允许"部分记录坏掉但 host 不崩"：坏记录走 invalid 列表，
//     后续 UI 对坏记录显示明确错误态。
//   - id 重复的记录归到 duplicates 列表；保留先出现的 ok entry。
//   - 不引入复杂 schema 系统；不走远端加载。

import { describe, expect, it } from "vitest";
import { createCatalogResolver, loadCatalog, validateAppEntry, validateCatalog } from "./catalog.js";

const FIXTURE_PROOF = {
  version: 1 as const,
  publisherPublicKey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  app: { id: "vite-fixture", name: "Vite Fixture", description: "Fixture" },
  requirements: ["storage"] as ("private-key" | "storage")[],
  signature: "217a8c1761de074dc3c1e6e90f31f00b09f54ecb87d9ba2b1e157570033777c4373fc0281c76466ab20d04bc231b61a52ae3681c08e11f021ae6955718c1cb17"
};

function withProof<T extends Record<string, unknown>>(row: T): T & { appIdentity: typeof FIXTURE_PROOF } {
  return { ...row, appIdentity: FIXTURE_PROOF };
}

describe("validateAppEntry", () => {
  it("合法记录通过", () => {
    const row = validateAppEntry(withProof({
      id: "justnote",
      name: "Justnote",
      summary: "Notes",
      appOrigin: "https://justnote.apps.bsv8.com",
      appUrl: "https://justnote.apps.bsv8.com/",
      claims: []
    }));
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
    expect(row.kind).toBe("invalid");
    if (row.kind === "ok") {
      expect(row.entry.claims).toEqual([]);
    }
  });

  it("metadata app.id 可独立于 launcher row id", () => {
    const row = validateAppEntry({
      id: "catalog-app",
      name: "Catalog App",
      appOrigin: "https://x.com",
      appUrl: "https://x.com/",
      appIdentity: {
        version: 1,
        // secp256k1 generator, compressed form
        publisherPublicKey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
        app: { id: "stable-app-id", name: "Stable App", description: "Description" },
        requirements: [],
        signature: "ba7206e5617360697c0199ffdb3c82a2728b2e46a5b48b39d405ec65009bc3c34a3a91e0acf1f37ff88654a7a60d3f4da8532875d3f333859a22c8eb9feb7af7"
      }
    });
    expect(row.kind).toBe("ok");
    if (row.kind === "ok") expect(row.entry.appIdentity?.app.id).toBe("stable-app-id");
  });

  it("metadata 未知 requirement 或额外字段时 invalid", () => {
    const row = validateAppEntry({
      id: "x",
      name: "X",
      appOrigin: "https://x.com",
      appUrl: "https://x.com/",
      appIdentity: {
        version: 1,
        publisherPublicKey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
        app: { id: "x", name: "X", description: "X" },
        requirements: ["network"]
      }
    });
    expect(row).toMatchObject({ kind: "invalid", entry: { reason: "appIdentity has unexpected fields" } });
  });

  it("Demo 无真实 publisher key 时 fail closed", () => {
    const row = validateAppEntry({
      id: "demo",
      name: "Demo",
      appOrigin: "https://demo.apps.bsv8.com",
      appUrl: "https://demo.apps.bsv8.com/",
      appIdentity: {
        version: 1,
        publisherPublicKey: "",
        app: { id: "keymaster-connect-demo", name: "Demo", description: "Demo" },
        requirements: [],
        signature: ""
      }
    });
    expect(row).toMatchObject({ kind: "invalid", entry: { reason: "invalid publisher public key" } });
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
      withProof({
        id: "x",
        name: "X",
        appOrigin: "https://x.com",
        appUrl: "https://x.com/"
      }),
      withProof({
        id: "x",
        name: "X2",
        appOrigin: "https://x.com",
        appUrl: "https://x.com/"
      })
    ]);
    expect(out.ok.length).toBe(1);
    expect(out.duplicates.length).toBe(1);
    expect(out.duplicates[0]?.name).toBe("X2");
  });

  it("exact appOrigin 重复时首条是真值，后条进入 duplicates", () => {
    const out = validateCatalog([
      withProof({ id: "first", name: "First", appOrigin: "https://same.example", appUrl: "https://same.example/" }),
      withProof({ id: "second", name: "Second", appOrigin: "https://same.example", appUrl: "https://same.example/" })
    ]);
    expect(out.ok.map((entry) => entry.id)).toEqual(["first"]);
    expect(out.duplicates.map((entry) => entry.id)).toEqual(["second"]);
    expect(createCatalogResolver(out).resolve("https://same.example")).toMatchObject({ kind: "known-valid", appId: "first" });
  });

  it("坏记录走 invalid 列表，不影响其它 ok 记录", () => {
    const out = validateCatalog([
      withProof({ id: "good", name: "Good", appOrigin: "https://g.com", appUrl: "https://g.com/" }),
      { id: "bad", name: "Bad" }, // 缺 appOrigin / appUrl
      withProof({ id: "good2", name: "Good2", appOrigin: "https://g2.com", appUrl: "https://g2.com/" })
    ]);
    expect(out.ok.length).toBe(2);
    expect(out.invalid.length).toBe(1);
    expect(out.invalid[0]?.id).toBe("bad");
  });
});

describe("loadCatalog (实际 JSON)", () => {
  it("Demo 使用真实 proof，其它缺少 proof 的 app 明确 invalid", () => {
    const out = loadCatalog();
    expect(out.ok.map((entry) => entry.id)).toEqual(["demo"]);
    const demo = out.ok[0]!;
    expect(demo.appOrigin).toBe("https://demo.apps.bsv8.com");
    expect(demo.appIdentity).toMatchObject({
      version: 1,
      publisherPublicKey: "032558368095eb0a4cb07d0dd59a8a5bffdfd19c495a79de280db63b746e228b30",
      app: {
        id: "keymaster-connect-demo",
        name: "Keymaster Connect Demo",
        description: "Keymaster Connect V1 外部调用方 demo，验证 identity.get、intent.sign、cipher.encrypt、cipher.decrypt。"
      },
      requirements: ["private-key", "storage"]
    });
    expect(demo.appIdentity.signature).toMatch(/^[0-9a-f]{128}$/u);
    expect(out.invalid.map((entry) => entry.id)).toEqual(["justnote", "s3disk"]);
    expect(out.invalid.some((entry) => entry.id === "justnote" && entry.reason === "missing appIdentity proof")).toBe(true);
    expect(out.invalid.some((entry) => entry.id === "s3disk" && entry.reason === "missing appIdentity proof")).toBe(true);
    expect(out.duplicates).toEqual([]);
    const resolver = createCatalogResolver(out);
    expect(resolver.resolve("https://demo.apps.bsv8.com")).toMatchObject({
      kind: "known-valid",
      appId: "demo"
    });
    expect(resolver.resolve("https://unknown.example")).toEqual({ kind: "unknown" });
  });
});
