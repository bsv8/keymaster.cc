// packages/runtime/src/navigate.ts
// SPA 导航 helper：唯一允许的"跳到 pathname"路径。
// 设计缘由：
//   - 之前 `apps/web/src/shell/RouteRenderer.tsx` 与
//     `packages/plugin-vault/src/VaultSettingsPage.tsx` 各写了一份
//     `history.pushState + popstate` 逻辑，重复实现容易再次出现
//     `<a href>` 绕过 SPA 的问题。
//   - 集中到 runtime 包后，shell 与所有 plugin 都从同一处拿"正确
//     的 SPA 跳转"。<a> 默认会被浏览器当作普通链接（刷新页面，
//     丢失 in-memory Vault 会话），不能直接用。
//   - 非浏览器环境（SSR / 测试）静默 no-op；调用方不需要再做
//     `typeof window === "undefined"` 判断。
//
// 通知机制：直接用本地订阅器派发，popstate 只作为"浏览器前进/后退"的
// 兜底。早期版本完全依赖 `dispatchEvent(new PopStateEvent(...))`，
// 在 Vite HMR 或 React 严格模式下偶尔丢事件，导致菜单 active 不刷新。

export type PathListener = (path: string) => void;

const pathListeners = new Set<PathListener>();

/** 读取当前 pathname。SSR / 测试中退回 "/"。 */
export function currentPath(): string {
  if (typeof window === "undefined") return "/";
  return window.location.pathname || "/";
}

/** 订阅 pathname 变化；返回 unsubscribe。 */
export function subscribePath(listener: PathListener): () => void {
  pathListeners.add(listener);
  return () => {
    pathListeners.delete(listener);
  };
}

function notifyPathChange(): void {
  const path = currentPath();
  for (const listener of pathListeners) {
    try {
      listener(path);
    } catch (err) {
      // 单个订阅者抛错不能影响其他订阅者
      // eslint-disable-next-line no-console
      console.error("[navigate] path listener threw", err);
    }
  }
}

/**
 * 跳到内部 pathname。
 *
 * 与 `window.location.assign(path)` / `<a href>` 的差别：
 *   - 不会触发整页 reload，Vault 内存会话不丢。
 *   - 直接通知本地订阅者（RouteRenderer / Breadcrumbs / Sidebar）。
 *   - 当前已经在目标 path 时直接 no-op，避免无意义 history 条目。
 */
export function navigateTo(path: string): void {
  if (typeof window === "undefined") return;
  if (typeof window.history === "undefined") return;
  if (window.location.pathname === path) return;
  window.history.pushState({}, "", path);
  notifyPathChange();
}

// 浏览器前进/后退：派发 popstate 后由 useCurrentPath 兜底订阅。
if (typeof window !== "undefined") {
  window.addEventListener("popstate", notifyPathChange);
}

/** shell / 命令面板 / 顶栏菜单等用的统一 router 对象。 */
export const router = {
  push: navigateTo,
  currentPath
};
