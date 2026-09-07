// 插件生命周期发布身份工具。
//
// buildId = 完整 Git commit + 当前已跟踪源码树摘要。
// 它不是可手填的版本号：正式证据生成前必须确认工作区没有修改或未跟踪
// 文件，避免“证据写的是 HEAD、实际测试的是另一份代码”。

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function gitOutput(args, cwd = process.cwd()) {
  const result = await execFileAsync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return result.stdout.trim();
}

export async function gitStatus(cwd = process.cwd()) {
  return gitOutput(["status", "--porcelain=v1", "--untracked-files=all"], cwd);
}

export function isBuildId(value) {
  return typeof value === "string" && /^[0-9a-f]{40}-[0-9a-f]{16}$/iu.test(value);
}

export async function computeBuildIdentity({ cwd = process.cwd(), requireClean = true } = {}) {
  const status = await gitStatus(cwd);
  if (requireClean && status.length > 0) {
    throw new Error("当前工作区不是 clean；禁止生成正式插件生命周期证据。请先按 KMP 工单拆分并提交代码，再在 CI 生成证据。");
  }

  const commit = await gitOutput(["rev-parse", "HEAD"], cwd);
  if (!/^[0-9a-f]{40}$/iu.test(commit)) throw new Error("无法读取完整 Git commit hash");
  const files = (await execFileAsync("git", ["ls-files", "-z"], { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout
    .split("\0")
    .filter(Boolean)
    .sort();
  const digest = createHash("sha256");
  for (const file of files) {
    const bytes = await readFile(resolve(cwd, file));
    // 文件名也纳入摘要，避免内容相同但路径发生移动时身份不变。
    digest.update(file);
    digest.update("\0");
    digest.update(bytes);
    digest.update("\0");
  }
  const sourceDigest = digest.digest("hex");
  const buildId = `${commit}-${sourceDigest.slice(0, 16)}`;
  return { commit, sourceDigest, buildId, status };
}
