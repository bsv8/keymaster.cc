// packages/runtime/src/i18n/i18nStore.ts
// 语言状态 store：当前 Tab 的 mode + language 投影。
//
// 边界：
//   - 首帧使用浏览器语言；
//   - setLanguage 只更新当前 Tab，跨客户端偏好由远端设置负责；
//   - setAutoLanguage 清除手动覆盖（auto）；
//   - 不监听浏览器语言变化事件；mode === "auto" 时按页面刷新时解析。
//
// 设计说明：document / navigator 通过 globalThis 访问，
// 让 runtime 包在浏览器与 node 测试环境下都能跑（vitest.setup.ts 注入了
// MemoryStorage）。

import { DEFAULT_LANGUAGE, type LanguageMode, type SupportedLanguage } from "@keymaster/contracts";
import { resolveBrowserLanguage } from "./languageMap.js";

const HTML_LANG_ATTR = "lang";

interface RuntimeGlobals {
  document?: { documentElement: { setAttribute(name: string, value: string): void } };
  navigator?: { languages?: string[]; language?: string };
}

function getGlobals(): RuntimeGlobals {
  return globalThis as unknown as RuntimeGlobals;
}

function isBrowser(): boolean {
  const g = getGlobals();
  return Boolean(g.document || g.navigator);
}

function getDocument(): { documentElement: { setAttribute(name: string, value: string): void } } | undefined {
  return getGlobals().document;
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

/** 首屏从浏览器偏好计算 language，并写到 <html lang="...">。 */
export function applyInitialLanguage(): void {
  if (!isBrowser()) {
    store.mode = "auto";
    store.language = DEFAULT_LANGUAGE;
    return;
  }
  store.mode = "auto";
  store.language = resolveBrowserLanguage(readBrowserCandidates());
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
  applyHtmlLang(language);
  emit();
}

export function setAutoLanguage(): void {
  const next = resolveBrowserLanguage(readBrowserCandidates());
  if (store.mode === "auto" && store.language === next) return;
  store.mode = "auto";
  store.language = next;
  applyHtmlLang(next);
  emit();
}

export function subscribe(listener: (s: Store) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 测试 / 上层可重置当前内存状态。 */
export function __resetForTest(): void {
  store.mode = "auto";
  store.language = DEFAULT_LANGUAGE;
  listeners.clear();
}
