import type { Capability, CapabilityClient } from "webloom-framework";
import type { PluginContext } from "@keymaster/contracts";
/** 仅订阅本实例已声明的可选能力；提供方替换/撤销时先清理旧绑定。 */
export function observeOptionalCapability<C extends Capability>(ctx: PluginContext, capability: C, mount: (service: CapabilityClient<C>) => () => void): () => void {
  let current: CapabilityClient<C> | undefined;
  let unmount = () => {};
  let closed = false;
  const refresh = () => {
    if (closed || ctx.scope.state !== "active" || ctx.consumer.status !== "active") return;
    const next = ctx.consumer.optionalCapability(capability);
    if (next === current) return;
    unmount(); unmount = () => {}; current = next;
    if (next) unmount = mount(next);
  };
  refresh();
  const off = ctx.consumer.subscribe(refresh);
  const close = () => { if (closed) return; closed = true; off(); unmount(); current = undefined; };
  ctx.scope.onRevoke(close);
  return close;
}
