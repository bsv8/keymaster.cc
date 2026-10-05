/// <reference types="vite/client" />
// 隔离门禁装配，不进入正式 Web dist。使用生产适配器和真正的两个 SharedWorker。
import { connectSharedWorker, type CapabilityClient, type RuntimeHandle } from "webloom-framework";
import { createWindowAppFromHost } from "webloom-framework/advanced";
import { createKeymasterPluginHost, attachKeymasterRemoteRuntime, getWebLoomHost } from "../../../../packages/runtime/src/assembly.js";
import { defineRuntimeUnitDependencies, type PluginContext, type PluginManifest } from "@keymaster/contracts";
import workerUrl from "./runtime.worker.ts?sharedworker&url";
import { identity } from "./capability.js";

const clients = new Map<string, CapabilityClient<typeof identity>>();
const slotKey = (id: string) => `${id}\0${id}.window\0rpc\0${identity.id}\0${identity.version}`;
const manifest = (id: string): PluginManifest => ({ id, name: id, units: [{ id: `${id}.window`, runtime: "window-main", scopeKind: "root",
  dependencies: defineRuntimeUnitDependencies([{ capability: identity, sourceRuntime: "shared-worker" }]),
}] });
const host = createKeymasterPluginHost({ runtime: "window-main", runtimeSlotBindings: { [slotKey("first")]: "a", [slotKey("second")]: "b" },
  runtimeUnitImplementationRegistry: { get: () => (ctx: PluginContext) => {
    if (ctx.pluginId === "local") ctx.handle(identity, () => "local");
    else clients.set(ctx.pluginId, ctx.capability(identity));
  } },
});
const windowApp = await createWindowAppFromHost({ id: `slot-page-${crypto.randomUUID()}`, host: getWebLoomHost(host) });
const runtimes: RuntimeHandle[] = [];
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Runtime slot gate timed out");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function connect(name: string) {
  const runtime = connectSharedWorker({ id: name, name, url: workerUrl, client: { app: windowApp } });
  runtimes.push(runtime);
  await until(() => runtime.state().state === "ready");
  return runtime;
}
const a = await connect("a"), b = await connect("b");
await host.registerAll([manifest("first"), manifest("second"), { id: "local", name: "Local RPC",
  units: [{ id: "local.window", runtime: "window-main", scopeKind: "root", provides: [identity] }],
}]);
if (host.state("first").kind !== "blocked" || host.state("second").kind !== "blocked") {
  throw new Error("Same-name local RPC incorrectly satisfied a remote slot dependency");
}
let unmountA: () => void, unmountB: () => void;
if (new URL(location.href).searchParams.has("reverse")) {
  unmountB = attachKeymasterRemoteRuntime(host, b, "b");
  unmountA = attachKeymasterRemoteRuntime(host, a, "a");
} else {
  unmountA = attachKeymasterRemoteRuntime(host, a, "a");
  unmountB = attachKeymasterRemoteRuntime(host, b, "b");
}
await until(() => host.state("first").kind === "enabled" && host.state("second").kind === "enabled");
async function snapshot() {
  return { first: await clients.get("first")!.call(null), second: await clients.get("second")!.call(null),
    aInstance: a.state().runtimeInstanceId, bInstance: b.state().runtimeInstanceId,
    aConnection: a.binding.connectionId, bConnection: b.binding.connectionId,
    firstInstance: host.state("first").instanceId, secondInstance: host.state("second").instanceId,
  };
}
let detachedB: CapabilityClient<typeof identity> | undefined;
const control = {
  snapshot,
  async replaceA() {
    const old = clients.get("first")!;
    const otherInstance = host.state("second").instanceId;
    const next = await connect("a");
    attachKeymasterRemoteRuntime(host, next, "a");
    unmountA();
    await until(() => clients.get("first") !== old);
    let oldRejected = false;
    try { await old.call(null); } catch { oldRejected = true; }
    return { value: await clients.get("first")!.call(null), oldRejected,
      otherSurvived: host.state("second").instanceId === otherInstance,
      oldConnection: a.binding.connectionId, newConnection: next.binding.connectionId };
  },
  async detachB() {
    const old = clients.get("second")!;
    detachedB = old;
    unmountB();
    await until(() => host.state("second").kind === "blocked");
    let oldRejected = false;
    try { await old.call(null); } catch { oldRejected = true; }
    return { blocked: true, oldRejected, first: await clients.get("first")!.call(null) };
  },
  async restoreB() {
    const old = detachedB!;
    const otherInstance = host.state("first").instanceId;
    const next = await connect("b");
    unmountB = attachKeymasterRemoteRuntime(host, next, "b");
    await until(() => host.state("second").kind === "enabled" && clients.get("second") !== old);
    let oldRejected = false;
    try { await old.call(null); } catch { oldRejected = true; }
    return { value: await clients.get("second")!.call(null), oldRejected,
      otherSurvived: host.state("first").instanceId === otherInstance };
  },
  async close() { await host.dispose(); await Promise.all(runtimes.map(runtime => runtime.dispose())); },
};
(globalThis as unknown as { slotGate: typeof control }).slotGate = control;
document.body.textContent = "ready";
