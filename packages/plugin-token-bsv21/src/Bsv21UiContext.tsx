import { useInstanceActive } from "@keymaster/runtime";
import { createElement, type ComponentType } from "react";
import { ScopedPluginConsumerProvider as PluginConsumerProvider } from "@keymaster/runtime";
import type { PluginContext } from "@keymaster/contracts";
export function bindBsv21Ui<P extends object>(ctx: PluginContext, Component: ComponentType<P>) {
  return function OwnedUi(props: P) {
    const active = useInstanceActive(ctx.consumer, ctx.scope);
    return active ? createElement(PluginConsumerProvider, { consumer: ctx.consumer, children: createElement(Component, props) }) : null;
  };
}
