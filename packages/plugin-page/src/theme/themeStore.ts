// src/theme/themeStore.ts
// 设计缘由：
//   - 用户在 UI 上选择的是「跟随系统 / 黑 / 白」，这是「模式」；
//   - 实际写到 <html data-theme="…"> 的只有 dark/light 两套视觉主题。
//   - mode === "auto" 时，由 matchMedia("(prefers-color-scheme: dark)") 算出 theme，
//     并订阅 change 事件，让系统切换时页面自动跟随。
//   - 首屏在 React 挂载前就同步应用一次，避免 FOUC（白屏闪一下再变深色）。

import { traceDev } from "@keymaster/contracts";
import { readAppearance, saveAppearance } from "./appearanceStorage.js";

export const THEME_MODES = ["auto", "light", "dark"] as const;
export const ACCENT_IDS = ["orange", "blue", "green", "purple"] as const;
export type ThemeMode = typeof THEME_MODES[number];
export type AccentId = typeof ACCENT_IDS[number];
export type ThemeName = "dark" | "light";

const DATA_ATTR = "data-theme";

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

/** 解析 matchMedia 结果到 theme。系统未明确时按 light 兜底（与参考图风格一致）。 */
function resolveSystemTheme(): ThemeName {
  if (!isBrowser()) return "light";
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  return mql.matches ? "dark" : "light";
}

/** 根据当前 mode 计算实际 theme。 */
function computeTheme(mode: ThemeMode): ThemeName {
  if (mode === "dark") return "dark";
  if (mode === "light") return "light";
  return resolveSystemTheme();
}

function applyTheme(theme: ThemeName): void {
  if (!isBrowser()) return;
  // 写在 <html> 上，让所有 CSS 变量立刻生效。
  document.documentElement.setAttribute(DATA_ATTR, theme);
  document.documentElement.dataset.accent = store.accent;
  document.documentElement.style.colorScheme = theme;
}

interface Store {
  mode: ThemeMode;
  theme: ThemeName;
  accent: AccentId;
}

const store: Store = {
  mode: "auto",
  theme: "light",
  accent: "orange"
};

let modeEdited = false;
let accentEdited = false;
let initialized = false;

const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

let mql: MediaQueryList | null = null;

function handleSystemChange(): void {
  if (store.mode !== "auto") return;
  const next = resolveSystemTheme();
  if (next === store.theme) return;
  store.theme = next;
  applyTheme(next);
  emit();
}

/** 启动一次媒体查询监听。模块加载时调用一次即可。 */
function ensureSystemListener(): void {
  if (!isBrowser() || mql) return;
  mql = window.matchMedia("(prefers-color-scheme: dark)");
  // Safari < 14 只支持 addListener；现代浏览器都支持 addEventListener。
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", handleSystemChange);
  } else if (typeof (mql as MediaQueryList).addListener === "function") {
    (mql as MediaQueryList).addListener(handleSystemChange);
  }
}

/** 首屏使用系统默认，随后加载浏览器的外观偏好。 */
export function applyInitialTheme(): void {
  if (!isBrowser() || initialized) return;
  initialized = true;
  store.theme = computeTheme(store.mode);
  applyTheme(store.theme);
  ensureSystemListener();
  void readAppearance().then(({ mode, accent }) => {
    if (!modeEdited && THEME_MODES.some(option => option === mode)) store.mode = mode as ThemeMode;
    if (!accentEdited && ACCENT_IDS.some(option => option === accent)) store.accent = accent as AccentId;
    store.theme = computeTheme(store.mode);
    applyTheme(store.theme);
    emit();
  }).catch(error => traceDev("keymaster.page.appearance", "read-failed", () => ({ error })));
}

export function getMode(): ThemeMode {
  return store.mode;
}

export function getTheme(): ThemeName {
  return store.theme;
}

export function setMode(mode: ThemeMode): void {
  modeEdited = true;
  void saveAppearance("mode", mode).catch(error => traceDev("keymaster.page.appearance", "save-failed", () => ({ field: "mode", error })));
  if (store.mode === mode) return;
  store.mode = mode;
  const next = computeTheme(mode);
  if (next !== store.theme) {
    store.theme = next;
    applyTheme(next);
  }
  ensureSystemListener();
  emit();
}

export function getAccent(): AccentId {
  return store.accent;
}

export function setAccent(accent: AccentId): void {
  accentEdited = true;
  void saveAppearance("accent", accent).catch(error => traceDev("keymaster.page.appearance", "save-failed", () => ({ field: "accent", error })));
  if (store.accent === accent) return;
  store.accent = accent;
  applyTheme(store.theme);
  emit();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
