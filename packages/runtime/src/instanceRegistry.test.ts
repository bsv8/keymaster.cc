import { expect, it, vi } from "vitest";
import { defineCapability } from "webloom-framework";
import type { PluginContext } from "@keymaster/contracts";
import { createKeymasterPluginHost } from "./keymasterHostAdapter.js";
import { createInstanceRegistryService } from "./instanceRegistry.js";
interface Contribution { id: string; start(): void; stop(): void; visibleWhen(): boolean; execute(): Promise<string> }
interface Registry { register(value: Contribution): () => void }
const capability = defineCapability<Registry>({ kind: "local", id: "example.registration", version: "1" });
it("projects class registrations without losing methods or exposing private fields; fences removed callbacks", async () => {
  let registered!: Contribution;
  let context!: PluginContext;
  let finish!: (value: string) => void;
  const stopped = vi.fn();
  class Lane {
    id = "lane";
    privateSecret = "hidden";
    start() {}
    stop() { stopped(); }
    visibleWhen() { return true; }
    execute() { return new Promise<string>(resolve => { finish = resolve; }); }
  }
  const service = createInstanceRegistryService<Registry>({ register(value) { registered = value; return () => value.stop(); } }, capability, {
    name: capability.id, registrations: [{ method: "register" }], cleanupMethods: ["stop"], projectRegistration: input => {
      const lane = input as Lane;
      return { id: lane.id, start: lane.start.bind(lane), stop: lane.stop.bind(lane), visibleWhen: lane.visibleWhen.bind(lane), execute: lane.execute.bind(lane) };
    },
  });
  const host = createKeymasterPluginHost({ runtime: "window-main", capabilities: [{ capability, value: service }], runtimeUnitImplementationRegistry: { get: () => ctx => { context = ctx; } } });
  try {
    await host.register({ id: "contributor", name: "Contributor", units: [{ id: "contributor.window", runtime: "window-main", scopeKind: "root", dependencies: [{ capability, sourceRuntime: "window-main" }] }] });
    const close = context.capability(capability).register(new Lane());
    expect(registered).not.toHaveProperty("privateSecret");
    expect(registered.visibleWhen()).toBe(true);
    registered.start();
    const pending = registered.execute(); const rejected = expect(pending).rejects.toThrow();
    close();
    expect(registered.visibleWhen()).toBe(false);
    expect(() => registered.execute()).toThrow();
    finish("late"); await rejected;
    await host.revoke("contributor", "test");
    expect(stopped).toHaveBeenCalledOnce();
  } finally { await host.dispose(); }
});
