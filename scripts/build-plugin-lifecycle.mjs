// KMP-005：生成并绑定插件生命周期生产构建身份。
//
// 生产 Worker 只能从这里拿到 VITE_KEYMASTER_BUILD_ID。构建前后都校验源码树，
// 确保证据、部署产物和 Coordinator 使用同一份不可变身份；工作区不干净时直接
// 失败，不能用“当前 HEAD”冒充正在测试的代码。

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { computeBuildIdentity } from "./plugin-lifecycle-build-id.mjs";

const before = await computeBuildIdentity({ requireClean: true });
const env = {
  ...process.env,
  KEYMASTER_BUILD_ID: before.buildId,
  VITE_KEYMASTER_BUILD_ID: before.buildId,
};

const result = spawnSync("pnpm", ["build"], {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const after = await computeBuildIdentity({ requireClean: true });
if (after.buildId !== before.buildId) {
  throw new Error("构建期间源码树发生变化；拒绝发布与源码身份不一致的产物");
}

async function containsBuildId(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (await containsBuildId(path)) return true;
      continue;
    }
    try {
      const content = await readFile(path, "utf8");
      if (content.includes(before.buildId)) return true;
    } catch {
      // 二进制产物和无法按文本读取的文件不影响其它 bundle 检查。
    }
  }
  return false;
}

const distPath = resolve("apps/web/dist");
if (!(await containsBuildId(distPath))) {
  throw new Error(`生产产物未包含注入的 buildId：${before.buildId}`);
}

console.log(`已完成绑定 buildId 的生产构建：${before.buildId}`);
