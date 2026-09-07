// 目标部署不可逆 I/O smoke 启动器。
//
// 目标页面和供应商故障注入由部署环境提供；缺少目标地址时直接失败，
// 不把 Playwright skip 或本地测试结果当成生产验收。

import { spawnSync } from "node:child_process";

const url = process.env.KEYMASTER_IRREVERSIBLE_IO_SMOKE_URL;
const missing = [];
if (!url) missing.push("KEYMASTER_IRREVERSIBLE_IO_SMOKE_URL（目标部署验收页）");
if (!/^[0-9a-f]{40}-[0-9a-f]{16}$/iu.test(process.env.KEYMASTER_DEPLOYED_BUILD_ID ?? "")) {
  missing.push("KEYMASTER_DEPLOYED_BUILD_ID（目标部署不可变构建标识）");
}
if (url) {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) || /<[^>]+>/u.test(url)) {
      missing.push("KEYMASTER_IRREVERSIBLE_IO_SMOKE_URL 必须是非本机真实部署地址");
    }
  } catch {
    missing.push("KEYMASTER_IRREVERSIBLE_IO_SMOKE_URL 必须是有效 http(s) 地址");
  }
}

if (missing.length > 0) {
  console.error("缺少不可逆 I/O 目标部署验收参数：");
  for (const item of missing) console.error("- " + item);
  console.error("目标验收页还必须注入 __KEYMASTER_IRREVERSIBLE_IO_SMOKE__ runner。");
  process.exitCode = 1;
} else {
  const result = spawnSync(
    "pnpm",
    ["exec", "playwright", "test", "e2e/plugin-lifecycle-irreversible-io.spec.ts", "-g", "目标部署完成不可逆 I/O smoke"],
    { stdio: "inherit", env: process.env },
  );
  process.exitCode = result.status ?? 1;
}
