import { createScopedRegistryView } from "webloom-framework/advanced";
import type { Capability, PluginConsumer, LifecycleScope } from "webloom-framework";
import { isIssuedKeymasterConsumer } from "./consumerAuthority.js";

export const INSTANCE_REGISTRY_BINDING = Symbol.for("keymaster.registry.consumer-binding");

/** Generic registration ownership; the provider plugin retains its implementation and data. */
export function createInstanceRegistry<T extends object>(target: T, capability: Capability,
  options: Parameters<typeof createScopedRegistryView>[2] & { projectRegistration?: (input: unknown) => object; cleanupMethods?: readonly string[] } = { name: capability.id }, providerScope?: LifecycleScope) {
  const registrations = (options.registrations ?? [{ method: "register", idArgument: 0, unregisterMethod: "unregister" }])
    .map(rule => ({ ...rule, ownerInstanceIdProperty: rule.ownerInstanceIdProperty ?? "ownerInstanceId" }));
  const mutations = new Set(registrations.flatMap(rule => [rule.method, ...(rule.unregisterMethod ? [rule.unregisterMethod] : [])]));
  const byMethod = new Map(registrations.map(rule => [rule.method, rule]));
  const entries = new Map<string, { active: boolean }>();
  const registrationTarget = new Proxy(target, {
    get(current, property, receiver) {
      const value: unknown = Reflect.get(current, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const key = `${String(property)}:${String(args[0])}`;
        const token = entries.get(key);
        if (token) token.active = false;
        const result = value.apply(current, args);
        if (token) entries.delete(key);
        return result;
      };
    },
  });
  const guardedRead = (method: (...args: unknown[]) => unknown, scope?: LifecycleScope) => (...args: unknown[]) => {
    providerScope?.assertActive(); scope?.assertActive();
    const result = method(...args.map(arg => typeof arg !== "function" ? arg : (...events: unknown[]) => {
      if ((!scope || scope.state === "active") && (!providerScope || providerScope.state === "active")) return arg(...events);
    }));
    if (result instanceof Promise) return result.then(value => { providerScope?.assertActive(); scope?.assertActive(); return value; });
    if (typeof result === "function") {
      let closed = false;
      const close = () => { if (closed) return; closed = true; result(); };
      const offConsumer = scope?.onRevoke(close);
      const offProvider = providerScope?.onRevoke(close);
      return () => { offConsumer?.(); offProvider?.(); close(); };
    }
    return result;
  };
  const bind = (consumer: PluginConsumer, scope: LifecycleScope) => {
    providerScope?.assertActive();
    if (!isIssuedKeymasterConsumer(consumer, scope) || consumer.status !== "active") throw new Error("Registry requires its live issued consumer and Scope");
    scope.assertActive(); consumer.capability(capability);
    const view = createScopedRegistryView(registrationTarget, scope, { ...options, registrations }).view;
    return new Proxy(view, {
      get(current, property, receiver) {
        const value: unknown = Reflect.get(current, property, receiver);
        const rule = typeof property === "string" ? byMethod.get(property) : undefined;
        if (typeof value !== "function") return value;
        if (!rule) return guardedRead(value as (...args: unknown[]) => unknown, scope);
        return (...args: unknown[]) => {
          providerScope?.assertActive(); scope.assertActive();
          const index = rule.idArgument ?? 0;
          const definition = args[index] as { id?: string };
          const key = `${rule.unregisterMethod}:${definition?.id}`;
          const token = { active: true };
          const disposed = new Set<unknown>();
          const assert = () => { providerScope?.assertActive(); scope.assertActive(); if (!token.active) throw new Error("Registry contribution has been removed"); };
          const decorate = (input: unknown): unknown => {
            if (Array.isArray(input)) return input.map(decorate);
            if (!input || typeof input !== "object" || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) return input;
            return Object.fromEntries(Object.entries(input).map(([name, member]) => [name, typeof member !== "function" ? decorate(member) : (...values: unknown[]) => {
              if (["component", "visibleWhen", "activeWhen", "match"].includes(name) && (!token.active || scope.state !== "active" || (providerScope && providerScope.state !== "active"))) return name === "component" ? null : false;
              if (name === "dispose" || options.cleanupMethods?.includes(name)) {
                if (name !== "dispose" && token.active && scope.state === "active" && (!providerScope || providerScope.state === "active")) return member.apply(input, values);
                if (name === "dispose" && token.active && scope.state === "active" && (!providerScope || providerScope.state === "active")) throw new Error("Registry provider cleanup is private");
                if (disposed.has(member)) return; disposed.add(member); return member.apply(input, values);
              }
              assert();
              const result = member.apply(input, values.map(arg => typeof arg !== "function" ? arg : (...events: unknown[]) => { if (token.active && scope.state === "active" && (!providerScope || providerScope.state === "active")) return arg(...events); }));
              if (result instanceof Promise) return result.then(resolved => { assert(); return resolved; });
              if (typeof result === "function") {
                let closed = false;
                const close = () => { if (closed) return; closed = true; result(); };
                const off = scope.onRevoke(close);
                return () => { off(); close(); };
              }
              return result;
            }]));
          };
          const callArgs = [...args]; callArgs[index] = decorate(options.projectRegistration ? options.projectRegistration(definition) : definition);
          const result = value(...callArgs);
          const previous = entries.get(key); if (previous) previous.active = false;
          entries.set(key, token);
          scope.onRevoke(() => { token.active = false; });
          return typeof result === "function" ? () => { token.active = false; result(); } : result;
        };
      },
    });
  };
  const service: T & { bind(consumer: PluginConsumer, scope: LifecycleScope): T } = new Proxy(registrationTarget, {
    get(current, property, receiver) {
      if (property === "bind" || property === INSTANCE_REGISTRY_BINDING) return bind;
      if (typeof property === "string" && (mutations.has(property) || property.startsWith("_"))) return () => { throw new Error("Registry registration requires an instance binding"); };
      providerScope?.assertActive();
      const value: unknown = Reflect.get(current, property, receiver);
      return typeof value === "function" ? guardedRead(value as (...args: unknown[]) => unknown) : value;
    },
    getOwnPropertyDescriptor(_target, property): PropertyDescriptor | undefined {
      providerScope?.assertActive(); const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      return descriptor ? { configurable: true, enumerable: descriptor.enumerable, writable: false, value: Reflect.get(service, property) } : undefined;
    },
    set() { throw new Error("Registry service is readonly"); },
    defineProperty() { throw new Error("Registry service is readonly"); },
    deleteProperty() { throw new Error("Registry service is readonly"); },
    setPrototypeOf() { throw new Error("Registry service is readonly"); },
  }) as T & { bind(consumer: PluginConsumer, scope: LifecycleScope): T };
  return { service, privateView: registrationTarget };
}

export function createInstanceRegistryService<T extends object>(target: T, capability: Capability, options?: Parameters<typeof createScopedRegistryView>[2] & { projectRegistration?: (input: unknown) => object; cleanupMethods?: readonly string[] }, providerScope?: LifecycleScope) {
  return createInstanceRegistry(target, capability, options, providerScope).service;
}
