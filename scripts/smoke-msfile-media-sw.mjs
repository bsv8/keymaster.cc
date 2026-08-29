const rawOrigin = process.env.MSFILE_MEDIA_DEPLOYMENT_ORIGIN?.trim();
if (!rawOrigin) {
  throw new Error("请设置 MSFILE_MEDIA_DEPLOYMENT_ORIGIN，例如 https://keymaster.example.com");
}

const origin = new URL(rawOrigin);
origin.pathname = origin.pathname.replace(/\/+$/u, "");
const url = new URL(`${origin.pathname}/msfile-media-sw.js`, origin);
const response = await fetch(url, { redirect: "manual" });
const body = await response.text();
const contentType = response.headers.get("content-type") ?? "";
const serviceWorkerAllowed = response.headers.get("service-worker-allowed") ?? "";
const cacheControl = response.headers.get("cache-control") ?? "";
const isHtml = /<html|<!doctype/iu.test(body);

const failures = [];
if (response.status !== 200) failures.push(`HTTP status=${response.status}`);
if (!/^application\/javascript\b/iu.test(contentType)) failures.push(`Content-Type=${contentType || "<missing>"}`);
if (serviceWorkerAllowed !== "/") failures.push(`Service-Worker-Allowed=${serviceWorkerAllowed || "<missing>"}`);
if (!/\bno-cache\b/iu.test(cacheControl)) failures.push(`Cache-Control=${cacheControl || "<missing>"}`);
if (isHtml) failures.push("响应是 SPA HTML fallback");
if (!body.includes("msfile-media")) failures.push("响应不是媒体 Service Worker 脚本");

console.log(JSON.stringify({
  event: "msfile_media_sw_deployment_smoke",
  url: url.href,
  status: response.status,
  contentType,
  serviceWorkerAllowed,
  cacheControl,
  isHtml,
  passed: failures.length === 0,
}));

if (failures.length > 0) {
  throw new Error(`媒体 Service Worker 部署 smoke 失败：${failures.join("；")}`);
}
