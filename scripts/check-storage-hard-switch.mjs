// 存储硬切换命名门禁。
// 这不是提示性 lint：只要生产代码重新出现旧包名、旧符号或 *Db.ts 文件，
// 进程就失败，避免新实现被旧兼容层悄悄带回去。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
// 扫描整个仓库的生产源码、配置和测试入口。施工单与结构说明保留旧名重命名表，
// 因此只排除文档目录；检查器自身也必须包含旧名匹配规则，不能被规则本身误报。
const scanRoots = ["."];
const sourceExtensions = /\.(?:ts|tsx|js|jsx|json|css)$/u;
const forbiddenText = [
  ["旧包名", /@keymaster\/plugin-storage/u],
  ["旧运行时符号", /\bStorageService\b/u],
  ["旧权限上下文符号", /\bStorageAppContext\b/u],
  ["旧对象存储符号", /\bS3ObjectStore\b/u],
  ["旧命名空间函数", /\bbuildNamespaceRoot\b/u],
  ["旧 owner 句柄符号", /\bKeyScopedStorageHandle\b/u],
  ["旧 owner 打开函数", /\bopenKeyStorage\b/u],
  ["旧 manifest 字段", /\bkeyScopedStorages\b/u],
  ["旧 manifest 变量", /\bstoragePlugin\b/u],
  ["旧数据库后缀符号", /\b[A-Za-z][A-Za-z0-9]*Db\b/u],
  ["旧数据库打开符号", /\bopen[A-Za-z0-9]*Db[s]?\b/u],
  ["旧 getDb 符号", /\bgetDb\b/u],
  ["旧存储包路径", /(?:^|[\\/])plugin-storage(?:[\\/]|$)/u]
];
const violations = [];
const productionRoots = /^(?:packages|apps)\//u;
const localStorageAllowlist = new Set([
  "apps/web/src/theme/themeStore.ts",
  "packages/runtime/src/i18n/i18nStore.ts",
  "packages/platform-storage/src/bootstrap/storageProfileRepository.ts"
]);

function withoutComments(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/(^|\s)\/\/.*$/gmu, "$1");
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist" || name === ".git" || name === "docs" || name === "施工单" || name === ".temp") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return [path];
  });
}

for (const scanRoot of scanRoots) {
  const directory = join(root, scanRoot);
  for (const file of walk(directory)) {
    const relativeFile = relative(root, file);
    if (relativeFile === "scripts/check-storage-hard-switch.mjs") continue;
    if (/(?:^|\/)[^/]*(?:Db|Database)(?:\.test)?\.(?:ts|tsx)$/u.test(relativeFile)) {
      violations.push(`${relativeFile}: 文件名仍包含旧数据库后缀`);
    }
    if (!sourceExtensions.test(file)) continue;
    const content = readFileSync(file, "utf8");
    for (const [label, pattern] of forbiddenText) {
      if (pattern.test(content)) violations.push(`${relativeFile}: 命中${label}`);
    }
    if (productionRoots.test(relativeFile) && !/\.(?:test|spec)\.[^.]+$/u.test(relativeFile)) {
      // 目录已经切换到 Repository/K-V；生产代码不得继续留下旧浏览器
      // 数据库语义或固定的 IndexedDB namespace。测试夹具可以明确提及
      // 历史 API，但不能进入可发布源码。
      const legacyStorageSemantics = [
        ["旧 IndexedDB 语义", /\b(?:IndexedDB|indexedDB|IDB(?:Database|Transaction|Request|ObjectStore|Index|KeyRange|VersionChangeEvent)|IDB)\b/u],
        ["旧 DB 缩写语义", /\bDB\b/u],
        ["旧 DB 常量命名", /\b[A-Z][A-Z0-9]*_DB(?:_|\b)/u],
        ["模糊 db Repository 别名", /\bdb\b/u],
        ["旧 database 语义", /\bdatabase\b/iu],
        ["固定 protocol 数据库 namespace", /\bkeymaster\.protocol\b/u],
        ["snapshot/namespace DB 语义", /\b(?:snapshot|namespace)\s+DB\b/iu]
      ];
      for (const [label, pattern] of legacyStorageSemantics) {
        if (pattern.test(content)) violations.push(`${relativeFile}: 命中${label}`);
      }
      const executable = withoutComments(content);
      if (/\bindexedDB\b|\bIDB(?:Database|Transaction|Request|ObjectStore|Index|KeyRange|VersionChangeEvent)\b/gu.test(executable)) {
        violations.push(`${relativeFile}: 生产代码禁止直接使用 IndexedDB API`);
      }
      if (/\bsessionStorage\b/gu.test(executable)) {
        violations.push(`${relativeFile}: 生产代码禁止直接使用 sessionStorage`);
      }
      if (/\blocalStorage\b/gu.test(executable) && !localStorageAllowlist.has(relativeFile)) {
        violations.push(`${relativeFile}: localStorage 不在统一存储白名单内`);
      }
      if (/\bnavigator\.storage\b/gu.test(executable) && !relativeFile.startsWith("packages/platform-storage/src/bucket-providers/opfs/")) {
        violations.push(`${relativeFile}: OPFS StorageManager 只能由 platform-storage/opfs Provider 访问`);
      }
      if (/@aws-sdk\/client-s3/gu.test(executable) && relativeFile !== "packages/platform-storage/package.json" && !relativeFile.startsWith("packages/platform-storage/src/bucket-providers/s3/")) {
        violations.push(`${relativeFile}: S3 SDK 只能由 platform-storage/s3 Provider 访问`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error("存储代码结构硬切换检查失败：");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("存储代码结构硬切换检查通过：旧包名、旧符号、*Db.ts、业务浏览器存储和越层 Provider 均未发现。");
