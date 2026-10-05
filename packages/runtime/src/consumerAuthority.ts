import type { PluginConsumer, LifecycleScope } from "webloom-framework";
// 仅生产适配器的 setup 入口可记入框架传入的真实 consumer；公开出口只有核验函数。
const scopedConsumers = new WeakMap<LifecycleScope, PluginConsumer>();
const consumers = new WeakMap<object, LifecycleScope>();
export function rememberIssuedConsumer(consumer: PluginConsumer, scope: LifecycleScope): void { consumers.set(consumer, scope); scopedConsumers.set(scope, consumer); }
export function isIssuedKeymasterConsumer(value: unknown, scope?: LifecycleScope): value is PluginConsumer {
  return typeof value === "object" && value !== null && consumers.has(value) && (scope === undefined || consumers.get(value) === scope);
}

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
