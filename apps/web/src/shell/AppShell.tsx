// apps/web/src/shell/AppShell.tsx
// 解锁后的统一布局：Topbar + Sidebar + Breadcrumbs + RouteRenderer。
// 设计缘由：shell 不写业务页面，只负责把"扩展点"按顺序渲染。
// 窄屏下侧边栏收起为抽屉式 overlay，AppShell 持有 mobileOpen 状态，
// 透传给 Topbar（汉堡按钮触发）和 Sidebar（开关 + 关闭）。
//
// 硬切换 009 收尾：AppShell 在挂载时订阅 vault 的
// `onInitialActivationNoticeChange` 事件，在主界面顶部展示一条
// "首 Key 已保存但未能自动设为 active"的提示横幅。这是修复
// 之前 messageBus 事件被错过的核心——notice 现在走可查询的
// vault state，新挂载的组件也能立即拿到当前值。

import { useEffect, useState } from "react";
import { Button } from "@keymaster/ui";
import { useCapability, useI18n } from "@keymaster/runtime";
import type {
  InitialActivationNotice,
  VaultService
} from "@keymaster/contracts";
import { Breadcrumbs } from "./Breadcrumbs.js";
import { RouteRenderer } from "./RouteRenderer.js";
import { Sidebar } from "./Sidebar.js";
import { Topbar } from "./Topbar.js";

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [activationNotice, setActivationNotice] =
    useState<InitialActivationNotice | null>(null);
  const vault = useCapability<VaultService>("vault.service");
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  useI18n().language();

  useEffect(() => {
    if (!vault || typeof vault.onInitialActivationNoticeChange !== "function") {
      return;
    }
    return vault.onInitialActivationNoticeChange((notice) => {
      setActivationNotice(notice);
    });
  }, [vault]);

  function dismissNotice() {
    if (vault && typeof vault.clearInitialActivationNotice === "function") {
      vault.clearInitialActivationNotice();
    }
    setActivationNotice(null);
  }

  return (
    <div className={`app-shell ${mobileOpen ? "is-mobile-nav-open" : ""}`}>
      <Topbar
        mobileOpen={mobileOpen}
        onToggleMobileNav={() => setMobileOpen((v) => !v)}
      />
      {activationNotice ? (
        <div className="app-shell__notice" role="status">
          <span>
            {t("shell.unlocked.notice.activationPending", {
              defaultValue:
                "首把 Key 已保存，但未能自动设为 active。请在 Key 管理中手动切换。"
            })}
            {activationNotice.label ? ` (${activationNotice.label})` : ""}
          </span>
          <Button variant="ghost" size="sm" onClick={dismissNotice}>
            {t("shell.unlocked.notice.dismiss", { defaultValue: "知道了" })}
          </Button>
        </div>
      ) : null}
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
