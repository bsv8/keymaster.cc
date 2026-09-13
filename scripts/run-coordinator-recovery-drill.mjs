// 目标部署 Coordinator 恢复演练启动器。
//
// 没有目标地址时直接失败；本地 Vitest/Chromium 结果不能替代生产
// SharedWorker 崩溃、供应商未知结果和人工 retry 的现场证据。

import { spawnSync } from "node:child_process";

const url = process.env.KEYMASTER_RECOVERY_DRILL_URL;
const errors = [];
if (!url) errors.push("KEYMASTER_RECOVERY_DRILL_URL（目标部署恢复验收页）");
if (!/^[0-9a-f]{40}-[0-9a-f]{16}$/iu.test(process.env.KEYMASTER_DEPLOYED_BUILD_ID ?? "")) {
  errors.push("KEYMASTER_DEPLOYED_BUILD_ID（目标部署不可变构建标识）");
}
if (url) {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) || /<[^>]+>/u.test(url)) {
      errors.push("KEYMASTER_RECOVERY_DRILL_URL 必须是非本机真实部署地址");
    }
  } catch {
    errors.push("KEYMASTER_RECOVERY_DRILL_URL 必须是有效 http(s) 地址");
  }
}

if (errors.length > 0) {
  console.error("缺少 Coordinator 恢复演练参数：");
  for (const error of errors) console.error("- " + error);
  console.error("目标验收页还必须注入 __KEYMASTER_COORDINATOR_RECOVERY_DRILL__ runner。");
  process.exitCode = 1;
} else {
  const result = spawnSync(
    "pnpm",
    ["exec", "playwright", "test", "--config=playwright.deployment.config.ts", "--project=deployment-acceptance", "e2e/integration/gates/deployment/plugin-lifecycle-recovery.spec.ts"],
    { stdio: "inherit", env: process.env },
  );
  process.exitCode = result.status ?? 1;
}
