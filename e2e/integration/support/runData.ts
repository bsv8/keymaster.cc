import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeIdentifier, createRunId, currentRunId } from "./ids.js";

/**
 * E2E 运行数据规范。
 *
 * 仓库内 `e2e/runs/<执行档>/<run-id>/{state,logs,artifacts}` 保存一轮运行产生的
 * 非秘密数据；该目录不进入 git，可以按轮或按执行档整体删除。仓库外的
 * `~/.config/keymaster-e2e/` 只保留秘密配置（s3.json 等），两者不混用。
 *
 * 设计缘由：一次 Playwright 命令 = 一轮（setup → journeys → teardown，同一个
 * run_id）。跨轮恢复数据已随 key01 固定钱包 + 手工归集脚本移除，因此这里
 * 不再有“比一轮活得久”的分区。
 */

/** 运行数据种类：机器读取的状态、文本日志、Playwright 产物（失败现场/附件）。 */
export type E2ERunDataKind = "state" | "logs" | "artifacts";

const here = path.dirname(fileURLToPath(import.meta.url));

/** `e2e/runs` 根目录；可用 KEYMASTER_E2E_RUN_DATA_DIR 覆盖（测试/CI 隔离用）。 */
export function runDataRoot(): string {
  const configured = process.env.KEYMASTER_E2E_RUN_DATA_DIR?.trim();
  return configured ? path.resolve(configured) : path.resolve(here, "..", "..", "runs");
}

function assertKind(kind: string): E2ERunDataKind {
  if (kind !== "state" && kind !== "logs" && kind !== "artifacts") throw new Error(`run data kind is invalid: ${kind}`);
  return kind;
}

/** 本轮某执行档的运行数据子目录（不创建）。 */
export function runDataDirectory(suite: string, kind: E2ERunDataKind): string {
  return path.join(runDataRoot(), assertSafeIdentifier(suite, "run data suite"), currentRunId(), assertKind(kind));
}

/** 本轮某执行档运行数据下的文件路径；文件名不允许包含路径分隔符。 */
export function runDataPath(suite: string, kind: E2ERunDataKind, filename: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(filename)) throw new Error("run data filename is invalid");
  return path.join(runDataDirectory(suite, kind), filename);
}

/** 创建并返回本轮运行数据子目录；目录权限不宽于 0700。 */
export async function ensureRunDataDirectory(suite: string, kind: E2ERunDataKind): Promise<string> {
  const directory = runDataDirectory(suite, kind);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

/**
 * Playwright config 专用：为整个执行档固定一个 run_id 并返回产物目录。
 *
 * 必须固定而不是各进程自己生成：config 会被 runner 和每个 worker 分别加载，
 * 如果各自 createRunId，setup 写的状态和 Journey/teardown 读的目录就会分叉。
 * 这里在 config 顶层写一次环境变量，worker 继承后 `currentRunId()` 得到同一个值。
 */
export function configureRunSuite(suite: string): { readonly runId: string; readonly outputDir: string } {
  const safeSuite = assertSafeIdentifier(suite, "run data suite");
  const existing = process.env.KEYMASTER_E2E_RUN_ID?.trim();
  const runId = existing ? assertSafeIdentifier(existing, "KEYMASTER_E2E_RUN_ID") : createRunId(safeSuite);
  process.env.KEYMASTER_E2E_RUN_ID = runId;
  return { runId, outputDir: runDataDirectory(safeSuite, "artifacts") };
}
