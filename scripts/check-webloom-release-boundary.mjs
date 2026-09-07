// WebLoom 正式发布切换门禁。
//
// Keymaster 发布前必须使用 npm 上已发布的 webloom-framework 精确版本；本脚本
// 故意不加入 lint:boundaries，由 CI/发布批次显式执行 `pnpm lint:webloom-release`。

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const packageRoots = [join(root, "apps"), join(root, "packages")];
const packageName = "webloom-framework";
const releaseVersion = "0.1.0";
const violations = [];

function packageFiles(directory) {
  if (!existsSync(directory)) return [];
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (!entry.isDirectory()) return entry.name === "package.json" ? [path] : [];
    return packageFiles(path);
  });
}

for (const path of packageRoots.flatMap(packageFiles)) {
  const packageData = JSON.parse(readFileSync(path, "utf8"));
  const dependencySections = [packageData.dependencies, packageData.devDependencies, packageData.peerDependencies];
  if (dependencySections.some((section) => section && Object.hasOwn(section, "webloom"))) {
    violations.push(`${path}: 禁止使用旧的 webloom 依赖名，必须统一为 ${packageName}`);
  }
  const declared = dependencySections
    .map((section) => section?.[packageName])
    .find((value) => value !== undefined);
  if (declared === undefined) continue;
  if (typeof declared !== "string" || !/^\d+\.\d+\.\d+$/u.test(declared) || declared !== releaseVersion) {
    violations.push(`${path}: ${packageName} 必须使用已发布的精确版本 ${releaseVersion}，当前为 ${String(declared)}`);
  }
}

const lockfile = join(root, "pnpm-lock.yaml");
if (existsSync(lockfile)) {
  const text = readFileSync(lockfile, "utf8");
  if (/\bwebloom(?=[:@/])/u.test(text)) {
    violations.push(`${lockfile}: 禁止发布 lockfile 中的旧 webloom 包名`);
  }
  for (const [index, line] of text.split("\n").entries()) {
    // pnpm v9+ 将依赖名、specifier 和 version 分成多行；逐行拒绝所有本地
    // link/file/workspace/绝对路径，不能只检查旧的 `webloom: link:...` 格式。
    if (/(?:specifier|version):\s+(?:link:|file:|workspace:)[^\n]*WebLoom|\/home\/[^\s]*WebLoom|(?:link:|file:|workspace:)[^\n]*WebLoom/u.test(line)) {
      violations.push(`${lockfile}:${index + 1}: 禁止发布 lockfile 中的本地 WebLoom 依赖`);
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("WebLoom release boundary passed");
}
