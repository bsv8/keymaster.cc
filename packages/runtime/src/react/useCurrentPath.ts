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
//
// 硬切换 007：搜索 / 哈希变化也要触发重渲染。`navigateTo` 升级为支持完整
// path 后，pathname 没变但 search 变了的情况下，组件需要重新执行 render
// 才能读到新 search。React 18 的 `useState` 在值相同时不会触发重渲染，
// 所以这里用一个 nav version 计数器强制触发；path 不变时返回的字符串也
// 不变，调用方可以无脑 `useCurrentPath()` 拿 path 渲染，需要 search 的
// 页面自己读 `window.location.search`。

import { useEffect, useState } from "react";
import { currentPath, subscribePath } from "../navigate.js";

export function useCurrentPath(): string {
  const [state, setState] = useState<{ path: string; nav: number }>(() => ({
    path: currentPath(),
    nav: 0
  }));
  useEffect(() => {
    const onChange = () => {
      setState((prev) => {
        const next = currentPath();
        // path 不变也 bump nav，强制触发依赖方重渲染。
        return next === prev.path
          ? { path: prev.path, nav: prev.nav + 1 }
          : { path: next, nav: prev.nav + 1 };
      });
    };
    const unsubscribe = subscribePath(onChange);
    // 浏览器前进/后退：popstate 由 navigateTo 在 window 上统一派发。
    window.addEventListener("popstate", onChange);
    return () => {
      unsubscribe();
      window.removeEventListener("popstate", onChange);
    };
  }, []);
  return state.path;
}
