// apps/web/src/shell/AppShell.tsx
// 解锁后的统一布局：Topbar + Sidebar + Breadcrumbs + RouteRenderer。
// 设计缘由：shell 不写业务页面，只负责把"扩展点"按顺序渲染。
// 窄屏下侧边栏收起为抽屉式 overlay，AppShell 持有 mobileOpen 状态，
// 透传给 Topbar（汉堡按钮触发）和 Sidebar（开关 + 关闭）。

import { useState } from "react";
import { Breadcrumbs } from "./Breadcrumbs.js";
import { RouteRenderer } from "./RouteRenderer.js";
import { Sidebar } from "./Sidebar.js";
import { Topbar } from "./Topbar.js";

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className={`app-shell ${mobileOpen ? "is-mobile-nav-open" : ""}`}>
      <Topbar
        mobileOpen={mobileOpen}
        onToggleMobileNav={() => setMobileOpen((v) => !v)}
      />
      <div className="app-shell__body">
        <Sidebar mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />
        {mobileOpen ? (
          <button
            type="button"
            className="app-shell__backdrop"
            aria-label="关闭菜单"
            onClick={() => setMobileOpen(false)}
          />
        ) : null}
        <main className="app-shell__main">
          <Breadcrumbs />
          <RouteRenderer />
        </main>
      </div>
    </div>
  );
}
