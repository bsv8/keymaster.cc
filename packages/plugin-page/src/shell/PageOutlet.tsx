// 可信应用壳的过渡接入；不把贡献方 consumer/组件列表交给壳。
import { useCallback, useSyncExternalStore } from "react";
import { useOptionalPluginCapability } from "webloom-framework/react";
import { PAGE_UI_RENDERER_CAPABILITY } from "@keymaster/contracts";
export function usePageRenderer() {
  const renderer = useOptionalPluginCapability(PAGE_UI_RENDERER_CAPABILITY);
  const subscribe = useCallback((listener: () => void) => renderer?.subscribe(listener) ?? (() => {}), [renderer]);
  const snapshot = useCallback(() => renderer?.revision() ?? 0, [renderer]);
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return renderer;
}
export function PageHeaderOutlet({ slot }: { slot: "topbar" | "above-header" }) {
  const renderer = usePageRenderer();
  return <>{renderer?.renderHeader(slot)}</>;
}
