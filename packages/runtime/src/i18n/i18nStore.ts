// packages/runtime/src/i18n/i18nStore.ts
// 语言状态 store：mode（持久化）+ language（实际生效）。
// 设计缘由：参考 apps/web/src/theme/themeStore.ts 的结构（同步读 localStorage、
// 写 <html> 属性、订阅热更新），放在 runtime 中复用，app 与插件不再各自实现。
//
// 边界：
//   - localStorage 异常必须吞掉走兜底；
//   - setLanguage 保存手动选择；
//   - setAutoLanguage 清除手动覆盖（auto）；
//   - 不监听浏览器语言变化事件；mode === "auto" 时按页面刷新时解析。
//
// 设计说明：localStorage / document / navigator 通过 globalThis 访问，
// 让 runtime 包在浏览器与 node 测试环境下都能跑（vitest.setup.ts 注入了
// MemoryStorage）。

import { DEFAULT_LANGUAGE, type LanguageMode, type SupportedLanguage } from "@keymaster/contracts";
import { resolveBrowserLanguage } from "./languageMap.js";

const STORAGE_KEY = "keymaster.languageMode";
const HTML_LANG_ATTR = "lang";

interface RuntimeGlobals {
  window?: { localStorage?: Storage };
  document?: { documentElement: { setAttribute(name: string, value: string): void } };
  navigator?: { languages?: string[]; language?: string };
  localStorage?: Storage;
}

function getGlobals(): RuntimeGlobals {
  return globalThis as unknown as RuntimeGlobals;
}

function isBrowser(): boolean {
  // 设计：test 环境下 localStorage 是 shim；document 不存在但能持久化模式。
  // 生产中两者都有；这里把"可读取 localStorage"视为可初始化。
  // 同时保留 document 守卫，确保 applyHtmlLang 在没有 DOM 时 no-op。
  const g = getGlobals();
  return Boolean(g.localStorage ?? g.window?.localStorage);
}

function getLocalStorage(): Storage | undefined {
  const g = getGlobals();
  return g.localStorage ?? g.window?.localStorage;
}

function getDocument(): { documentElement: { setAttribute(name: string, value: string): void } } | undefined {
  return getGlobals().document;
}

function readStoredMode(): LanguageMode {
  const ls = getLocalStorage();
  if (!ls) return "auto";
  try {
    const raw = ls.getItem(STORAGE_KEY);
    if (raw === "auto" || raw === "manual") return raw;
    if (raw && (raw === "en" || raw === "zh-CN")) {
      // 兼容旧数据：把已选具体语言视为 manual。
      return "manual";
    }
  } catch {
    // localStorage 可能因隐私模式 / Safari ITP 抛错，吞掉走默认。
  }
  return "auto";
}

function readStoredLanguage(): SupportedLanguage | undefined {
  const ls = getLocalStorage();
  if (!ls) return undefined;
  try {
    const raw = ls.getItem(STORAGE_KEY);
    if (raw === "en" || raw === "zh-CN") return raw;
  } catch {
    // ignore
  }
  return undefined;
}

function writeStoredMode(mode: LanguageMode, language: SupportedLanguage | undefined): void {
  const ls = getLocalStorage();
  if (!ls) return;
  try {
    if (mode === "manual" && language) {
      ls.setItem(STORAGE_KEY, language);
    } else {
      // auto：清空手动覆盖，仅保留 mode 标记。
      ls.setItem(STORAGE_KEY, "auto");
    }
  } catch {
    // 同上：localStorage 写失败不抛。
  }
}

/**
 * 读取浏览器语言候选：navigator.languages[0..n]，回退到 navigator.language。
 * SSR / 非浏览器环境返回空数组。
 */
function readBrowserCandidates(): string[] {
  const nav = getGlobals().navigator;
  if (!nav) return [];
  const out: string[] = [];
  if (Array.isArray(nav.languages)) {
    for (const l of nav.languages) if (typeof l === "string") out.push(l);
  }
  if (typeof nav.language === "string") out.push(nav.language);
  return out;
}

interface Store {
  mode: LanguageMode;
  language: SupportedLanguage;
}

const store: Store = {
  mode: "auto",
  language: DEFAULT_LANGUAGE
};

const listeners = new Set<(s: Store) => void>();

function emit(): void {
  for (const l of listeners) l({ ...store });
}

function applyHtmlLang(lang: SupportedLanguage): void {
  const doc = getDocument();
  if (!doc) return;
  doc.documentElement.setAttribute(HTML_LANG_ATTR, lang);
}

/** 首屏调用：读 localStorage、计算 language、写到 <html lang="...">。 */
export function applyInitialLanguage(): void {
  if (!isBrowser()) {
    store.mode = "auto";
    store.language = DEFAULT_LANGUAGE;
    return;
  }
  store.mode = readStoredMode();
  if (store.mode === "manual") {
    const manual = readStoredLanguage();
    store.language = manual ?? resolveBrowserLanguage(readBrowserCandidates());
  } else {
    store.language = resolveBrowserLanguage(readBrowserCandidates());
  }
  applyHtmlLang(store.language);
}

export function getLanguageMode(): LanguageMode {
  return store.mode;
}

export function getLanguage(): SupportedLanguage {
  return store.language;
}

export function setLanguage(language: SupportedLanguage): void {
  if (store.mode === "manual" && store.language === language) return;
  store.mode = "manual";
  store.language = language;
  writeStoredMode("manual", language);
  applyHtmlLang(language);
  emit();
}

export function setAutoLanguage(): void {
  const next = resolveBrowserLanguage(readBrowserCandidates());
  if (store.mode === "auto" && store.language === next) return;
  store.mode = "auto";
  store.language = next;
  writeStoredMode("auto", undefined);
  applyHtmlLang(next);
  emit();
}

export function subscribe(listener: (s: Store) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 测试 / 上层可重置：清空 localStorage 与内存状态。 */
export function __resetForTest(): void {
  store.mode = "auto";
  store.language = DEFAULT_LANGUAGE;
  listeners.clear();
}
