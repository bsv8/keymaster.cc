// apps/web 的 Service Worker 配置薄适配层。
//
// 媒体包不知道 Vite 开发服务器和生产产物的脚本位置；这里仅把脚本 URL
// 配置给通用 Range Host。生产脚本固定在站点根路径，才能申请 `/` scope。

import {
  configureMsFileMediaServiceWorker,
  ensureMsFileMediaServiceWorker,
  getMsFileRangeHost,
} from "@keymaster/msfile-media/browser";

const scriptUrl = import.meta.env.DEV
  ? "/src/msfileMediaServiceWorker.ts"
  : "/msfile-media-sw.js";

configureMsFileMediaServiceWorker({
  scriptUrl,
  scope: "/",
  timeoutMs: 5000,
});

// 每个受控页面都提前安装自己的 Range Host。这样 SW 在重启后仍可按
// FetchEvent.clientId 把请求转回对应页面；没有该 session 的页面会快速返回 404，
// 而不是让 SW 等待一个不存在的 MessageChannel 监听器直到超时。
getMsFileRangeHost();

/** 启动时预热；失败由媒体 session 再次报告并降级到下载。 */
export function prepareMsFileMediaServiceWorker(): Promise<void> {
  return ensureMsFileMediaServiceWorker();
}
