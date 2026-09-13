// 已部署 AppView 的生产发布验收入口。
//
// 本地 fixture 测试不能证明真实部署 origin 的 CSP、静态资源缓存和
// postMessage origin 校验正常。因此这个脚本要求显式提供目标 origin 与
// 成功选择器；缺任一项都失败，不把“测试被跳过”误报成通过。

import { spawnSync } from "node:child_process";

const required = [
  ["KEYMASTER_E2E_DEPLOYMENT_BASE_URL", "已部署 Keymaster 目标地址"],
  ["KEYMASTER_EXTERNAL_APPVIEW_ORIGIN", "已部署 AppView origin"],
  ["KEYMASTER_EXTERNAL_APPVIEW_SUCCESS_SELECTOR", "AppView 成功状态选择器"],
  ["KEYMASTER_DEPLOYED_BUILD_ID", "目标部署注入的不可变 buildId"],
];
const missing = required.filter(([name]) => !process.env[name]);
if (missing.length === 0) {
  try {
    const target = new URL(process.env.KEYMASTER_E2E_DEPLOYMENT_BASE_URL);
    if (!["http:", "https:"].includes(target.protocol)
      || ["localhost", "127.0.0.1", "::1"].includes(target.hostname)
      || /<[^>]+>/u.test(target.toString())) {
      missing.push(["KEYMASTER_E2E_DEPLOYMENT_BASE_URL", "必须是非本机真实部署地址"]);
    }
  } catch {
    missing.push(["KEYMASTER_E2E_DEPLOYMENT_BASE_URL", "必须是有效 http(s) 部署地址"]);
  }
  try {
    const origin = new URL(process.env.KEYMASTER_EXTERNAL_APPVIEW_ORIGIN);
    if (!['http:', 'https:'].includes(origin.protocol) || ['localhost', '127.0.0.1', '::1'].includes(origin.hostname) || /<[^>]+>/u.test(origin.toString())) {
      missing.push(['KEYMASTER_EXTERNAL_APPVIEW_ORIGIN', '必须是非本机真实部署 origin']);
    }
  } catch {
    missing.push(['KEYMASTER_EXTERNAL_APPVIEW_ORIGIN', '必须是有效 http(s) origin']);
  }
  if (/<[^>]+>/u.test(process.env.KEYMASTER_EXTERNAL_APPVIEW_SUCCESS_SELECTOR)) {
    missing.push(['KEYMASTER_EXTERNAL_APPVIEW_SUCCESS_SELECTOR', '必须是实际成功状态选择器']);
  }
  if (!/^[0-9a-f]{40}-[0-9a-f]{16}$/iu.test(process.env.KEYMASTER_DEPLOYED_BUILD_ID ?? "")) {
    missing.push(['KEYMASTER_DEPLOYED_BUILD_ID', '必须是 commit(40位)-sourceDigest(16位) 的不可变构建标识']);
  }
}
if (missing.length > 0) {
  console.error("缺少已部署 AppView 验收参数：");
  for (const [name, label] of missing) console.error(`- ${name}：${label}`);
  console.error("示例：KEYMASTER_E2E_DEPLOYMENT_BASE_URL=https://keymaster.example KEYMASTER_DEPLOYED_BUILD_ID=<commit40>-<digest16> KEYMASTER_EXTERNAL_APPVIEW_ORIGIN=https://demo.apps.bsv8.com KEYMASTER_EXTERNAL_APPVIEW_SUCCESS_SELECTOR='[data-result=ok]' pnpm test:e2e:external");
  process.exitCode = 1;
} else {
  const result = spawnSync(
    "pnpm",
    ["exec", "playwright", "test", "--config=playwright.deployment.config.ts", "--project=deployment-acceptance", "e2e/integration/journeys/deployment/external-appview-connect.spec.ts"],
    { stdio: "inherit", env: process.env },
  );
  process.exitCode = result.status ?? 1;
}
