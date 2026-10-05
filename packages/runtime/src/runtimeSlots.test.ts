import { createFixtureHost as createKeymasterPluginHost } from "@keymaster/runtime/test-support";
import { describe, expect, it, vi } from "vitest";
import { defineCapability, definePlugin, type CapabilityClient, type RuntimeHandle } from "webloom-framework";
import { createWindowAppFromHost } from "webloom-framework/advanced";
import { connectSharedWorkerForTesting, startSharedWorkerAppForTesting, type SharedWorkerScopeLike } from "webloom-framework/testing";
import { defineRuntimeUnitDependencies, type PluginContext, type PluginManifest } from "@keymaster/contracts";
import { attachKeymasterRemoteRuntime } from "./keymasterHostAdapter.js";
import { getWebLoomHost } from "./pluginHostContract.js";

const who = defineCapability<null, string>({ kind: "rpc", id: "slot-test.identity", version: "1",
  request: { parse(value) { if (value !== null) throw new TypeError("Expected null"); return null; } },
  response: { parse(value) { if (typeof value !== "string") throw new TypeError("Expected string"); return value; } },
});
const manifest = (id: string): PluginManifest => ({ id, name: id, units: [{ id: `${id}.window`, runtime: "window-main", scopeKind: "root",
  dependencies: defineRuntimeUnitDependencies([{ capability: who, sourceRuntime: "shared-worker" }]),
}] });

function worker(id: string) {
  const scope: SharedWorkerScopeLike = { onconnect: null };
  const app = startSharedWorkerAppForTesting({ id, globalScope: scope,
    plugins: [definePlugin({ id: `provider-${id}`, name: id, unitId: `provider-${id}.worker`, runtime: "shared-worker", provides: [who],
      setup(ctx) { ctx.handle(who, () => id); },
    })], expose: [who],
  });
  return { app, scope };
}

describe("Keymaster Runtime slots", () => {
  it("selects explicit Workers and fences replacement/unmount generations without falling back to another slot", async () => {
    const a = worker("a"), b = worker("b");
    await Promise.all([a.app.ready(), b.app.ready()]);
    const clients = new Map<string, CapabilityClient<typeof who>>();
    const key = (id: string) => `${id}\0${id}.window\0rpc\0${who.id}\0${who.version}`;
    const host = createKeymasterPluginHost({ runtime: "window-main", runtimeSlotBindings: { [key("first")]: "a", [key("second")]: "b" },
      runtimeUnitImplementationRegistry: { get: () => (ctx: PluginContext) => { clients.set(ctx.pluginId, ctx.capability(who)); } },
    });
    const runtimes: RuntimeHandle[] = [];
    try {
      const window = await createWindowAppFromHost({ id: "slot-page", host: getWebLoomHost(host) });
      const connect = (target: ReturnType<typeof worker>) => {
        const runtime = connectSharedWorkerForTesting({ id: target.app.runtimeId, url: `test:${target.app.runtimeId}`, client: { app: window } }, () => {
          const channel = new MessageChannel();
          queueMicrotask(() => target.scope.onconnect?.({ ports: [channel.port2] }));
          return { port: channel.port1 };
        });
        runtimes.push(runtime);
        return runtime;
      };
      const firstRuntime = connect(a), secondRuntime = connect(b);
      await vi.waitFor(() => {
        expect(firstRuntime.state().state).toBe("ready");
        expect(secondRuntime.state().state).toBe("ready");
      });
      const oldUnmount = attachKeymasterRemoteRuntime(host, firstRuntime, "a");
      const secondUnmount = attachKeymasterRemoteRuntime(host, secondRuntime, "b");
      await host.registerAll([manifest("first"), manifest("second")]);
      expect(host.state("first")).toMatchObject({ kind: "enabled" });
      expect(host.state("second")).toMatchObject({ kind: "enabled" });
      await expect(clients.get("first")!.call(null)).resolves.toBe("a");
      await expect(clients.get("second")!.call(null)).resolves.toBe("b");
      const oldClient = clients.get("first")!;
      const replacement = connect(a);
      await vi.waitFor(() => expect(replacement.state().state).toBe("ready"));
      attachKeymasterRemoteRuntime(host, replacement, "a");
      oldUnmount();
      await vi.waitFor(() => expect(clients.get("first")).not.toBe(oldClient));
      await expect(clients.get("first")!.call(null)).resolves.toBe("a");
      await expect(Promise.resolve().then(() => oldClient.call(null))).rejects.toBeDefined();
      secondUnmount();
      await vi.waitFor(() => expect(host.state("second").kind).toBe("blocked"));
      await expect(clients.get("first")!.call(null)).resolves.toBe("a");
    } finally {
      await Promise.all(runtimes.map(runtime => runtime.dispose()));
      await host.dispose();
      await Promise.all([a.app.dispose(), b.app.dispose()]);
    }
  });
});
