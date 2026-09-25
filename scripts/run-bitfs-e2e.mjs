#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function fail(message) {
  console.error(`[bitfs-e2e] ${message}`);
  process.exit(1);
}

const repositoryDir = process.env.SATS_SUBSCRIPTION_DIR?.trim();
if (!repositoryDir) fail("必须设置 SATS_SUBSCRIPTION_DIR 指向 SatSubscription 仓库根目录");
if (!fs.existsSync(path.join(repositoryDir, "cmd/satsubscription/main.go"))) fail(`SATS_SUBSCRIPTION_DIR 不是有效仓库：缺少 ${path.join(repositoryDir, "cmd/satsubscription/main.go")}`);

function resolveGo() {
  if (process.env.SAT_SUBSCRIPTION_GO?.trim()) return process.env.SAT_SUBSCRIPTION_GO.trim();
  if (spawnSync("go", ["version"], { stdio: "ignore" }).status === 0) return "go";
  const mise = spawnSync("mise", ["which", "go"], { encoding: "utf8" });
  if (mise.status === 0 && mise.stdout.trim()) return mise.stdout.trim();
  return undefined;
}

const go = resolveGo();
if (!go) fail("找不到 Go：设置 SAT_SUBSCRIPTION_GO，或把 go 加入 PATH");
const pgConfig = spawnSync("pg_config", ["--bindir"], { encoding: "utf8" });
const pgBin = process.env.SAT_SUBSCRIPTION_PG_BIN?.trim() || (pgConfig.status === 0 ? pgConfig.stdout.trim() : "");
if (!pgBin || !fs.existsSync(path.join(pgBin, "initdb"))) fail("找不到 PostgreSQL initdb：设置 SAT_SUBSCRIPTION_PG_BIN，或让 pg_config 可用");

const env = { ...process.env, SATS_SUBSCRIPTION_DIR: repositoryDir, SAT_SUBSCRIPTION_GO: go, SAT_SUBSCRIPTION_PG_BIN: pgBin };
const args = ["playwright", "test", "--config=e2e/playwright.bitfs.config.ts", "--project=bitfs", ...process.argv.slice(2)];
const configuredTimeout = Number(process.env.BITFS_E2E_TIMEOUT_MS ?? 1_860_000);
if (!Number.isSafeInteger(configuredTimeout) || configuredTimeout <= 0) fail("BITFS_E2E_TIMEOUT_MS 必须是正整数毫秒数");
const detached = process.platform !== "win32";
const child = spawn("npx", args, { stdio: "inherit", env, detached });
let timedOut = false;
let forceKillTimer;
const terminate = (signal) => {
  if (!child.pid) return;
  try {
    if (detached) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
};
const timeoutTimer = setTimeout(() => {
  timedOut = true;
  console.error(`[bitfs-e2e] 外部超时 ${configuredTimeout}ms，强制终止测试进程`);
  terminate("SIGTERM");
  forceKillTimer = setTimeout(() => terminate("SIGKILL"), 10_000);
}, configuredTimeout);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => terminate(signal));
}
child.once("error", (error) => {
  clearTimeout(timeoutTimer);
  if (forceKillTimer) clearTimeout(forceKillTimer);
  console.error(`[bitfs-e2e] 无法启动 Playwright：${error.message}`);
  process.exitCode = 1;
});
child.once("close", (code, signal) => {
  clearTimeout(timeoutTimer);
  if (forceKillTimer) clearTimeout(forceKillTimer);
  process.exitCode = timedOut ? 124 : code ?? (signal ? 1 : 1);
});
