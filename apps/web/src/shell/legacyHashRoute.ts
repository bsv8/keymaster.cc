// apps/web/src/shell/legacyHashRoute.ts
// 旧 hash 路由迁移：早期版本以 "#/path" 形式提供内部导航。
// 应用启动前把这一类站内路径迁移到正式 pathname 路由。
//
// 设计缘由：
//   - 路由系统只读 window.location.pathname；保留 "#/settings/vault"
//     会让 RouteRenderer 看到 404。
//   - 必须在 React 挂载前完成迁移，否则首屏会闪一次 404。
//   - 仅迁移**站内**单斜杠开头的 hash 路径；普通 anchor (#section)、
//     协议 URL、跨站路径一律不动。
//   - 使用 history.replaceState 不新增浏览器历史记录、不触发重载。
//
// 硬切换 003：旧 hash "#/settings"（无后续段）映射到 "/settings/language"。
// 这是因为 /settings 聚合页已经删除，但应用启动时可能仍有旧入口残留在
// URL 或书签中；迁移目标必须是真实存在、稳定、不可被业务插件卸载的
// 系统级设置页。语言设置页正是这种真值。

const LEGACY_SETTINGS_REDIRECT = "/settings/language";

/**
 * 纯解析：把 pathname + hash 解析为可用的 pathname。
 * 返回 undefined 表示不迁移（解析失败 / 不是站内 hash 路径）。
 */
export function parseLegacyHashPath(pathname: string, hash: string): string | undefined {
  // 1) 只在根路径下考虑 hash 迁移；其它 pathname 不动。
  if (pathname !== "/" && pathname !== "") return undefined;
  // 2) hash 必须以 "#/" 开头，表示旧版本使用的 hash router 形式。
  if (!hash.startsWith("#/")) return undefined;
  // 3) 去掉 "#/" 后必须是站内单斜杠路径（以 "/" 开头）。
  const inner = hash.slice(1); // 保留前导 "/"
  if (!inner.startsWith("/")) return undefined;
  // 4) 拒绝双斜杠：意味着"//example.com"或空段，不应被当站内路径。
  if (inner.startsWith("//")) return undefined;
  // 5) 拒绝看起来像协议 URL 的形式（"//xxx" 已经在上一步挡掉；
  //    这里再挡掉 "/https://..." 这种 "/" 后紧跟协议头的情况）。
  if (/^\/[a-z][a-z0-9+.-]*:\/\//i.test(inner)) return undefined;
  // 6) 硬切换 003：旧 "#/settings"（聚合页）已不存在；迁移到语言设置页。
  if (inner === "/settings") return LEGACY_SETTINGS_REDIRECT;
  return inner;
}

/**
 * 浏览器副作用入口：检查 window.location，必要时执行 history.replaceState。
 * 返回是否发生迁移，便于测试与诊断。
 */
export function normalizeLegacyHashRoute(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.history === "undefined") return false;
  const { pathname, hash } = window.location;
  const target = parseLegacyHashPath(pathname, hash);
  if (!target) return false;
  if (pathname === target && !hash) return false;
  window.history.replaceState({}, "", target);
  return true;
}
