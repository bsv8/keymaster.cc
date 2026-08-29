// 真实 Go supplier E2E 的跨仓定位和版本校验。
// 不允许把开发机绝对路径写进测试；CI 必须显式提供固定 checkout。

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** MSFile-Proxy-Protocol 仓库根目录；由 shell/CI 提供。 */
export function requireMsFileProxyProtocolDir(): string {
  const directory = process.env.MSFILE_PROXY_PROTOCOL_DIR?.trim();
  if (!directory) {
    throw new Error(
      "真实 MSFile supplier E2E 必须设置 MSFILE_PROXY_PROTOCOL_DIR（MSFile-Proxy-Protocol 仓库根目录），不能使用本机默认路径",
    );
  }
  const root = resolve(directory);
  if (!existsSync(resolve(root, "labs/webrtc-go"))) {
    throw new Error(`MSFILE_PROXY_PROTOCOL_DIR 不是有效仓库：缺少 ${resolve(root, "labs/webrtc-go")}`);
  }
  return root;
}

export const MSFILE_PROXY_PROTOCOL_DIR = requireMsFileProxyProtocolDir();
export const MSFILE_GO_DIR = resolve(MSFILE_PROXY_PROTOCOL_DIR, "labs/webrtc-go");

/**
 * 校验 E2E 使用的 supplier checkout。开发机可暂不设置 commit，方便使用本地工作树；
 * CI 必须设置完整 commit，并且 checkout 必须干净，避免 Go 修复没有进入验收版本。
 */
export async function assertMsFileProxyProtocolCommit(): Promise<void> {
  const expected = process.env.MSFILE_PROXY_PROTOCOL_COMMIT?.trim();
  if (!expected) {
    if (process.env.CI) {
      throw new Error("CI 运行真实 MSFile supplier E2E 必须设置 MSFILE_PROXY_PROTOCOL_COMMIT（完整 commit SHA）");
    }
    return;
  }
  if (!/^[0-9a-f]{40}$/iu.test(expected)) {
    throw new Error("MSFILE_PROXY_PROTOCOL_COMMIT 必须是 40 位完整 commit SHA");
  }
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: MSFILE_PROXY_PROTOCOL_DIR });
  const actual = stdout.trim();
  if (actual !== expected) {
    throw new Error(`MSFile-Proxy-Protocol commit 不匹配：期望 ${expected}，实际 ${actual}`);
  }
  const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], { cwd: MSFILE_PROXY_PROTOCOL_DIR });
  if (status.trim()) {
    throw new Error("MSFile-Proxy-Protocol checkout 不干净；CI 不能用未提交的 Go supplier 修改做验收");
  }
}
