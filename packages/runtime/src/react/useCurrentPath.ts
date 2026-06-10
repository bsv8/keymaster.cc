// packages/runtime/src/react/useCurrentPath.ts
// 响应式 pathname hook。
//
// 设计缘由：`navigateTo` 跳路由时通过本地订阅器（subscribePath）通知
// 监听方，所以所有"想知道当前 path"的 React 组件只要订阅这个 hook 就能
// 自动重渲染。Sidebar 早期直接在 render 里调 `router.currentPath()`，结果
// 路由变了菜单 active 状态不刷新——这就是抽这个 hook 的原因。
//
// 之前版本完全依赖 `popstate` 事件，Vite HMR / React 18 严格模式下
// 偶发丢事件，所以现在改成走 `subscribePath`（navigateTo 直接派发），
// popstate 仅作为浏览器前进/后退的兜底。

import { useEffect, useState } from "react";
import { currentPath, subscribePath } from "../navigate.js";

export function useCurrentPath(): string {
  const [path, setPath] = useState(() => currentPath());
  useEffect(() => {
    const onChange = () => setPath(currentPath());
    const unsubscribe = subscribePath(onChange);
    // 浏览器前进/后退：popstate 由 navigateTo 在 window 上统一派发。
    window.addEventListener("popstate", onChange);
    return () => {
      unsubscribe();
      window.removeEventListener("popstate", onChange);
    };
  }, []);
  return path;
}
