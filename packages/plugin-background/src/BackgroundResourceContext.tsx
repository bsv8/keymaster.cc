import { useInstanceActive } from "@keymaster/runtime";
import { createContext, useContext, createElement, type ComponentType, type ReactNode } from "react";
import { ScopedPluginConsumerProvider as PluginConsumerProvider } from "@keymaster/runtime";
import { OWNED_RESOURCE_ACCESS_CAPABILITY, type OwnedResourceReader, type PluginContext } from "@keymaster/contracts";
const Resources = createContext<OwnedResourceReader | undefined>(undefined);
export function useBackgroundResources(): OwnedResourceReader {
  const reader = useContext(Resources);
  if (!reader) throw new Error("Background UI requires its contributing instance resource view");
  return reader;
}
export function BackgroundResourceProvider({ reader, children }: { reader: OwnedResourceReader; children: ReactNode }) {
  return <Resources.Provider value={reader}>{children}</Resources.Provider>;
}
export function bindBackgroundUi<P extends object>(ctx: PluginContext, Component: ComponentType<P>) {
  const reader = ctx.capability(OWNED_RESOURCE_ACCESS_CAPABILITY).bind(ctx.consumer, ctx.scope);
  return function OwnedUi(props: P) {
    const active = useInstanceActive(ctx.consumer, ctx.scope);
    return active ? createElement(PluginConsumerProvider, { consumer: ctx.consumer,
      children: createElement(BackgroundResourceProvider, { reader, children: createElement(Component, props) }) }) : null;
  };
}
