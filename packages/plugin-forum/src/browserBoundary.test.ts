// Forum 浏览器入口的静态边界检查。
//
// 施工单 F01 要求：JCS 外壳与 Forum CBOR 业务签名各自使用正确编码，并且
// 浏览器 bundle 不能带入 Node HTTP server 适配依赖。这里用源码级断言把这条
// 约束变成可执行检查，而不是靠人记得。
//
// 检查项：
//   1. Forum 的生产源码不 import 任何 `node:` 内置模块；
//   2. roundtrip SDK 的 HTTP **客户端**在允许集合内，而它的 `node:http` 适配
//      （toNodeHandler）只出现在 SDK 自己的类型签名里，不进入 Forum 依赖图；
//   3. Worker 侧入口（coordinator.ts）不导出装配、UI、仓储、lane 或传输；
//   4. JCS 外壳与 CBOR 业务签名由两个不同模块提供，不会互相顶替。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const PLUGIN_ROOT = "packages/plugin-forum";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = join(directory, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    if (!/\.tsx?$/.test(name)) return [];
    return /\.test\.tsx?$/.test(name) ? [] : [full];
  });
}

const productionFiles = sourceFiles(join(process.cwd(), PLUGIN_ROOT, "src"));

describe("浏览器入口边界", () => {
  it("生产源码不引入 Node 内置模块", () => {
    const offenders: string[] = [];
    for (const file of productionFiles) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/(?:from\s+|import\s*\(\s*)["'](node:[^"']+)["']/gu)) {
        offenders.push(`${file}: ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("只依赖 roundtrip 的 HTTP 客户端，不依赖 Node server 适配", () => {
    const text = productionFiles.map((file) => readFileSync(file, "utf8")).join("\n");
    // 允许的 HTTP 传输：客户端与浏览器 fetch。
    expect(text).toContain("httpExchange");
    expect(text).toContain("HTTP_CONTENT_TYPE");
    // 不允许把 Node server 适配带进来。
    expect(text).not.toContain("toNodeHandler");
    expect(text).not.toContain("IncomingMessage");
    expect(text).not.toContain("ServerResponse");
    // HTTP 入口路径来自 contracts，不是本地硬编码的第二份真值。
    expect(text).toContain("FORUM_HTTP_PATH");
  });

  it("Worker 侧入口不导出装配、UI、仓储、lane 或传输", () => {
    const text = readFileSync(join(process.cwd(), PLUGIN_ROOT, "src", "coordinator.ts"), "utf8");
    // 只看真实的 import/export 语句：注释里提到 manifest 之类的词不算依赖。
    const edges = [...text.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/gu)].map((match) => match[1] as string);
    const reExports = [...text.matchAll(/export\s+\{([^}]*)\}\s+from\s+["']([^"']+)["']/gu)]
      .flatMap((match) => (match[1] ?? "").split(",").map((name) => name.trim()).filter((name) => name.length > 0))
      .concat([...text.matchAll(/export\s+(?:const|function|class|type|interface|async function)\s+([A-Za-z0-9_$]+)/gu)].map((match) => match[1] as string));
    for (const forbidden of [
      "manifest",
      "setup",
      "manifest.js",
      "pages.js",
      "ForumResourceContext",
      "forumRepository",
      "forumService",
      "ForumP2pLane",
      "roundtripClient",
      "createHttpsTransport",
      "createLibp2pTransport",
      "react",
      "@keymaster/plugin-msfile",
      "bitcoin-libp2p",
    ]) {
      // 模块图（import 的 specifier 与导出的名字）里都不允许出现这些。
      const inModuleGraph = [...edges, ...reExports].some(
        (entry) => entry.includes(forbidden) || entry === forbidden,
      );
      expect(inModuleGraph, `coordinator.ts 不应引入或导出 ${forbidden}`).toBe(false);
    }
    // 模块图里也没有任何传输层或 React 依赖。
    expect(edges.join(" ")).not.toMatch(/key-roundtrip|bitcoin-libp2p|@multiformats|react|plugin-msfile/u);
    // 协议与领域纯逻辑确实被导出，供未来 Worker 单元或集成测试复用。
    expect(text).toContain("verifyForumRoot");
    expect(text).toContain("ForumListStore");
    expect(text).toContain("verifyFinalRaw");
  });

  it("JCS 外壳与 CBOR 业务签名是两个独立模块，不会互相顶替", () => {
    const client = readFileSync(join(process.cwd(), PLUGIN_ROOT, "src", "network", "roundtripClient.ts"), "utf8");
    const cbor = readFileSync(join(process.cwd(), PLUGIN_ROOT, "src", "protocol", "cbor.ts"), "utf8");
    const objects = readFileSync(join(process.cwd(), PLUGIN_ROOT, "src", "protocol", "signatureObjects.ts"), "utf8");
    // 信封摘要由 SDK 的 digestOf（JCS + SHA-256）提供。
    expect(client).toContain("digestOf");
    // 业务签名对象由本模块的确定性 CBOR 编码。
    expect(objects).toContain('from "./cbor.js"');
    // cbor.ts 不依赖网络层，两者没有反向依赖。
    expect(cbor).not.toContain("key-roundtrip");
    expect(cbor).not.toContain("roundtripClient");
    // 协议模块不 import 任何网络/UI/存储模块。
    for (const file of ["bytes.ts", "cbor.ts", "crypto.ts", "script.ts", "layout.ts", "transaction.ts", "signatureObjects.ts"]) {
      const text = readFileSync(join(process.cwd(), PLUGIN_ROOT, "src", "protocol", file), "utf8");
      expect(text, `${file} 不应引入传输/UI/存储`).not.toMatch(/from\s+["'].*(roundtripClient|forumP2pLane|pages|forumService|forumRepository|markdown)/u);
    }
  });

  it("业务签名只接受结构化字段，页面不能提交任意 digest", () => {
    const objects = readFileSync(join(process.cwd(), PLUGIN_ROOT, "src", "protocol", "signatureObjects.ts"), "utf8");
    // 签名端口只有 signDigest/verifyDigest，没有「对任意 digest 签名」的入口。
    expect(objects).toMatch(/interface SigningPort \{[\s\S]*?signDigest\(digest: Uint8Array\)/u);
    // 对外暴露的是结构化对象的签名函数。
    expect(objects).toContain("signReplyOperatorObject");
    expect(objects).toContain("signChangeTipOperatorObject");
    expect(objects).toContain("signForumSignatureObject");
  });

  it("插件不新建内容仓库：正文能力来自 MSFile 契约", () => {
    const manifest = readFileSync(join(process.cwd(), PLUGIN_ROOT, "src", "manifest.ts"), "utf8");
    // 依赖的是 MSFile 的内容 capability，不是实现。
    expect(manifest).toContain("MSFILE_CONTENT_CAPABILITY");
    // Forum 自己的存储只声明配置、证据、缓存与任务，不含正文。
    expect(manifest).toContain("CENTRAL_STORAGE_DECLARATIONS.forumFiles");
  });
});