// packages/runtime/src/react/PluginHostProvider.tsx
// 把 PluginHost 注入 React 树。
// 设计缘由：组件层只通过 hooks 访问能力，不要直接 import 内部模块。

import { createContext, type ReactNode, useContext } from "react";
import type { PluginHost } from "../createPluginHost.js";

export const PluginHostContext = createContext<PluginHost | undefined>(undefined);

export interface PluginHostProviderProps {
  host: PluginHost;
  children: ReactNode;
}

export function PluginHostProvider({ host, children }: PluginHostProviderProps) {
  return <PluginHostContext.Provider value={host}>{children}</PluginHostContext.Provider>;
}

export function usePluginHost(): PluginHost {
  const host = useContext(PluginHostContext);
  if (!host) throw new Error("PluginHostContext is missing");
  return host;
}
