// apps/web/src/shell/Sidebar.tsx
// 侧边栏：菜单只来自 menu.registry。
// 设计缘由：shell 不硬编码任何业务菜单。
// 窄屏下作为抽屉式 overlay：AppShell 持有开关状态，
// 路由切换后通过 props.onClose 收起，避免抽屉遮住新页面。
//
// 硬切换 003：菜单项 label 是 I18nText；渲染时调用 host.i18n.text() 解析。
// group 当前仅作分类键，不直接展示。
//
// 抽屉关闭时用 inert（不是 aria-hidden）隐藏子树：aria-hidden 不会把焦点
// 移开，会留下"焦点在 aria-hidden 祖先里"的 a11y 警告；inert 同步把整棵
// 子树设为不可聚焦、不可交互，浏览器会把焦点自动挪到下一个可见元素。
// inert 只在窄屏（<= 1024px，匹配 CSS 抽屉断点）应用——桌面端侧栏永远
// 可见，不该被 inert。

import { useEffect, useState } from "react";
import { useCurrentPath, useI18n, usePluginHost, useRuntimeStatus } from "@keymaster/runtime";
import type { MenuItem } from "@keymaster/contracts";
import { router } from "./RouteRenderer.js";

export interface SidebarProps {
  mobileOpen: boolean;
  onClose: () => void;
}

function useIsNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 1024px)");
    const update = () => setNarrow(mql.matches);
    update();
    // Safari < 14 用 addListener；现代浏览器 addEventListener。
    if (mql.addEventListener) {
      mql.addEventListener("change", update);
      return () => mql.removeEventListener("change", update);
    }
    mql.addListener(update);
    return () => mql.removeListener(update);
  }, []);
  return narrow;
}

export function Sidebar({ mobileOpen, onClose }: SidebarProps) {
  const host = usePluginHost();
  const { vault } = useRuntimeStatus();
  const i18n = useI18n();
  // 触发 languageChanged 重渲染；这样切语言后菜单 label 立即重解析。
  i18n.language();
  const isNarrow = useIsNarrowViewport();
  // 响应式 pathname：路由一变（router.push / 浏览器前进后退）就重渲染，
  // 菜单 is-active 才会跟着切到新条目。
  const currentPath = useCurrentPath();
  const items = host.menus
    .list()
    .filter((m: MenuItem) => (m.visibleWhen ? m.visibleWhen({ unlocked: vault === "unlocked" }) : true));

  // 按 group 分组。
  const groups = new Map<string, MenuItem[]>();
  for (const item of items) {
    const arr = groups.get(item.group) ?? [];
    arr.push(item);
    groups.set(item.group, arr);
  }

  // 仅窄屏 + 抽屉关闭时 inert；桌面端侧栏永远可见、可交互。
  const shouldInert = isNarrow && !mobileOpen;

  return (
    <aside
      className={`app-sidebar ${mobileOpen ? "is-open" : ""}`}
      // React 18 的 HTMLAttributes 类型里没有 inert；用条件 spread 绕过，
      // 渲染为原生 <aside inert=""> / <aside>。
      {...(shouldInert ? { inert: "" as unknown as boolean } : {})}
    >
      {[...groups.entries()].map(([group, list]) => (
        <div key={group} className="app-sidebar__group">
          <h4>{group}</h4>
          <ul>
            {list.map((item) => {
              const route = item.routeId ? host.routes.byId(item.routeId) : undefined;
              const path = item.path ?? route?.path;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => {
                      if (path) router.push(path);
                      // 窄屏：点击菜单后自动收起抽屉
                      onClose();
                    }}
                    className={`app-sidebar__item ${path && currentPath === path ? "is-active" : ""}`}
                  >
                    {host.i18n.text(item.label)}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </aside>
  );
}
