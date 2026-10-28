import type { PluginConsumer, LifecycleScope } from "webloom-framework";
// Assembly indexes consumer/Scope pairs for lifetime lookup, not authentication.
const scopedConsumers = new WeakMap<LifecycleScope, PluginConsumer>();
const consumers = new WeakMap<object, LifecycleScope>();
export function rememberIssuedConsumer(consumer: PluginConsumer, scope: LifecycleScope): void { consumers.set(consumer, scope); scopedConsumers.set(scope, consumer); }
export function issuedConsumerScope(consumer: PluginConsumer): LifecycleScope {
  const scope = consumers.get(consumer);
  if (!scope) throw new Error("Consumer was not issued by Keymaster");
  return scope;
}

/** Trusted assembly lookup; never exported from the business entry point. */
export function issuedConsumerForScope(scope: LifecycleScope): PluginConsumer {
  const consumer = scopedConsumers.get(scope);
  if (!consumer) throw new Error("Scope has no issued consumer");
  scope.assertActive(); return consumer;
}
