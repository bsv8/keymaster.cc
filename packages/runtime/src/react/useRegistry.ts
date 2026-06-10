// packages/runtime/src/react/useRegistry.ts
// 通用 registry 读取 hook：接收一个 selector，从已稳定的 PluginHost 上同步读取数据。
//
// 当前插件注册发生在 React 挂载前，host 引用稳定。
// 这里不使用 useSyncExternalStore，避免 selector 返回新数组/新对象时
// 被 React 误判为 snapshot 变化而触发无限更新。
//
// 不再声明运行期动态订阅能力：调用方应假定 host 在挂载后不再变更。
// 未来若真的需要运行期安装/卸载插件，请另开施工单在 runtime 层
// 引入 `host.version` + `host.subscribe()`，并在 useRegistry 内部基于
// 稳定的 version 做 useMemo，而不是把 selector(host) 当成 external store snapshot。

import type { PluginHost } from "../createPluginHost.js";
import { usePluginHost } from "./PluginHostProvider.js";

export function useRegistry<T>(selector: (host: PluginHost) => T): T {
  const host = usePluginHost();
  return selector(host);
}
