// scripts/check-boundaries.mjs
// 插件/包边界检查：禁止跨越本应单向的依赖。
// 设计缘由：plugin-host 通过 capability/registry 协作；直接 import 互相依赖的包
// 会让边界立刻失效（也是这次硬切换的核心动机）。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.cwd();
const packagesDir = join(root, "packages");
const pluginNames = readdirSync(packagesDir).filter((name) => name.startsWith("plugin-"));
const violations = [];

/** 递归收集目录下所有 ts/tsx 源文件。 */
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

function recordViolation(file, detail) {
  violations.push(`${relative(root, file)} ${detail}`);
}

/** 检查 plugin-* 包之间互相 import。 */
for (const plugin of pluginNames) {
  const src = join(packagesDir, plugin, "src");
  for (const file of walk(src)) {
    const text = readFileSync(file, "utf8");
    for (const other of pluginNames) {
      if (other === plugin) continue;
      const pkg = `@keymaster/${other}`;
      const re = new RegExp(`(from\\s+['"]${pkg}|require\\(['"]${pkg})`);
      if (re.test(text)) {
        recordViolation(file, `imports ${pkg}`);
      }
    }
  }
}

/** 检查 plugin-assets 禁止 import 任何具体资产插件。 */
const assetsSrc = join(packagesDir, "plugin-assets", "src");
for (const file of walk(assetsSrc)) {
  const text = readFileSync(file, "utf8");
  if (/@keymaster\/plugin-p2pkh\b/.test(text)) {
    recordViolation(file, "plugin-assets must not import @keymaster/plugin-p2pkh");
  }
}

/** 检查 plugin-transfer 禁止 import 任何具体资产插件、vault、contacts。 */
const transferSrc = join(packagesDir, "plugin-transfer", "src");
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
for (const file of walk(wocSrc)) {
  const text = readFileSync(file, "utf8");
  if (/@keymaster\/plugin-p2pkh\b/.test(text)) {
    recordViolation(file, "plugin-woc must not import @keymaster/plugin-p2pkh");
  }
}

/** 检查 plugin-background 禁止 import plugin-p2pkh 或 plugin-woc。 */
const bgSrc = join(packagesDir, "plugin-background", "src");
for (const file of walk(bgSrc)) {
  const text = readFileSync(file, "utf8");
  for (const other of ["plugin-p2pkh", "plugin-woc"]) {
    const pkg = `@keymaster/${other}`;
    if (new RegExp(`(from\\s+['"]${pkg}|require\\(['"]${pkg})`).test(text)) {
      recordViolation(file, `plugin-background must not import ${pkg}`);
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
      recordViolation(file, `runtime must not import ${pkg}`);
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

if (violations.length > 0) {
  console.error("Boundary violations:");
  for (const v of violations) console.error(`- ${v}`);
  process.exit(1);
}

console.log("Plugin boundaries are clean.");
// 抑制未使用变量告警（sep 偶尔在调试时使用）
void sep;
