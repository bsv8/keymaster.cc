// 仅供真实 Chromium Gate 模拟“旧版本根作用域 SW 控制页面”。
// 它故意不响应 MSFile 媒体协议，媒体代码必须通过 register + probe 替换它。
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", () => undefined);
