// apps/web/src/shell/Sidebar.tsx
// 侧边栏：唯一菜单来源是 business.registry。
// 设计缘由：所有用户可见入口都通过业务域 / feature 声明，不保留 legacy 菜单投影。
// 窄屏下作为抽屉式 overlay：AppShell 持有开关状态，
// 路由切换后通过 props.onClose 收起，避免抽屉遮住新页面。
// 抽屉关闭时用 inert（不是 aria-hidden）隐藏子树：aria-hidden 不会把焦点
// 移开，会留下"焦点在 aria-hidden 祖先里"的 a11y 警告；inert 同步把整棵
// 子树设为不可聚焦、不可交互，浏览器会把焦点自动挪到下一个可见元素。
// inert 只在窄屏（<= 1024px，匹配 CSS 抽屉断点）应用——桌面端侧栏永远
// 可见，不该被 inert。

import { useEffect, useState } from "react";
import { BusinessNavigation } from "./BusinessNavigation.js";

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
  const isNarrow = useIsNarrowViewport();
  // 仅窄屏 + 抽屉关闭时 inert；桌面端侧栏永远可见、可交互。
  const shouldInert = isNarrow && !mobileOpen;

  return (
    <aside
      className={`app-sidebar ${mobileOpen ? "is-open" : ""}`}
      // React 18 的 HTMLAttributes 类型里没有 inert；用条件 spread 绕过，
      // 渲染为原生 <aside inert=""> / <aside>。
      {...(shouldInert ? { inert: "" as unknown as boolean } : {})}
    >
      <BusinessNavigation onClose={onClose} />
    </aside>
  );
}
