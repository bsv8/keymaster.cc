// packages/runtime/src/react/useI18n.ts
// React 侧的 i18n hooks：useI18n / useI18nText / useLocale。
// 设计缘由：
//   - 业务组件用 hook 订阅语言变化：内部用 useSyncExternalStore 订阅
//     i18n service.onChange，切换语言后强制重渲染。
//   - useI18n() 返回 t + text + language + setLanguage / setAuto；
//     业务组件不直接 import i18next 实例。
//   - useLocale() 返回当前语言；formatSats / Intl 调用方使用。

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useCapability } from "./useCapability.js";
import type {
  I18nService,
  I18nText,
  I18nValues,
  LanguageMode,
  SupportedLanguage
} from "@keymaster/contracts";

/** 稳定订阅 i18nService：返回 i18nService 引用与当前 language。 */
function useI18nService(): I18nService {
  return useCapability<I18nService>("i18n.service");
}

export interface UseI18nResult {
  t(key: string, values?: I18nValues): string;
  text(input: I18nText | undefined): string;
  language(): SupportedLanguage;
  mode(): LanguageMode;
  setLanguage(language: SupportedLanguage): Promise<void>;
  setAuto(): Promise<void>;
}

/**
 * 业务组件读取 i18n 服务的 hook。
 * 内部用 useSyncExternalStore 订阅 service.onChange()，语言切换时强制重渲染。
 *
 * 设计要点：返回的对象必须稳定。如果每次 render 都返回新对象/新 t 引用，
 * 任何把 t 放进 useCallback 依赖的组件都会失效，进而让 useEffect 在每次
 * render 都跑——典型症状就是 VaultSettingsPage 里的 "Maximum update depth
 * exceeded"。这里把整个 result 用 useMemo 锁在 service 引用上。
 */
export function useI18n(): UseI18nResult {
  const service = useI18nService();
  const subscribe = useCallback(
    (onChange: () => void) => service.onChange(onChange),
    [service]
  );
  // 读 language 作为 snapshot；缺省返回 DEFAULT_LANGUAGE 以便 SSR/未初始化时也安全。
  const getSnapshot = useCallback(() => service.language(), [service]);
  // 服务端 / 测试中 getServerSnapshot 必须返回稳定值；i18n 在浏览器侧才有意义。
  const getServerSnapshot = useCallback(() => "en" as SupportedLanguage, []);
  // 触发订阅与重渲染。
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return useMemo(
    () => ({
      t: (key, values) => service.t(key, values),
      text: (input) => service.text(input),
      language: () => service.language(),
      mode: () => service.mode(),
      setLanguage: (l) => service.setLanguage(l),
      setAuto: () => service.setAuto()
    }),
    [service]
  );
}

/** 解析 I18nText 的便捷 hook：返回当前语言的展示文本。 */
export function useI18nText(input: I18nText | undefined): string {
  const { text } = useI18n();
  return text(input);
}

/** 当前语言：用于 Intl.NumberFormat / DateTimeFormat。 */
export function useLocale(): SupportedLanguage {
  const service = useI18nService();
  const subscribe = useCallback(
    (onChange: () => void) => service.onChange(onChange),
    [service]
  );
  const getSnapshot = useCallback(() => service.language(), [service]);
  const getServerSnapshot = useCallback(() => "en" as SupportedLanguage, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
