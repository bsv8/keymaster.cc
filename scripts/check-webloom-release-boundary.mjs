// WebLoom 正式发布切换门禁。
//
// Keymaster 发布前必须使用 npm 上已发布的 webloom-framework 精确版本；本脚本
// 故意不加入 lint:boundaries，由 CI/发布批次显式执行 `pnpm lint:webloom-release`。

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = process.cwd();
const packageRoots = [join(root, "apps"), join(root, "packages")];
const packageName = "webloom-framework";
const releaseVersion = "0.4.0";
const registry = process.env.WEBLOOM_NPM_REGISTRY ?? process.env.npm_config_registry ?? "https://registry.npmjs.org/";
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

  const resolution = text.match(new RegExp(`^  ${packageName}@${releaseVersion}:\\n    resolution: \\{integrity: ([^,}]+)`, "mu"))?.[1];
  if (!resolution) {
    violations.push(`${lockfile}: 缺少 ${packageName}@${releaseVersion} 的 frozen registry integrity`);
  } else {
    const npmView = (field) => {
      const result = spawnSync("npm", [
        "view",
        `${packageName}@${releaseVersion}`,
        field,
        "--json",
        "--registry",
        registry,
      ], { encoding: "utf8" });
      if (result.status !== 0) {
        const detail = String(result.stderr ?? result.stdout ?? "").trim().replace(/\s+/gu, " ");
        throw new Error(detail || `npm view exited with ${String(result.status)}`);
      }
      const raw = String(result.stdout ?? "").trim();
      try { return JSON.parse(raw); } catch { return raw; }
    };

    try {
      const publishedVersion = npmView("version");
      if (publishedVersion !== releaseVersion) {
        violations.push(`${packageName}@${releaseVersion}: registry ${registry} 返回版本 ${String(publishedVersion)}`);
      }
      const publishedIntegrity = npmView("dist.integrity");
      if (publishedIntegrity !== resolution) {
        violations.push(`${packageName}@${releaseVersion}: lockfile integrity 与 registry dist.integrity 不一致`);
      }
      const publishedTarball = npmView("dist.tarball");
      if (typeof publishedTarball !== "string" || !/^https?:\/\//u.test(publishedTarball)) {
        violations.push(`${packageName}@${releaseVersion}: registry dist.tarball 不是公开 HTTP(S) 地址`);
      }
    } catch (error) {
      violations.push(`${packageName}@${releaseVersion}: registry 发布门禁失败（${registry}）：${error.message}`);
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("WebLoom release boundary passed");
}
