// apps/web/src/shell/Topbar.tsx
// 顶栏：品牌 + 主题切换 + 语言切换 + 锁定按钮 + 通过 topbar.registry 注册的扩展项。
// 设计缘由：Shell 不 import plugin-background；只渲染 topbar.registry。
// 主题切换 / 语言切换是 shell 层 UI 增强，与「系统主题」同性质，直接挂在这里。
// 窄屏下 brand 左侧出现汉堡按钮，由 AppShell 控制侧边栏抽屉。
//
// 硬切换 003：所有展示文案走 i18n；TopbarItem.label / 状态文本 / 锁定按钮
// 都通过 host.i18n.text / t() 解析；语言切换自动重渲染。

import { Menu, X } from "lucide-react";
import { Button } from "@keymaster/ui";
import { useI18n, usePluginHost, useRegistry, useRuntimeStatus } from "@keymaster/runtime";
import { BRAND_WORDMARK } from "../brand.js";
import { BrandIcon } from "./BrandIcon.js";
import { ThemeToggle } from "../theme/ThemeToggle.js";
import { LanguageSwitch } from "../i18n/LanguageSwitch.js";

export interface TopbarProps {
  mobileOpen: boolean;
  onToggleMobileNav: () => void;
}

export function Topbar({ mobileOpen, onToggleMobileNav }: TopbarProps) {
  const host = usePluginHost();
  const { vault } = useRuntimeStatus();
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  useI18n().language();
  const items = useRegistry((h) => h.topbar.list());

  async function lock() {
    if (vault === "unlocked") {
      await host.commands.run("vault.lock");
    }
  }

  return (
    <header className="app-topbar">
      <div className="app-topbar__left">
        <button
          type="button"
          className="app-topbar__nav-toggle"
          aria-label={
            mobileOpen
              ? t("common.menu.close", { defaultValue: "关闭菜单" })
              : t("shell.topbar.openMenu", { defaultValue: "打开菜单" })
          }
          aria-expanded={mobileOpen}
          onClick={onToggleMobileNav}
        >
          {mobileOpen ? <X size={18} /> : <Menu size={18} />}
        </button>
        <h1 className="app-topbar__brand">
          <BrandIcon className="app-topbar__brand-icon" />
          <span className="app-topbar__brand-text">{BRAND_WORDMARK}</span>
        </h1>
      </div>
      <div className="app-topbar__actions">
        {items.map((item) => (
          <TopbarSlot key={item.id} component={item.component} />
        ))}
        <ThemeToggle />
        <LanguageSwitch />
        {vault === "unlocked" ? (
          <Button variant="ghost" onClick={lock}>
            {t("common.action.lock", { defaultValue: "锁定" })}
          </Button>
        ) : (
          <span className="app-topbar__status">
            {t("shell.topbar.statusLabel", { defaultValue: "状态：" })}
            {vault}
          </span>
        )}
      </div>
    </header>
  );
}

function TopbarSlot({ component: Component }: { component: React.ComponentType }) {
  return <Component />;
}
