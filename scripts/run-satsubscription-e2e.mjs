#!/usr/bin/env node

/**
 * 真实 SatSubscription 本地 e2e 的辅助入口。
 *
 * 它只做外围依赖解析和 fail-closed 提示，然后把参数原样交给 Playwright。
 * 协议、数据库和供应商都由场景自己的 Resource 启动，本脚本不读取任何秘密。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function fail(message) {
  console.error(`[satsubscription-e2e] ${message}`);
  process.exit(1);
}

const repositoryDir = process.env.SATS_SUBSCRIPTION_DIR?.trim();
if (!repositoryDir) {
  fail("必须设置 SATS_SUBSCRIPTION_DIR 指向 SatSubscription 仓库根目录（含 cmd/satsubscription/main.go）");
}
if (!fs.existsSync(path.join(repositoryDir, "cmd/satsubscription/main.go"))) {
  fail(`SATS_SUBSCRIPTION_DIR 不是有效仓库：缺少 ${path.join(repositoryDir, "cmd/satsubscription/main.go")}`);
}

/** Go 解析顺序：显式环境变量 → PATH → mise shim；都不存在时给出可执行提示。 */
function resolveGo() {
  if (process.env.SAT_SUBSCRIPTION_GO?.trim()) return process.env.SAT_SUBSCRIPTION_GO.trim();
  if (spawnSync("go", ["version"], { stdio: "ignore" }).status === 0) return "go";
  const mise = spawnSync("mise", ["which", "go"], { encoding: "utf8" });
  if (mise.status === 0 && mise.stdout.trim()) return mise.stdout.trim();
  return undefined;
}

const go = resolveGo();
if (!go) {
  fail("找不到 Go：设置 SAT_SUBSCRIPTION_GO，或把 go 加入 PATH，或启用 mise（例如 PATH=\"$HOME/.local/share/mise/shims:$PATH\"）");
}

const pgConfig = spawnSync("pg_config", ["--bindir"], { encoding: "utf8" });
const pgBin = process.env.SAT_SUBSCRIPTION_PG_BIN?.trim() || (pgConfig.status === 0 ? pgConfig.stdout.trim() : "");
if (!pgBin || !fs.existsSync(path.join(pgBin, "initdb"))) {
  fail("找不到 PostgreSQL initdb：设置 SAT_SUBSCRIPTION_PG_BIN，或让 pg_config 可用");
}

const env = {
  ...process.env,
  SATS_SUBSCRIPTION_DIR: repositoryDir,
  SAT_SUBSCRIPTION_GO: go,
  SAT_SUBSCRIPTION_PG_BIN: pgBin,
};

const forwarded = process.argv.slice(2);
// 直接用 npx 调用本地 Playwright，避免 pnpm 在运行脚本前触发依赖状态检查
// （新发布的依赖会触发 minimumReleaseAge 供应链校验）。
const args = [
  "playwright",
  "test",
  "--config=playwright.satsubscription.config.ts",
  "--project=satsubscription",
  ...forwarded,
];
const result = spawnSync("npx", args, { stdio: "inherit", env });
process.exit(result.status ?? 1);
