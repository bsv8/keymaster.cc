// 正式 registry 0.4.2 生命周期验收：在临时副本中使用 frozen lockfile
// 安装 npm registry 包，再跑插件链和 Coordinator peer lifecycle 链。
// 该入口不读取当前工作区 node_modules，也不接受 workspace/file WebLoom。

import { cp, mkdtemp, readFile, realpath, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const registry = "https://registry.npmjs.org/";
const expectedVersion = "0.4.2";
const expectedIntegrity = "sha512-dC3EufZl5yCxaCmYVKX4GpGHVON8e5xx2GFiT7zCuLoQRPSBZtZqQ4brFb9qKNUKDQrwGl6Qrj+ZoZr4avWzWw==";
const manifestGateSelfTest = process.argv.includes("--manifest-gate-self-test");
const temporaryRoot = await mkdtemp(join(tmpdir(), "keymaster-webloom-registry-lifecycle-"));
const excludedDirectoryNames = new Set([
  ".git",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: temporaryRoot,
    stdio: "inherit",
    env: { ...process.env, npm_config_registry: registry },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${String(result.status)}`);
}

async function assertNoLocalWebLoom(path) {
  const resolved = await realpath(path);
  if (!resolved.startsWith(temporaryRoot) || resolved.includes("/Workspaces/WebLoom")) {
    throw new Error(`registry lifecycle resolved WebLoom outside the temporary npm install: ${resolved}`);
  }
}

async function collectPackageManifests(directory) {
  const manifests = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectoryNames.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      manifests.push(...await collectPackageManifests(path));
    } else if (entry.isFile() && entry.name === "package.json") {
      manifests.push(path);
    }
  }
  return manifests;
}

async function assertExactWebLoomManifestSpecifiers(manifestRoot) {
  const violations = [];
  const manifests = await collectPackageManifests(manifestRoot);
  for (const path of manifests) {
    const packageData = JSON.parse(await readFile(path, "utf8"));
    for (const sectionName of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      const section = packageData[sectionName];
      if (!section || typeof section !== "object" || !Object.hasOwn(section, "webloom-framework")) continue;
      const specifier = section["webloom-framework"];
      if (specifier !== expectedVersion) {
        violations.push(`${relative(manifestRoot, path)}:${sectionName}.webloom-framework 必须严格为 ${expectedVersion}，当前为 ${String(specifier)}`);
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(`registry lifecycle workspace manifest gate failed:\n${violations.join("\n")}`);
  }
}

async function runManifestGateSelfTest(manifestRoot) {
  const manifestPath = join(manifestRoot, "apps/web/package.json");
  const originalManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const specifier of ["file:/tmp/sdk.tgz", "link:"]) {
    await writeFile(manifestPath, `${JSON.stringify({
      ...originalManifest,
      dependencies: { ...originalManifest.dependencies, "webloom-framework": specifier },
    }, null, 2)}\n`);
    let rejected = false;
    try {
      await assertExactWebLoomManifestSpecifiers(manifestRoot);
    } catch (error) {
      rejected = error instanceof Error && error.message.includes(specifier);
    }
    if (!rejected) {
      throw new Error(`registry lifecycle manifest self-test did not reject ${specifier}`);
    }
  }
  console.log("registry lifecycle workspace manifest self-test passed: file:/tmp/sdk.tgz and link: rejected");
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

  if (manifestGateSelfTest) {
    await runManifestGateSelfTest(temporaryRoot);
  } else {
  const rootPackage = JSON.parse(await readFile(join(temporaryRoot, "package.json"), "utf8"));
  if (rootPackage.config?.webloomFrameworkReleaseVersion !== expectedVersion) {
    throw new Error(`正式 registry 验收要求 package.json 配置 ${expectedVersion}`);
  }
  // 先检查所有 workspace manifest，再安装；即使本地路径写成
  // file:/tmp/sdk.tgz（不含 WebLoom 字样）或 link:，也不能绕过 registry-only
  // 证明。该检查递归遍历临时副本，但不跟随 node_modules 等生成目录。
  await assertExactWebLoomManifestSpecifiers(temporaryRoot);
  const lockfile = await readFile(join(temporaryRoot, "pnpm-lock.yaml"), "utf8");
  const resolution = lockfile.match(new RegExp(`^  webloom-framework@${expectedVersion}:\\n    resolution: \\{integrity: ([^,}]+)`, "mu"))?.[1];
  if (resolution !== expectedIntegrity) {
    throw new Error(`lockfile 中 webloom-framework@${expectedVersion} integrity 不匹配：${String(resolution)}`);
  }
  if (/(?:specifier|version):\s+(?:link:|file:)[^\n]*WebLoom|\/home\/[^\s]*WebLoom/u.test(lockfile)) {
    throw new Error("registry lifecycle lockfile contains a local WebLoom path");
  }

  // frozen install 只接受提交态 lockfile；所有 WebLoom 依赖必须从官方 registry
  // 的完整性固定包解出，不允许临时改 manifest 绕过该约束。
  run("pnpm", ["install", "--frozen-lockfile", "--registry", registry]);
  const installed = join(temporaryRoot, "node_modules/webloom-framework");
  const installedManifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  if (installedManifest.version !== expectedVersion) {
    throw new Error(`registry lifecycle 实际安装版本错误：${String(installedManifest.version)}`);
  }
  await assertNoLocalWebLoom(installed);

  run("pnpm", ["typecheck"]);
  run("pnpm", ["typecheck:e2e"]);
  // registry 配置中的 webServer 还会执行 @keymaster/web 生产构建，随后
  // 用真实 Chromium 跑 plugin + Coordinator 两组生命周期用例。
  run("pnpm", ["exec", "playwright", "test", "--config=playwright.lifecycle.registry.config.ts", "--project=chromium-lifecycle-registry"]);
  console.log(`正式 registry WebLoom ${expectedVersion} 生命周期验收通过`);
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
