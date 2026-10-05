import type { Capability, CapabilityClient } from "webloom-framework";
import type { PluginContext } from "@keymaster/contracts";

/** Optional providers can appear, disappear or be replaced without replacing Message. */
export function subscribeOptionalMessageService<C extends Capability>(ctx: PluginContext, capability: C,
  subscribe: (service: CapabilityClient<C>, invalidate: () => void) => () => void,
  invalidate: () => void): () => void {
  let current = ctx.optionalCapability(capability);
  let offService = current ? subscribe(current, invalidate) : () => {};
  const offConsumer = ctx.consumer.subscribe(() => {
    if (ctx.consumer.status !== "active") return;
    const next = ctx.optionalCapability(capability);
    if (next === current) return;
    offService();
    current = next;
    offService = next ? subscribe(next, invalidate) : () => {};
    invalidate();
  });
  return () => { offConsumer(); offService(); };
}
