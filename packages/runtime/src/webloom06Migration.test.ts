import { createFixtureHost as createKeymasterPluginHost } from "@keymaster/runtime/test-support";
import { describe, expect, it } from "vitest";
import { defineCapability } from "webloom-framework";
import {
  RESOURCE_REGISTRY_CAPABILITY, ROUTE_REGISTRY_CAPABILITY,
  defineRuntimeUnitDependencies, type PluginContext, type PluginManifest,
} from "@keymaster/contracts";


function manifest(id: string, dependencies: Parameters<typeof defineRuntimeUnitDependencies>[0] = []): PluginManifest {
  return {
    id, name: id, 
    units: [{ id: `${id}.window`, runtime: "window-main", scopeKind: "root",
      dependencies: defineRuntimeUnitDependencies(dependencies) }],
  };
}

function hostWith(implementations: Record<string, (ctx: PluginContext) => void>) {
  return createKeymasterPluginHost({ runtime: "window-main", runtimeUnitImplementationRegistry: {
    get: id => implementations[id],
  }});
}

describe("WebLoom 0.6 production adapter", () => {
  it("rejects undeclared registry and optional lookups in the real setup context", async () => {
    const host = hostWith({ test(ctx) {
      expect(() => ctx.capability(ROUTE_REGISTRY_CAPABILITY)).toThrow();
      expect(() => ctx.optionalCapability(ROUTE_REGISTRY_CAPABILITY)).toThrow();
      expect(() => ctx.consumer.capability(ROUTE_REGISTRY_CAPABILITY)).toThrow();
    }});
    await host.register(manifest("test"));
    expect(host.state("test").kind).toBe("enabled");
    await host.dispose();
  });

  it("distinguishes declared optional absence and rejects a mismatched contract", async () => {
    const absent = defineCapability<{ value: number }>({ kind: "local", id: "test.absent", version: "1" });
    const wrongRoute = defineCapability({ kind: "local", id: ROUTE_REGISTRY_CAPABILITY.id, version: "999" });
    const host = hostWith({ test(ctx) {
      expect(ctx.optionalCapability(absent)).toBeUndefined();
      expect(() => ctx.optionalCapability(wrongRoute)).toThrow();
    }});
    await host.register(manifest("test", [
      { capability: absent, optional: true }, { capability: ROUTE_REGISTRY_CAPABILITY },
    ]));
    expect(host.state("test").kind).toBe("enabled");
    await host.dispose();
  });

  it("keeps resource definitions within their owning instance", async () => {
    const host = hostWith({
      first(ctx) { ctx.capability(RESOURCE_REGISTRY_CAPABILITY).register({
        id: "test.first", scope: "global", key: () => ["test.first"],
        load: async () => 1, invalidation: "immediate",
      }); },
      second(ctx) {
        const resources = ctx.capability(RESOURCE_REGISTRY_CAPABILITY);
        expect(resources.get("test.first")).toBeUndefined();
        expect(resources._ids()).toEqual([]);
        expect(() => resources.unregister("test.first")).toThrow();
      },
    });
    await host.registerAll([manifest("first", [{ capability: RESOURCE_REGISTRY_CAPABILITY }]),
      manifest("second", [{ capability: RESOURCE_REGISTRY_CAPABILITY }])]);
    expect(host.state("second").kind).toBe("enabled");
    await host.revoke("first", "test");
    expect(host.resourceRegistry?.get("test.first")).toBeUndefined();
    await host.dispose();
  });

  it("fences issued consumers synchronously when disposing a Host with queued reconcile", async () => {
    let context!: PluginContext;
    const host = hostWith({ test(ctx) { context = ctx; } });
    await host.register(manifest("test", [{ capability: ROUTE_REGISTRY_CAPABILITY }]));
    const disposing = host.dispose("page closed");
    expect(() => context.consumer.capability(ROUTE_REGISTRY_CAPABILITY)).toThrow();
    expect(host.dispose()).toBe(disposing);
    await disposing;
  });

  it("registers consumers before providers without depending on catalog order", async () => {
    const service = defineCapability<{ value: number }>({ kind: "local", id: "test.order", version: "1" });
    const order: string[] = [];
    const host = hostWith({ consumer(ctx) {
      expect(ctx.capability(service).value).toBe(42); order.push("consumer");
    }, provider(ctx) { ctx.provide(service, { value: 42 }); order.push("provider"); } });
    const provider = manifest("provider");
    provider.units = [{ ...provider.units![0]!, provides: [service] }];
    await host.registerAll([manifest("consumer", [{ capability: service }]), provider]);
    expect(order).toEqual(["provider", "consumer"]);
    await host.dispose();
  });
  it("rebuilds owner consumers only after asynchronous providers publish in the new session", async () => {
    const service = defineCapability<{ epoch: string }>({ kind: "local", id: "test.owner-order", version: "1" });
    const seen: string[] = [];
    const identity = (sessionEpoch: string) => ({ vaultStatus: "unlocked" as const, ownerPublicKeyHex: "02" + "11".repeat(32), sessionEpoch, walletGeneration: "wallet:1" });
    const host = createKeymasterPluginHost({ runtime: "window-main", initialRuntimeIdentity: identity("session:1"),
      runtimeUnitImplementationRegistry: { get: id => id === "provider" ? async ctx => {
        await new Promise(resolve => setTimeout(resolve, 20));
        ctx.provide(service, { epoch: String(ctx.scope.identity.attributes.sessionEpoch) });
      } : ctx => { seen.push(ctx.capability(service).epoch); } },
    });
    const provider = manifest("provider"), consumer = manifest("consumer", [{ capability: service }]);
    provider.units = [{ ...provider.units![0]!, scopeKind: "owner-session", provides: [service] }];
    consumer.units = [{ ...consumer.units![0]!, scopeKind: "owner-session" }];
    try {
      await host.registerAll([provider, consumer]);
      expect(host.state("consumer").kind).toBe("enabled");
      await host.transitionRuntimeIdentity(identity("session:2"));
      expect(host.state("consumer").kind).toBe("enabled");
      expect(seen.at(-1)).toBe("session:2");
      expect(seen.slice(1)).not.toContain("session:1");
    } finally { await host.dispose(); }
  });

  it("keeps an explicitly retried consumer blocked while its local provider is still publishing", async () => {
    const service = defineCapability<string>({ kind: "local", id: "test.pending-provider", version: "1" });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const seen: string[] = [];
    const host = createKeymasterPluginHost({ runtime: "window-main", runtimeUnitImplementationRegistry: { get: id => id === "provider" ? async ctx => {
      entered(); await gate; ctx.provide(service, "published");
    } : ctx => { seen.push(ctx.capability(service)); } } });
    const provider = manifest("provider"); provider.units = [{ ...provider.units![0]!, provides: [service] }];
    const registration = host.registerAll([provider, manifest("consumer", [{ capability: service }])]);
    try {
      await ready;
      const retry = host.retry("consumer");
      await Promise.resolve();
      expect(host.state("consumer").kind).toBe("blocked");
      release(); await Promise.all([registration, retry]);
      expect(host.state("consumer").kind).toBe("enabled");
      expect(seen).toEqual(["published"]);
    } finally { release(); await registration; await host.dispose(); }
  });

});
