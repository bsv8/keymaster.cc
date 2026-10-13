import { useInstanceActive } from "@keymaster/runtime";
import { createContext, useContext, createElement, type ComponentType, type ReactNode } from "react";
import { ScopedPluginConsumerProvider as PluginConsumerProvider } from "@keymaster/runtime";
import { PAGE_UI_RENDERER_CAPABILITY, OWNED_RESOURCE_ACCESS_CAPABILITY, type PageUiRenderer, type OwnedResourceReader, type NoticeRecord, type PluginContext } from "@keymaster/contracts";
export interface PageNoticeController { isCurrent(notice: NoticeRecord): boolean; dismiss(notice: NoticeRecord): void }
const NoticeControls = createContext<PageNoticeController | undefined>(undefined);
export function usePageNoticeController() { const value = useContext(NoticeControls); if (!value) throw new Error("Page notice controls require their own instance"); return value; }
// Page owns this renderer. Its own shell does not consume its exported
// capability as if it were a dependency on another plugin.
const Renderer = createContext<PageUiRenderer | undefined>(undefined);
export function useOwnedPageRenderer():PageUiRenderer{const renderer=useContext(Renderer);if(!renderer)throw Error("Page renderer requires its owning instance UI");return renderer;}
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
  const renderer=ctx.capability(PAGE_UI_RENDERER_CAPABILITY);
  return function OwnedUi(props: P) {
    const active = useInstanceActive(ctx.consumer, ctx.scope);
    return active ? createElement(PluginConsumerProvider, { consumer: ctx.consumer,
      children: createElement(PageResourceProvider, { reader, children: createElement(NoticeControls.Provider, { value: notices, children: createElement(Renderer.Provider,{value:renderer,children:createElement(Component, props)}) }) }) }) : null;
  };
}
