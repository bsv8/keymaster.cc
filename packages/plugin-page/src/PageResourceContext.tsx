import { useInstanceActive } from "@keymaster/runtime";
import { createContext, useContext, createElement, type ComponentType, type ReactNode } from "react";
import { ScopedPluginConsumerProvider as PluginConsumerProvider } from "@keymaster/runtime";
import { OWNED_RESOURCE_ACCESS_CAPABILITY, type OwnedResourceReader, type NoticeRecord, type PluginContext } from "@keymaster/contracts";
export interface PageNoticeController { isCurrent(notice: NoticeRecord): boolean; dismiss(notice: NoticeRecord): void }
const NoticeControls = createContext<PageNoticeController | undefined>(undefined);
export function usePageNoticeController() { const value = useContext(NoticeControls); if (!value) throw new Error("Page notice controls require their own instance"); return value; }
const Resources = createContext<OwnedResourceReader | undefined>(undefined);
export function usePageResources(): OwnedResourceReader {
  const reader = useContext(Resources);
  if (!reader) throw new Error("Page UI requires its contributing instance resource view");
  return reader;
}
export function PageResourceProvider({ reader, children }: { reader: OwnedResourceReader; children: ReactNode }) {
  return <Resources.Provider value={reader}>{children}</Resources.Provider>;
}
export function bindPageUi<P extends object>(ctx: PluginContext, Component: ComponentType<P>, notices?: PageNoticeController) {
  const reader = ctx.capability(OWNED_RESOURCE_ACCESS_CAPABILITY).bind(ctx.consumer, ctx.scope);
  return function OwnedUi(props: P) {
    const active = useInstanceActive(ctx.consumer, ctx.scope);
    return active ? createElement(PluginConsumerProvider, { consumer: ctx.consumer,
      children: createElement(PageResourceProvider, { reader, children: createElement(NoticeControls.Provider, { value: notices, children: createElement(Component, props) }) }) }) : null;
  };
}
