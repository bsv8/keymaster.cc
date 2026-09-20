// 在临时副本中用本地 WebLoom 0.5.0 tarball 跑严格 Chromium 生命周期验收。
// 这是源码/tarball 证据；正式 registry 0.5.0 证据由独立的
// run-registry-webloom-lifecycle.mjs 入口负责，二者不混用结果。

import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const tarball = resolve(process.env.WEBLOOM_LOCAL_TARBALL ?? "");
const tarballName = basename(tarball);
if (!/^webloom-framework-\d+\.\d+\.\d+\.tgz$/u.test(tarballName)) {
  throw new Error("WEBLOOM_LOCAL_TARBALL 必须指向 webloom-framework-x.y.z.tgz");
}
const tarballVersion = tarballName.slice("webloom-framework-".length, -".tgz".length);
if (tarballVersion !== "0.5.0") {
  throw new Error(`严格本地生命周期验收要求使用 WebLoom 0.5.0，当前为 ${tarballVersion}`);
}
const tarballStat = await stat(tarball).catch(() => undefined);
if (!tarballStat?.isFile()) throw new Error(`本地 WebLoom tarball 不存在：${tarball}`);

const temporaryRoot = await mkdtemp(join(tmpdir(), "keymaster-webloom-local-lifecycle-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: temporaryRoot,
    stdio: "inherit",
    env: { ...process.env, ...options.env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${String(result.status)}`);
}

async function workspacePackageFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ["node_modules", "dist", ".git"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === "package.json") files.push(path);
    else if (entry.isDirectory()) files.push(...await workspacePackageFiles(path));
  }
  return files;
}

async function rewriteWebLoomDependency(path) {
  const packageData = JSON.parse(await readFile(path, "utf8"));
  let changed = false;
  for (const sectionName of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const section = packageData[sectionName];
    if (!section || typeof section !== "object" || !Object.hasOwn(section, "webloom-framework")) continue;
    section["webloom-framework"] = `file:${tarball}`;
    changed = true;
  }
  if (changed) await writeFile(path, `${JSON.stringify(packageData, null, 2)}\n`, "utf8");
}

try {
  await cp(root, temporaryRoot, {
    recursive: true,
    filter(source) {
      const path = relative(root, source);
      const parts = path.split("/");
      return !parts.includes("node_modules")
        && !parts.includes("dist")
        && !parts.includes(".git")
        && !parts.includes("test-results")
        && !parts.includes("playwright-report");
    },
  });

  const packageFiles = [];
  for (const workspace of ["apps", "packages"]) {
    const path = join(temporaryRoot, workspace);
    packageFiles.push(...await workspacePackageFiles(path));
  }
  await Promise.all(packageFiles.map(rewriteWebLoomDependency));

  // 集成 tsconfig 位于仓库根目录，且其中的 gate 直接 import 这两个包；
  // 临时根 manifest 显式声明它们，避免 typecheck:e2e 依赖开发机遗留的
  // 根 node_modules 链接。WebLoom 仍明确从上面的 0.5.0 tarball 安装。
  const temporaryRootManifestPath = join(temporaryRoot, "package.json");
  const temporaryRootManifest = JSON.parse(await readFile(temporaryRootManifestPath, "utf8"));
  temporaryRootManifest.devDependencies = {
    ...temporaryRootManifest.devDependencies,
    "@keymaster/contracts": "workspace:*",
    "webloom-framework": `file:${tarball}`,
  };
  await writeFile(temporaryRootManifestPath, `${JSON.stringify(temporaryRootManifest, null, 2)}\n`, "utf8");

  // lockfile 只在临时副本中重算。WebLoom 以 file: tarball 注入；其余
  // workspace 依赖允许 pnpm 使用本地缓存，缓存缺少 metadata 时再从配置的
  // registry 补齐，不能因此把 WebLoom 解析回 registry 旧版本。
  run("pnpm", ["install", "--no-frozen-lockfile", "--prefer-offline"]);
  const installedManifestPath = join(temporaryRoot, "apps/web/node_modules/webloom-framework/package.json");
  const installedManifest = JSON.parse(await readFile(installedManifestPath, "utf8"));
  if (installedManifest.version !== tarballVersion) {
    throw new Error(`临时副本实际安装的 WebLoom 版本不是 0.5.0：${String(installedManifest.version)}`);
  }

  // 这些检查在临时副本中执行，确认 TypeScript 解析到已安装的 0.5.0
  // tarball，而不是依赖当前工作区的 node_modules 或 workspace symlink。
  run("pnpm", ["typecheck"]);
  run("pnpm", ["typecheck:e2e"]);
  // lifecycle 配置的 webServer 随后会执行 @keymaster/web 的生产 Vite
  // build；构建完成后才启动 preview 和真实 Chromium。
  run("pnpm", ["exec", "playwright", "test", "--config=playwright.lifecycle.config.ts", "--project=lifecycle-local"]);
  console.log(`严格本地 WebLoom ${tarballVersion} 生命周期验收通过`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
