// apps/web/src/theme/ThemeToggle.tsx
// 顶栏 / onboarding header 主题切换 widget：三档（跟随系统 / 黑 / 白）。
// 设计缘由：
//   - shell 层 UI 增强，与「系统主题」同性质，直接挂在 Topbar /
//     OnboardingHeader 而不走 topbar.registry。
//   - 面板结构参考 background-tray / key-switch，保证视觉风格统一。
//   - 点击外部区域自动关闭，避免下拉框不收。
//   - 硬切换 011：所有文案接入 i18n；不再硬编码中英文。

import { useEffect, useMemo, useRef, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useI18n } from "@keymaster/runtime";
import { useTheme } from "./useTheme.js";
import type { ThemeMode } from "./themeStore.js";

interface Option {
  mode: ThemeMode;
  /** 单一 key：UI 上"选项名"那一行。 */
  labelKey: string;
  /** 单一 key：UI 上"副说明"那一行。 */
  hintKey: string;
  Icon: typeof Sun;
}

/** 选项 key 不再硬编码文案——文案在 resources.ts 里按语言区分。 */
const OPTIONS_META: ReadonlyArray<Omit<Option, "labelKey" | "hintKey">> = [
  { mode: "auto", Icon: Monitor },
  { mode: "light", Icon: Sun },
  { mode: "dark", Icon: Moon }
];

export interface ThemeToggleProps {
  /**
   * 视觉变体：默认 `topbar`——沿用顶栏按钮样式（紧凑）；
   * `onboarding` 用于首启 onboarding header，视觉略大、留白更多，
   * 与 OnboardingHeader 的轻量壳层对齐。
   */
  variant?: "topbar" | "onboarding";
}

export function ThemeToggle({ variant = "topbar" }: ThemeToggleProps) {
  const { mode, theme, setMode } = useTheme();
  const { t } = useI18n();
  // 触发 languageChanged 重渲染：切语言后下拉项 label / hint 热更新。
  useI18n().language();
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

  // 通过 fallback 函数避免 noUncheckedIndexedAccess 推断出 Option | undefined。
  const findOption = (m: ThemeMode): Option => {
    for (const meta of OPTIONS_META) {
      if (meta.mode === m) {
        return {
          ...meta,
          labelKey: `shell.onboarding.theme.${meta.mode}`,
          hintKey: `shell.onboarding.theme.${meta.mode}Hint`
        };
      }
    }
    // 兜底：auto。
    return {
      mode: "auto",
      Icon: Monitor,
      labelKey: "shell.onboarding.theme.auto",
      hintKey: "shell.onboarding.theme.autoHint"
    };
  };

  const options = useMemo<Option[]>(
    () =>
      OPTIONS_META.map((meta) => ({
        ...meta,
        labelKey: `shell.onboarding.theme.${meta.mode}`,
        hintKey: `shell.onboarding.theme.${meta.mode}Hint`
      })),
    []
  );

  const current = findOption(mode);
  const CurrentIcon = current.Icon;

  // 当前 mode 的描述：auto 时把实际生效的 theme 露出，让用户知道正在跟随什么。
  const currentLabel =
    mode === "auto"
      ? t("shell.onboarding.theme.autoActive", {
          theme: theme === "dark" ? t("shell.onboarding.theme.dark") : t("shell.onboarding.theme.light"),
          defaultValue: `Auto (${theme})`
        })
      : t(current.labelKey);

  return (
    <div className={`theme-toggle theme-toggle--${variant}`} ref={rootRef}>
      <button
        type="button"
        className={`theme-toggle__button ${open ? "is-open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-label={t("shell.onboarding.theme.toggle", { defaultValue: "Switch theme" })}
        title={t("shell.onboarding.theme.toggle", { defaultValue: "Switch theme" })}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <CurrentIcon size={16} />
        <span className="theme-toggle__label">{currentLabel}</span>
      </button>
      {open ? (
        <div className="theme-toggle__panel" role="menu">
          {options.map((opt) => {
            const active = opt.mode === mode;
            const Icon = opt.Icon;
            return (
              <button
                key={opt.mode}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={`theme-toggle__item ${active ? "is-active" : ""}`}
                onClick={() => {
                  setMode(opt.mode);
                  setOpen(false);
                }}
              >
                <Icon size={14} className="theme-toggle__item-icon" />
                <span className="theme-toggle__item-text">
                  <span className="theme-toggle__item-label">
                    {t(opt.labelKey)}
                  </span>
                  <span className="theme-toggle__item-hint">
                    {t(opt.hintKey)}
                  </span>
                </span>
                {active ? <span className="theme-toggle__item-mark">●</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
