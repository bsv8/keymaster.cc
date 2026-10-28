import type { LocalCapability, PluginConsumer, LifecycleScope } from "webloom-framework";
import type { CoordinatorClientBinding } from "@keymaster/contracts";

/** Bind a trusted driver and consumer while retaining lifetime fencing. */
export function createScopedClientBinding<T extends object>(capability: LocalCapability<CoordinatorClientBinding<T>>,
  clientForConsumer: (consumer: PluginConsumer) => T): CoordinatorClientBinding<T> {
  const bindings = new WeakMap<PluginConsumer, { scope: LifecycleScope; client: T }>();
  return { bind(consumer, scope) {
    if (consumer.status !== "active") throw new Error("Client consumer has been revoked");
    scope.assertActive(); consumer.capability(capability);
    const existing = bindings.get(consumer);
    if (existing) { if (existing.scope !== scope) throw new Error("Client binding Scope mismatch"); return existing.client; }
    const source = clientForConsumer(consumer);
    const assert = () => { scope.assertActive(); if (consumer.status !== "active") throw new Error("Client consumer has been revoked"); };
    const methods = new Map<PropertyKey, unknown>();
    const binding: T = new Proxy(Object.create(null) as T, {
      get(_target, property) {
        assert(); const member = Reflect.get(source, property, source);
        if (typeof member !== "function") return member;
        if (!methods.has(property)) methods.set(property, (...args: unknown[]) => {
          assert();
          const result = member.apply(source, args.map(arg => typeof arg !== "function" ? arg : (...values: unknown[]) => { if (consumer.status === "active" && scope.state === "active") return arg(...values); }));
          if (result instanceof Promise) return result.then(value => { assert(); return value; });
          if (typeof result === "function") {
            let closed = false;
            const close = () => { if (closed) return; closed = true; result(); };
            const off = scope.onRevoke(close); return () => { off(); close(); };
          }
          return result;
        });
        return methods.get(property);
      },
      ownKeys() { assert(); return Reflect.ownKeys(source); },
      has(_target, property) { assert(); return Reflect.has(source, property); },
      getOwnPropertyDescriptor(_target, property): PropertyDescriptor | undefined {
        assert(); const descriptor = Reflect.getOwnPropertyDescriptor(source, property);
        return descriptor ? { configurable: true, enumerable: descriptor.enumerable, writable: false, value: Reflect.get(binding, property) } : undefined;
      },
    });
    bindings.set(consumer, { scope, client: binding }); return binding;
  } };
}
