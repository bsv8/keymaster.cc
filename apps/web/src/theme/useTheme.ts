// apps/web/src/theme/useTheme.ts
// 订阅 themeStore 的 React hook。
// 设计缘由：store 在 React 外部维护（避免双实例），用 useSyncExternalStore 订阅。

import { useCallback, useSyncExternalStore } from "react";
import { getMode, getTheme, setMode, subscribe, type ThemeMode } from "./themeStore.js";

export interface UseThemeResult {
  mode: ThemeMode;
  theme: ReturnType<typeof getTheme>;
  setMode: (m: ThemeMode) => void;
}

export function useTheme(): UseThemeResult {
  const mode = useSyncExternalStore(subscribe, getMode, getMode);
  const theme = useSyncExternalStore(subscribe, getTheme, getTheme);
  const set = useCallback((m: ThemeMode) => setMode(m), []);
  return { mode, theme, setMode: set };
}
