import { createElement, useSyncExternalStore, type ComponentType } from "react";
import { ScopedPluginConsumerProvider as PluginConsumerProvider } from "@keymaster/runtime";
import type { PluginContext } from "@keymaster/contracts";

export function bindOrdinalUi<P extends object>(ctx: PluginContext, Component: ComponentType<P>) {
  return function OwnedUi(props: P) {
    const status = useSyncExternalStore(ctx.consumer.subscribe, () => ctx.consumer.status, () => ctx.consumer.status);
    return status === "active" ? createElement(PluginConsumerProvider, { consumer: ctx.consumer, children: createElement(Component, props) }) : null;
  };
}
