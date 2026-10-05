// scripts/check-boundaries.mjs
// 插件/包边界检查：禁止跨越本应单向的依赖。
// 设计缘由：plugin-host 通过 capability/registry 协作；直接 import 互相依赖的包
// 会让边界立刻失效（也是这次硬切换的核心动机）。
//
// 重要：本脚本必须是"可失败"的硬规则，不只是备注说明。所有插件
// 硬切换文档（001）里要求的边界都在这里写成 process.exit(1) 路径，避免
// 实施时被"先放着，后面再补"绕过。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const root = process.cwd();
const packagesDir = join(root, "packages");
const pluginNames = readdirSync(packagesDir).filter((name) => name.startsWith("plugin-") || name === "platform-storage");
const violations = [];

/** 递归收集目录下所有 ts/tsx 源文件。 */
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    // 跳过依赖产物目录：pnpm 把 @keymaster/* 软链进各包的 node_modules，
    // 顺着软链递归会扫到 runtime 自己的 AppLink.tsx（它本就合法地用动态
    // href），产生 20+ 条假阳性。边界检查只针对各包 src 源码。
    if (name === "node_modules" || name === "dist") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

function recordViolation(file, detail) {
  violations.push(`${relative(root, file)} ${detail}`);
}

// These integration fixtures exercise public package entry points together.
// Private subpaths and all production imports remain forbidden.
const publicIntegrationImports = new Map([
  ["packages/plugin-page/src/shell/AppShell.notice.test.tsx", new Set(["@keymaster/plugin-webrtc"])],
]);
/** 所有插件（包括 Storage）通过契约协作，禁止实现互导与私有装配入口。 */
for (const plugin of pluginNames) {
  const src = join(packagesDir, plugin, "src");
  if (!existsSync(src)) continue;
  for (const file of walk(src)) {
    const text = readFileSync(file, "utf8");
    const imports = [...text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/gu)].map((match) => match[1]);
    for (const specifier of imports) {
      for (const other of pluginNames) {
        if (other === plugin) continue;
        const pkg = `@keymaster/${other}`;
        const target = specifier.startsWith(".") ? resolve(file, "..", specifier) : undefined;
        const otherRoot = join(packagesDir, other) + sep;
        if (specifier === pkg || specifier.startsWith(pkg + "/") || target?.startsWith(otherRoot)) {
          if (!publicIntegrationImports.get(relative(root, file))?.has(specifier)) recordViolation(file, `imports another plugin implementation: ${specifier}`);
        }
      }
      if (/^@keymaster\/platform-storage\/(?:assembly|coordinator)(?:\/|$)/u.test(specifier) && plugin !== "platform-storage") {
        recordViolation(file, `imports Storage private assembly: ${specifier}`);
      }
    }
  }
}

/** 检查 plugin-assets 禁止 import 任何具体资产插件。 */
const assetsSrc = join(packagesDir, "plugin-assets", "src");
if (existsSync(assetsSrc)) {
  for (const file of walk(assetsSrc)) {
    const text = readFileSync(file, "utf8");
    if (/@keymaster\/plugin-p2pkh\b/.test(text)) {
      recordViolation(file, "plugin-assets must not import @keymaster/plugin-p2pkh");
    }
  }
}

/** 检查 plugin-transfer 禁止 import 任何具体资产插件、vault、contacts。 */
const transferSrc = join(packagesDir, "plugin-transfer", "src");
if (existsSync(transferSrc)) {
  for (const file of walk(transferSrc)) {
    const text = readFileSync(file, "utf8");
    for (const p of pluginNames) {
      if (p === "plugin-transfer" || p === "plugin-assets" || p === "plugin-woc" || p === "plugin-background") continue;
      const pkg = `@keymaster/${p}`;
      if (new RegExp(`(from\\s+['"]${pkg}|require\\(['"]${pkg})`).test(text)) {
        recordViolation(file, `plugin-transfer must not import ${pkg}`);
      }
    }
  }
}

/** 检查 plugin-p2pkh 禁止直接 fetch WOC URL 或 import woc。 */
const p2pkhSrc = join(packagesDir, "plugin-p2pkh", "src");
for (const file of walk(p2pkhSrc)) {
  const text = readFileSync(file, "utf8");
  if (/@keymaster\/plugin-woc\b/.test(text)) {
    recordViolation(file, "plugin-p2pkh must not import @keymaster/plugin-woc");
  }
  if (/api\.whatsonchain\.com/.test(text) || /whatsonchain\.com/.test(text)) {
    recordViolation(file, "plugin-p2pkh must not directly reference WOC URLs");
  }
  if (/["'`]\/v1\/bsv/.test(text)) {
    recordViolation(file, "plugin-p2pkh must not construct WOC URL paths");
  }
}

/** 检查 plugin-woc 禁止 import plugin-p2pkh。 */
const wocSrc = join(packagesDir, "plugin-woc", "src");
if (existsSync(wocSrc)) {
  for (const file of walk(wocSrc)) {
    const text = readFileSync(file, "utf8");
    if (/@keymaster\/plugin-p2pkh\b/.test(text)) {
      recordViolation(file, "plugin-woc must not import @keymaster/plugin-p2pkh");
    }
  }
}

/** 检查 plugin-background 禁止 import plugin-p2pkh 或 plugin-woc。 */
const bgSrc = join(packagesDir, "plugin-background", "src");
if (existsSync(bgSrc)) {
  for (const file of walk(bgSrc)) {
    const text = readFileSync(file, "utf8");
    for (const other of ["plugin-p2pkh", "plugin-woc"]) {
      const pkg = `@keymaster/${other}`;
      if (new RegExp(`(from\\s+['"]${pkg}|require\\(['"]${pkg})`).test(text)) {
        recordViolation(file, `plugin-background must not import ${pkg}`);
      }
    }
  }
}

/** 检查 contracts 禁止 import runtime / ui / plugin-*。 */
const contractsSrc = join(packagesDir, "contracts", "src");
for (const file of walk(contractsSrc)) {
  const text = readFileSync(file, "utf8");
  for (const forbidden of ["@keymaster/runtime", "@keymaster/ui"]) {
    const re = new RegExp(`(from\\s+['"]${forbidden}|require\\(['"]${forbidden})`);
    if (re.test(text)) {
      recordViolation(file, `contracts must not import ${forbidden}`);
    }
  }
  for (const p of pluginNames) {
    const pkg = `@keymaster/${p}`;
    if (new RegExp(`(from\\s+['"]${pkg}|require\\(['"]${pkg})`).test(text)) {
      recordViolation(file, `contracts must not import ${pkg}`);
    }
  }
}

/** 检查 runtime 禁止 import plugin-*。 */
const runtimeSrc = join(packagesDir, "runtime", "src");
for (const file of walk(runtimeSrc)) {
  const text = readFileSync(file, "utf8");
  for (const p of pluginNames) {
    const pkg = `@keymaster/${p}`;
    if (new RegExp(`(from\\s+['"]${pkg}|require\\(['"]${pkg})`).test(text)) {
      if (!(relative(root, file).split(sep).join("/") === "packages/runtime/src/testSupport/createFixtureHost.ts" && p === "platform-storage")) recordViolation(file, `runtime must not import ${pkg}`);
    }
  }
}

/**
 * WebLoom 拆分边界（施工单 001 / KM-003）。
 *
 * Keymaster 只通过已发布的 `webloom-framework` 公共入口消费框架；源码不得
 * 绕过 exports 直接依赖框架的 src/dist。正式发布前由 release gate 继续检查
 * 依赖版本和 lockfile，避免本地路径误带进业务代码。
 */
const removedRuntimeFiles = [
  "capabilityRegistry.ts",
  "createPluginHost.ts",
  "messageBus.ts",
  "pluginGraph.ts",
  "pluginOwnership.ts",
  "lifecycle/messagePortServiceProvider.ts",
  "lifecycle/messagePortServiceTransport.ts",
  "lifecycle/permissionLease.ts",
  "lifecycle/permissionVerifier.ts",
  "lifecycle/pluginIntentController.ts",
  "lifecycle/resourceScope.ts",
  "lifecycle/runtimeUnitImplementationRegistry.ts",
  "lifecycle/scopedMessageBus.ts",
  "lifecycle/scopedRegistry.ts",
  "lifecycle/serviceBridge.ts",
  "lifecycle/taskScheduler.ts",
  "lifecycle/upgradeGate.ts",
  "resources/resourceRegistry.ts",
  "resources/resourceStore.ts",
  "react/renderCounter.ts",
  "react/useCapability.ts",
  "react/useResource.ts",
  "react/useResourceSelector.ts",
];
for (const relativePath of removedRuntimeFiles) {
  const file = join(runtimeSrc, relativePath);
  if (existsSync(file)) recordViolation(file, "generic WebLoom implementation must not be duplicated in @keymaster/runtime");
}

const webLoomConsumerRoots = [
  join(root, "apps", "web"),
  ...readdirSync(packagesDir)
    .filter((name) => existsSync(join(packagesDir, name, "src")))
    .map((name) => join(packagesDir, name)),
];
function packageJsonForSource(file) {
  const relativePath = relative(root, file).split(sep);
  if (relativePath[0] === "apps" && relativePath[1]) return join(root, "apps", relativePath[1], "package.json");
  if (relativePath[0] === "packages" && relativePath[1]) return join(root, "packages", relativePath[1], "package.json");
  return undefined;
}
const webLoomPackageName = "webloom-framework";
const legacyWebLoomImport = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']webloom(?:["']|\/)/u;
const webLoomDeepImport = new RegExp(
  String.raw`(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']${webLoomPackageName}\/(?!react["']|advanced["']|testing["'])`,
  "u",
);
const webLoomPublicImport = new RegExp(
  String.raw`(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']${webLoomPackageName}(?:["']|\/(?:react|testing)["'])`,
  "u",
);
for (const consumerRoot of webLoomConsumerRoots) {
  const source = join(consumerRoot, "src");
  if (!existsSync(source)) continue;
  const consumerPackageJson = join(consumerRoot, "package.json");
  if (existsSync(consumerPackageJson)) {
    const packageData = JSON.parse(readFileSync(consumerPackageJson, "utf8"));
    const dependencySections = [packageData.dependencies, packageData.devDependencies, packageData.peerDependencies];
    if (dependencySections.some((section) => section && Object.hasOwn(section, "webloom"))) {
      recordViolation(consumerPackageJson, "must not declare the legacy webloom dependency; use webloom-framework");
    }
  }
  for (const file of walk(source)) {
    const text = readFileSync(file, "utf8");
    const pagePrivateImports = [...text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/gu)]
      .map(match => match[1]).some(specifier =>
        specifier.startsWith("@keymaster/plugin-page/")
        || (specifier.startsWith(".") && resolve(file, "..", specifier).startsWith(join(packagesDir, "plugin-page/src") + sep)));
    if (pagePrivateImports && !file.startsWith(join(packagesDir, "plugin-page/src") + sep)) {
      recordViolation(file, "page implementation is private; consume its typed UI services");
    }
    const consumerIssuerReferences = [...text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/gu)]
      .map(match => match[1]).filter(specifier =>
        /^@keymaster\/runtime\/(?:src\/)?consumerAuthority(?:\.|$)/u.test(specifier)
        || (specifier.startsWith(".") && resolve(file, "..", specifier).replace(/\.js$/u, ".ts") === join(packagesDir, "runtime/src/consumerAuthority.ts")));
    if (consumerIssuerReferences.length && ![join(packagesDir, "runtime/src/keymasterHostAdapter.ts"), join(packagesDir, "runtime/src/index.ts"), join(packagesDir, "runtime/src/storage/index.ts"), join(packagesDir, "runtime/src/instanceRegistry.ts"), join(packagesDir, "runtime/src/scopedClientBinding.ts")].includes(file)) {
      const readOnlyIssuerUsers = new Map([
        [join(packagesDir, "runtime/src/react/useWalletState.ts"), new Set(["issuedConsumerScope"])],
        [join(packagesDir, "runtime/src/assembly.ts"), new Set(["issuedConsumerForScope"])],
      ]);
      const allowedNames = readOnlyIssuerUsers.get(file);
      const imports = [...text.matchAll(/(?:import|export)\s*\{([^}]+)\}\s*from\s*["'][^"']*consumerAuthority\.js["']/gu)];
      const names = imports.flatMap(match => match[1].split(",").map(name => name.trim().split(/\s+as\s+/u)[0]));
      if (!allowedNames || consumerIssuerReferences.length !== 1 || imports.length !== 1 || names.some(name => !allowedNames.has(name))) recordViolation(file, "consumer issuer is private to the production runtime adapter");
    }
    const storagePrivateImports = [...text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/gu)]
      .map(match => match[1]).filter(specifier => {
        if (/^@keymaster\/platform-storage\/(?:assembly|coordinator)(?:$|\/)/u.test(specifier)) return true;
        if (!specifier.startsWith(".")) return false;
        const target = resolve(file, "..", specifier);
        return target.startsWith(join(packagesDir, "platform-storage", "src") + sep);
      });
    if (storagePrivateImports.length > 0) {
      const sourcePath = relative(root, file).split(sep).join("/");
      const trustedStorageAssembly = sourcePath === "apps/web/src/keymasterSessionCoordinator.worker.ts"
        || sourcePath.startsWith("apps/web/src/assembly/")
        || sourcePath === "apps/web/src/coordinator/walletKeyRepository.test.ts"
        || sourcePath === "packages/runtime/src/testSupport/createFixtureHost.ts"
        || sourcePath.startsWith("packages/platform-storage/src/")
        || ((sourcePath === "apps/web/src/bootstrapPlugins.ts" || sourcePath === "apps/web/src/lifecycleE2E/windowHooks.ts")
          && storagePrivateImports.every(specifier => specifier === "@keymaster/platform-storage/coordinator/authority" || (sourcePath === "apps/web/src/bootstrapPlugins.ts" && specifier === "@keymaster/platform-storage/assembly")));
      if (!trustedStorageAssembly) recordViolation(file, "Storage private assembly is only available to trusted Window/Worker assembly");
    }
    if (legacyWebLoomImport.test(text)) {
      recordViolation(file, "must not import the legacy webloom package; use webloom-framework");
    }
    // 公共入口只有 webloom-framework、webloom-framework/react、
    // webloom-framework/advanced、webloom-framework/testing；禁止接触内部文件。
    if (webLoomDeepImport.test(text)) {
      recordViolation(file, "must import WebLoom through public exports, not webloom-framework/src, webloom-framework/dist, or another private subpath");
    }
    if (/\/home\/david\/Workspaces\/WebLoom|(?:\.\.?\/)+WebLoom\/(?:src|dist)/.test(text)) {
      recordViolation(file, "must not reference the local WebLoom source tree");
    }
    if (webLoomPublicImport.test(text)) {
      const packageJson = packageJsonForSource(file);
      if (!packageJson || !existsSync(packageJson)) {
        recordViolation(file, "WebLoom consumer package.json is missing");
      } else {
        const packageData = JSON.parse(readFileSync(packageJson, "utf8"));
        const declared = packageData.dependencies?.[webLoomPackageName]
          ?? packageData.devDependencies?.[webLoomPackageName]
          ?? packageData.peerDependencies?.[webLoomPackageName];
        if (!declared) recordViolation(file, "direct WebLoom import requires an explicit webloom-framework dependency");
      }
    }
  }
}

/** 检查 apps/web shell 不 import plugin-background。 */
const shellDir = join(root, "apps", "web", "src", "shell");
for (const file of walk(shellDir)) {
  const text = readFileSync(file, "utf8");
  if (/@keymaster\/plugin-background\b/.test(text)) {
    recordViolation(file, "Shell must not import @keymaster/plugin-background");
  }
}

/** 硬切换 002：启动关键能力属于 entrypoint 契约，不允许 Shell 做局部降级。 */
for (const file of walk(shellDir)) {
  const text = readFileSync(file, "utf8");
  if (/useHasCapability\s*\(\s*["']vault\.service["']\s*\)/.test(text)) {
    recordViolation(file, 'Shell must not downgrade startup capability "vault.service"');
  }
}

/** 硬切换 002：manifest setup 不得绕过 runtime 直接读取启停配置存储。 */
for (const file of pluginNames.flatMap((plugin) => {
  const manifest = join(packagesDir, plugin, "src", "manifest.ts");
  return existsSync(manifest) && statSync(manifest).isFile() ? [manifest] : [];
})) {
  const text = readFileSync(file, "utf8");
  if (/keymaster\.plugins\.runtime|pluginConfigStore|PluginConfigStore/.test(text)) {
    recordViolation(file, "manifest setup must not access plugin config storage directly");
  }
}

/**
 * 硬切换 007：内部导航禁止走浏览器原生硬跳转。
 *
 * 设计缘由：之前 plugin-p2pkh / plugin-assets 各自写 `<a href="/settings/woc">`
 * 和 `window.location.href = ...`，结果整页刷新、React host 重建、Vault
 * in-memory 解锁态丢失。规范需要落到"可失败"的检查上，不只是文档约束。
 *
 * 规则：
 *   1. `packages/**` 与 `apps/web/src/**` 禁止出现任何内部 `<a>` 跳转，包括
 *      字面量 `<a href="/...">` / `<a href={`/...`}>` 与表达式形式
 *      `<a href={...}>`。内部文本链接必须走 runtime AppLink；如果未来需要
 *      动态外链 URL，请用字面量 `<a href="https://...">` 而不是表达式。
 *   2. 禁止 `window.location.href = X` / `location.assign(X)` /
 *      `location.replace(X)`，其中 X 不是字面量外链（"https://..." / 'https://...'）。
 *      字面量内部路径（"/foo"）单独命中规则 1 / 2 的内部字面量分支。
 *   3. 允许外链（`http://` / `https://` / `mailto:` 等）——只对应用内同源 pathname
 *      做强约束。
 *   4. 例外：注释里的描述性引用不应触发；脚本在检查前会先剥离行注释。
 *   5. 例外：apps/web/index.html 里的 favicon / 静态资源链接不在本检查范围内
 *      （它本来就在白名单外，文件类型也不属于 ts/tsx 扫描路径）。
 */
const navScanRoots = [
  packagesDir,
  join(root, "apps", "web", "src")
];
const navIgnoreFiles = new Set([
  // AppLink / navigate 自身是规则的实现方，注释里会引用 `href="/..."` 作为反例。
  join(packagesDir, "runtime", "src", "react", "AppLink.tsx"),
  join(packagesDir, "runtime", "src", "navigate.ts")
]);
const EXTERNAL_LITERAL = /^\s*["'`]https?:\/\//;
/**
 * 把代码里的注释（行注释 + 块注释）替换成空格，保留换行与字符长度。字符串
 * / 模板字面量原样保留：规则需要看见字符串里的内容（`<a href="/...">` 的
 * 内部路径、`window.location.href = "https://..."` 的字面量外链），不能
 * 遮蔽成空格。
 *
 * 设计缘由：硬切换 007 收尾里发现，旧的"剥离行注释"实现（行注释正则
 * 全局替换）会把字符串里的 `https://example.com` 截断成 `https:`，导致
 * `2b` 的外链白名单负向先行误报——文档说支持字面量外链，实际实现并不可
 * 靠。这里用最小状态机区分"代码 / 行注释 / 块注释 / 单引号字符串 / 双引号
 * 字符串 / 模板字面量"：行注释 / 块注释被替换成空格；字符串 / 模板原样
 * 保留；只在 code 区识别行注释、块注释、单引号、双引号、反引号。
 *
 * 模板字面量里 `${...}` 的表达式体走 code 分支（处理字符串 / 注释），关闭
 * `}` 后回到 template；这样 `${a + "https://x"}` 里的 `https://` 仍然完整。
 */
function maskCommentsAndStrings(text) {
  const n = text.length;
  let out = "";
  let i = 0;
  // 状态：code | lineComment | blockComment | sqString | dqString | template
  let state = "code";
  // 模板字面量里 `${...}` 嵌套层数：>0 时说明在表达式体里，回归 code 模式
  // 以正确处理表达式内的注释 / 字符串。`}` 关闭一层，0 时回到 template。
  let tplDepth = 0;
  while (i < n) {
    const c = text[i];
    const next = i + 1 < n ? text[i + 1] : "";
    if (state === "code") {
      if (c === "/" && next === "/") {
        state = "lineComment";
        out += "  ";
        i += 2;
      } else if (c === "/" && next === "*") {
        state = "blockComment";
        out += "  ";
        i += 2;
      } else if (c === "'") {
        state = "sqString";
        out += c;
        i++;
      } else if (c === '"') {
        state = "dqString";
        out += c;
        i++;
      } else if (c === "`") {
        state = "template";
        tplDepth = 0;
        out += c;
        i++;
      } else if (tplDepth > 0 && c === "{") {
        // 嵌套 `${ ${...} }`：表达式里又有 `${`，继续走 code 处理。
        tplDepth++;
        out += c;
        i++;
      } else if (tplDepth > 0 && c === "}") {
        // 关键修复：原来 `}` 处理器只在 template 分支，导致 `${host}` 的
        // `}` 在 code 状态下落穿，tplDepth 永远不递减，模板永远关不上，
        // 后续所有内容被当成模板正文保留——`// 真实违规` 这种行注释就
        // 不再被遮蔽。这里在 code 状态也补上 `}` 处理。
        tplDepth--;
        out += c;
        if (tplDepth === 0) state = "template";
        i++;
      } else {
        out += c;
        i++;
      }
    } else if (state === "lineComment") {
      if (c === "\n") {
        state = "code";
        out += "\n";
        i++;
      } else {
        out += " ";
        i++;
      }
    } else if (state === "blockComment") {
      if (c === "*" && next === "/") {
        state = "code";
        out += "  ";
        i += 2;
      } else {
        out += c === "\n" ? "\n" : " ";
        i++;
      }
    } else if (state === "sqString" || state === "dqString") {
      // 字符串原文保留（不能 mask 成空格，否则规则看不到里面的字面量
      // 内部路径 / 字面量外链）。`\` 后跟任意字符视为转义，整体保留。
      if (c === "\\" && i + 1 < n) {
        out += c + next;
        i += 2;
      } else if (c === (state === "sqString" ? "'" : '"')) {
        state = "code";
        out += c;
        i++;
      } else {
        out += c;
        i++;
      }
    } else if (state === "template") {
      if (c === "\\" && i + 1 < n) {
        out += c + next;
        i += 2;
      } else if (tplDepth === 0 && c === "`") {
        state = "code";
        out += c;
        i++;
      } else if (tplDepth === 0 && c === "$" && next === "{") {
        tplDepth = 1;
        out += "${";
        i += 2;
        // 进入表达式体：跟普通 code 一样处理，遇字符串再切回。
        state = "code";
      } else {
        // 模板字面量正文：原样保留（`https://...` 这种字面量外链必须在
        // 规则负向先行里能被看到）。`${` 与 `}` 的处理走 code 分支。
        out += c;
        i++;
      }
    } else {
      // 不可达
      out += c;
      i++;
    }
  }
  return out;
}

for (const rootDir of navScanRoots) {
  let files;
  try {
    files = walk(rootDir);
  } catch {
    continue;
  }
  for (const file of files) {
    if (navIgnoreFiles.has(file)) continue;
    const text = readFileSync(file, "utf8");
    // 用 maskCommentsAndStrings 同时遮蔽注释和字符串内容；这样反例描述
    // 不会触发匹配，而 `"https://..."` 里的 `//` 也不会被截断。
    const stripped = maskCommentsAndStrings(text);

    // 1a) <a ... href="/..."> / <a ... href={`/...`}> —— 字面量内部 href
    if (/<a\b[^>]*\bhref\s*=\s*["'`](\/[^"'`\s]*)["'`]/.test(stripped)) {
      recordViolation(file, "internal <a href=\"/...\"> is forbidden; use runtime AppLink");
    }

    // 1b) <a ... href={...}> —— 表达式形式 href 一律视为可疑。
    // 原因：从语法上无法区分 "detailRoute.path" 内部路径和 "externalUrl"
    // 外部 URL；为防止 plugin-assets 这次同类问题复发，统一要求走 AppLink
    // （内部）或字面量 <a href="https://...">（外部）。
    if (/<a\b[^>]*\bhref\s*=\s*\{/.test(stripped)) {
      recordViolation(file, "<a href={...}> with a dynamic value is forbidden; use runtime AppLink (internal) or a literal <a href=\"https://...\"> (external)");
    }

    // 2a) window.location.href = "/..." / "{...}" —— 字面量内部路径
    if (/window\.location\.href\s*=\s*["'`](\/[^"'`\s]*)["'`]/.test(stripped)) {
      recordViolation(file, "internal window.location.href assignment is forbidden; use router.push");
    }

    // 2b) window.location.href = X —— X 不是字面量外链则全部禁止（变量、
    // 函数返回、模板字符串、内部字面量），全部应改 router.push。
    // 负向先行 (?![`'"]https?:\/\/)：白名单仅放行字面量外链赋值。
    {
      const re = /window\.location\.href\s*=\s*(?![`'"]https?:\/\/)/g;
      if (re.test(stripped)) {
        recordViolation(file, "window.location.href = <non-external-literal> is forbidden; use router.push");
      }
    }

    // 2c) window.location.assign / location.assign / location.replace：
    // 同理，禁止除字面量外链以外的所有调用。
    {
      const re = /window\.location\.assign\s*\(\s*(?![`'"]https?:\/\/)/g;
      if (re.test(stripped)) {
        recordViolation(file, "window.location.assign(<non-external-literal>) is forbidden; use router.push");
      }
    }
    {
      const re = /\blocation\.assign\s*\(\s*(?![`'"]https?:\/\/)/g;
      if (re.test(stripped)) {
        recordViolation(file, "location.assign(<non-external-literal>) is forbidden; use router.push");
      }
    }
    {
      const re = /(?<!popup\.)\blocation\.replace\s*\(\s*(?![`'"]https?:\/\/)/g;
      if (re.test(stripped)) {
        recordViolation(file, "location.replace(<non-external-literal>) is forbidden; use router.push");
      }
    }

    // 抑制未使用变量告警（EXTERNAL_LITERAL 保留以备未来扩展）
    void EXTERNAL_LITERAL;
  }
}

if (violations.length > 0) {
  console.error("Boundary violations:");
  for (const v of violations) console.error(`- ${v}`);
  process.exit(1);
}

console.log("Plugin boundaries are clean.");
// 抑制未使用变量告警（sep 偶尔在调试时使用）
void sep;
