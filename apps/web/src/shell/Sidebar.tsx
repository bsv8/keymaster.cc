// apps/web/src/shell/Sidebar.tsx
// 侧边栏：菜单来自 menu.registry + settings.registry。
// 设计缘由：shell 不硬编码任何业务菜单。
// 窄屏下作为抽屉式 overlay：AppShell 持有开关状态，
// 路由切换后通过 props.onClose 收起，避免抽屉遮住新页面。
//
// 硬切换 003：菜单项 label 是 I18nText；渲染时调用 host.i18n.text() 解析。
// group 当前仅作分类键，不直接展示。
//
// settings 分组（硬切换 003）：直接由 host.settings.list() 渲染。
// 不再依赖 menu.registry 里的"settings"分组，避免与插件双注册产生的重复
// 入口并存。每个 settings 详情页自带 path / label / order / icon /
// visibleWhen，shell 按 order 排序、调用 visibleWhen({ unlocked }) 后渲染。
//
// 抽屉关闭时用 inert（不是 aria-hidden）隐藏子树：aria-hidden 不会把焦点
// 移开，会留下"焦点在 aria-hidden 祖先里"的 a11y 警告；inert 同步把整棵
// 子树设为不可聚焦、不可交互，浏览器会把焦点自动挪到下一个可见元素。
// inert 只在窄屏（<= 1024px，匹配 CSS 抽屉断点）应用——桌面端侧栏永远
// 可见，不该被 inert。

import { useEffect, useState } from "react";
import {
  useCurrentPath,
  useI18n,
  usePluginHost,
  useRegistry,
  useRuntimeStatus
} from "@keymaster/runtime";
import type { MenuItem, SettingsRoute } from "@keymaster/contracts";
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

const SETTINGS_GROUP = "settings";

interface SettingsMenuEntry {
  id: string;
  label: MenuItem["label"];
  path: string;
  order: number;
  icon?: string;
}

function buildSettingsEntries(
  routes: readonly SettingsRoute[],
  unlocked: boolean
): SettingsMenuEntry[] {
  return routes
    .filter((r) => (r.visibleWhen ? r.visibleWhen({ unlocked }) : true))
    .map((r) => ({
      id: `settings-route:${r.id}`,
      label: r.label,
      path: r.path,
      order: r.order,
      icon: r.icon
    }));
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
  const unlocked = vault === "unlocked";

  // 设计缘由：settings / menu 都必须跟随 host.version 热更新。
  // 这里统一走 useRegistry，避免像旧实现那样把 host 引用当成稳定依赖，
  // 导致 enable / disable 后 settings 分组菜单不重算。
  const menuItems = useRegistry((h) => h.menus.list())
    .filter((m: MenuItem) => (m.visibleWhen ? m.visibleWhen({ unlocked }) : true));
  const settingsRoutes = useRegistry((h) => h.settings.list());

  // 普通菜单 + settings 详情页合并：
  //   - 普通菜单来源：menu.registry，但需要剔除任何带 group="settings" 的菜单
  //     项——settings 分组由 settings.registry 单独渲染，避免双注册。
  //   - settings 分组：直接由 host.settings.list() 渲染。
  const regularItems = menuItems.filter((m) => m.group !== SETTINGS_GROUP);
  const settingsEntries = buildSettingsEntries(settingsRoutes, unlocked);

  // 按 group 分组：普通菜单按各自 group；settings 分组固定 group。
  const groups = new Map<string, Array<{ key: string; label: MenuItem["label"]; path?: string; icon?: string; order: number }>>();
  for (const item of regularItems) {
    const arr = groups.get(item.group) ?? [];
    arr.push({
      key: `menu:${item.id}`,
      label: item.label,
      path: item.path ?? (item.routeId ? host.routes.byId(item.routeId)?.path : undefined),
      icon: item.icon,
      order: item.order
    });
    groups.set(item.group, arr);
  }
  if (settingsEntries.length > 0) {
    groups.set(
      SETTINGS_GROUP,
      settingsEntries.map((entry) => ({
        key: entry.id,
        label: entry.label,
        path: entry.path,
        icon: entry.icon,
        order: entry.order
      }))
    );
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
          {/* 硬切换 003 + 施工单 2026-07-02 001：group 当前仅作分类键，
              展示文案走 i18n key `shell.menu.group.<id>`；未注册的
              group 退回原 id（fallback），保持向前兼容。 */}
          <h4>{host.i18n.text({ key: `shell.menu.group.${group}`, fallback: group })}</h4>
          <ul>
            {list.map((entry) => {
              const path = entry.path;
              return (
                <li key={entry.key}>
                  <button
                    type="button"
                    onClick={() => {
                      if (path) router.push(path);
                      // 窄屏：点击菜单后自动收起抽屉
                      onClose();
                    }}
                    className={`app-sidebar__item ${path && currentPath === path ? "is-active" : ""}`}
                  >
                    {host.i18n.text(entry.label)}
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
