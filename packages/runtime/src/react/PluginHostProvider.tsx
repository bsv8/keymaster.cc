// packages/runtime/src/react/PluginHostProvider.tsx
// 把 PluginHost 注入 React 树。
// 设计缘由：组件层只通过 hooks 访问能力，不要直接 import 内部模块。
// 硬切换 001：host 进入运行期可卸载，host.version 变化要触发订阅者重渲染。

import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { WebLoomProvider, type WebLoomApp } from "webloom-framework/react";
import type { Capability, CapabilityClient } from "webloom-framework";
import type { PluginHost } from "../pluginHostContract.js";
import { getWebLoomHost } from "../pluginHostContract.js";

export const PluginHostContext = createContext<PluginHost | undefined>(undefined);

export interface PluginHostProviderProps {
  host: PluginHost;
  children: ReactNode;
}

export function PluginHostProvider({ host, children }: PluginHostProviderProps) {
  const app = useMemo(() => {
    const webLoomHost = getWebLoomHost(host);
    return {
      runtimeKind: webLoomHost.runtimeKind,
      runtimeId: webLoomHost.runtimeId,
      runtimeInstanceId: webLoomHost.runtimeInstanceId,
      state: () => ({
        protocolVersion: "webloom.runtime.v1" as const,
        runtimeId: webLoomHost.runtimeId,
        runtimeKind: webLoomHost.runtimeKind,
        runtimeInstanceId: webLoomHost.runtimeInstanceId,
        revision: webLoomHost.version,
        state: "ready" as const,
        units: [],
        services: [],
      }),
      pluginState: (pluginId: string) => webLoomHost.state(pluginId),
      capability<C extends Capability>(capability: C): CapabilityClient<C> {
        return webLoomHost.capability(capability);
      },
      optionalCapability<C extends Capability>(capability: C): CapabilityClient<C> | undefined {
        return webLoomHost.optionalCapability(capability);
      },
      inspect: () => webLoomHost.inspect(),
      subscribe: (listener: () => void) => webLoomHost.subscribe(listener),
      dispose: (reason?: string) => webLoomHost.dispose(reason),
    } as unknown as WebLoomApp;
  }, [host]);
  return (
    <WebLoomProvider app={app}>
      <PluginHostContext.Provider value={host}>{children}</PluginHostContext.Provider>
    </WebLoomProvider>
  );
}

export function usePluginHost(): PluginHost {
  const host = useContext(PluginHostContext);
  if (!host) throw new Error("PluginHostContext is missing");
  return host;
}

/**
 * 订阅 host.version：host 每次 enable / disable / unregister 后 version 递增，
 * 订阅组件会重新渲染。这是"硬切换 001"让 React 层感知 host 变化的关键 hook。
 */
export function useHostVersion(): number {
  const host = usePluginHost();
  const [version, setVersion] = useState<number>(host.version());
  useEffect(() => host.subscribe((snapshot) => setVersion(snapshot.version)), [host]);
  return version;
}
