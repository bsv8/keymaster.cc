// apps/web/src/i18n/LanguageSwitch.tsx
// 顶栏语言切换 widget。
// 设计缘由：
//   - shell 层 UI 增强，与 ThemeToggle 同性质，直接挂在 Topbar 而不走 topbar.registry。
//   - 触发按钮使用 ui-button--ghost，与顶栏「锁定」按钮同高、同边框风格，
//     保证顶栏右侧控件视觉一致。
//   - 选项：English / 简体中文。**不提供「跟随浏览器」入口**：
//     浏览器语言不像主题颜色会随系统变化，切换频率极低；用户一旦手动选定，
//     就该长期生效，不再回退到跟随浏览器。
//   - 首次启动仍按浏览器语言映射（applyInitialLanguage），作为没手动选过时的兜底。
//   - 复用 i18n.service.setLanguage，持久化与热切换走同一入口。
//   - 点击外部 / Esc 关闭下拉。

import { useEffect, useRef, useState } from "react";
import { Globe, Check } from "lucide-react";
import { Button } from "@keymaster/ui";
import { useI18n } from "@keymaster/runtime";
import type { SupportedLanguage } from "@keymaster/contracts";

const SUPPORTED: SupportedLanguage[] = ["en", "zh-CN"];

export function LanguageSwitch() {
  const { t, language, setLanguage } = useI18n();
  // 触发 languageChanged 重渲染：切换后按钮 label / 当前高亮项立即更新。
  const currentLang = language();

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 点击外部 / Esc 关闭下拉。
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const labels: Record<SupportedLanguage, string> = {
    en: t("common.locale.en", { defaultValue: "English" }),
    "zh-CN": t("common.locale.zh-CN", { defaultValue: "简体中文" })
  };
  const current = labels[currentLang];

  async function pick(v: SupportedLanguage) {
    setOpen(false);
    await setLanguage(v);
  }

  return (
    <div className="language-switch" ref={rootRef}>
      <Button
        variant="ghost"
        className={`language-switch__button ${open ? "is-open" : ""}`}
        iconLeft={<Globe size={16} />}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("shell.topbar.language.label", { defaultValue: "切换语言" })}
        title={t("shell.topbar.language.label", { defaultValue: "切换语言" })}
      >
        {current}
      </Button>
      {open ? (
        <div className="language-switch__panel" role="menu">
          {SUPPORTED.map((code) => {
            const active = code === currentLang;
            return (
              <button
                key={code}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={`language-switch__item ${active ? "is-active" : ""}`}
                onClick={() => {
                  void pick(code);
                }}
              >
                <Globe size={14} className="language-switch__item-icon" />
                <span className="language-switch__item-label">{labels[code]}</span>
                {active ? <Check size={14} className="language-switch__item-mark" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
