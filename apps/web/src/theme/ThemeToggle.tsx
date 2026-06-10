// apps/web/src/theme/ThemeToggle.tsx
// 顶栏主题切换 widget：三档（跟随系统 / 黑 / 白）。
// 设计缘由：
//   - shell 层 UI 增强，与「系统主题」同性质，直接挂在 Topbar 而不走 topbar.registry。
//   - 面板结构参考 background-tray / key-switch，保证视觉风格统一。
//   - 点击外部区域自动关闭，避免下拉框不收。

import { useEffect, useRef, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "./useTheme.js";
import type { ThemeMode } from "./themeStore.js";

interface Option {
  mode: ThemeMode;
  label: string;
  Icon: typeof Sun;
  hint: string;
}

const OPTIONS: Option[] = [
  { mode: "auto", label: "跟随系统", Icon: Monitor, hint: "跟随系统当前设置" },
  { mode: "light", label: "白", Icon: Sun, hint: "浅色主题" },
  { mode: "dark", label: "黑", Icon: Moon, hint: "深色主题" }
];

export function ThemeToggle() {
  const { mode, theme, setMode } = useTheme();
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

  // 当前 mode 的描述：auto 时把实际生效的 theme 露出，让用户知道正在跟随什么。
  // 通过一个 fallback 函数避免 noUncheckedIndexedAccess 推断出 Option | undefined。
  const findOption = (m: ThemeMode): Option => {
    for (const o of OPTIONS) if (o.mode === m) return o;
    return OPTIONS[0]!;
  };
  const current = findOption(mode);
  const CurrentIcon = current.Icon;
  const statusText = mode === "auto" ? `跟随系统 (${theme === "dark" ? "深" : "浅"})` : current.label;

  return (
    <div className="theme-toggle" ref={rootRef}>
      <button
        type="button"
        className={`theme-toggle__button ${open ? "is-open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-label="切换主题"
        aria-haspopup="menu"
        aria-expanded={open}
        title={statusText}
      >
        <CurrentIcon size={16} />
        <span className="theme-toggle__label">{current.label}</span>
      </button>
      {open ? (
        <div className="theme-toggle__panel" role="menu">
          {OPTIONS.map((opt) => {
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
                  <span className="theme-toggle__item-label">{opt.label}</span>
                  <span className="theme-toggle__item-hint">{opt.hint}</span>
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
