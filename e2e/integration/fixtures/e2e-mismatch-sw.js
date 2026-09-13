// 仅供 R19 协议兼容性 Gate 使用。
// 该 worker 故意返回未知协议版本；页面必须 fail closed，不能安装媒体 URL。
const MISMATCHED_PROTOCOL_VERSION = 999;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("message", (event) => {
  const message = event.data;
  const port = event.ports?.[0];
  if (!port || message?.type !== "msfile-media-protocol-probe") return;
  port.postMessage({
    type: "msfile-media-protocol-probe-result",
    version: MISMATCHED_PROTOCOL_VERSION,
    supported: false,
  });
});
