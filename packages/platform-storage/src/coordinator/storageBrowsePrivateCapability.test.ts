import { createFixtureHost as createKeymasterPluginHost } from "@keymaster/runtime/test-support";
import { describe, expect, it, vi } from "vitest";
import { definePlugin, type PluginConsumer, type HandlerCallContext } from "webloom-framework";
import { createWindowAppFromHost, definePrivateCapability } from "webloom-framework/advanced";
import { connectSharedWorkerForTesting, startSharedWorkerAppForTesting, type SharedWorkerScopeLike } from "webloom-framework/testing";
import { attachKeymasterRemoteRuntime, getWebLoomHost } from "@keymaster/runtime/assembly";
import { COORDINATOR_RPC_CAPABILITY, type PluginContext, type PluginManifest } from "@keymaster/contracts";
import { STORAGE_PRIVATE_BROWSE_CAPABILITY as browse, parseStorageBrowsePrivateResponse } from "./storageBrowsePrivateCapability.js";

const request = { kind: "storage.browse.open", expectedSessionEpoch: "epoch-1" } as const;
const result = { sessionEpoch: "epoch-1", ack: { status: "ok" }, operationResult: {
  browseSessionId: "browse-1", walletGeneration: "wallet-1", sessionEpoch: "epoch-1", runGeneration: "run-1",
} } as const;

function manifest(id: string): PluginManifest {
  return { id, name: id, units: [{ id: `${id}.window`, runtime: "window-main", scopeKind: "root" }] };
}

describe("Storage private browse protocol", () => {
  it("keeps root listing and bounds validation inside Storage, while public RPC rejects it", () => {
    const parsed = browse.request.parse({ kind: "storage.browse.data", expectedSessionEpoch: "epoch-1", data: {
      type: "browse.list", browseSessionId: "browse-1", prefix: "", limit: 200,
    } });
    expect(parsed.kind === "storage.browse.data" && parsed.data).toEqual({ type: "browse.list", browseSessionId: "browse-1", prefix: "", limit: 200 });
    expect(() => browse.request.parse({ kind: "storage.browse.data", expectedSessionEpoch: "epoch-1", data: {
      type: "browse.list", browseSessionId: "browse-1", prefix: 1,
    } })).toThrow(/prefix is invalid/);
    expect(() => browse.request.parse({ kind: "storage.browse.data", expectedSessionEpoch: "epoch-1", data: {
      type: "browse.list", browseSessionId: "browse-1", limit: 1001,
    } })).toThrow();
    expect(() => COORDINATOR_RPC_CAPABILITY.request.parse(request)).toThrow();
    expect(parseStorageBrowsePrivateResponse(request, result)).toEqual(result);
    expect(() => parseStorageBrowsePrivateResponse(request, { sessionEpoch: "epoch-1", ack: { status: "ok" } })).toThrow(/missing/);
    expect(() => parseStorageBrowsePrivateResponse(request, { ...result, ack: { status: "blocked", reason: "locked" } })).toThrow(/contains operationResult/);
  });

  it("admits the issued Storage consumer across a real MessagePort, rejects public callers, and revokes old handles", async () => {
    const scope: SharedWorkerScopeLike = { onconnect: null };
    const grants = [definePrivateCapability({ capability: browse, pluginId: "storage", unitId: "storage.window", grantId: "test-only-private-grant" })];
    const handler = vi.fn((_request: unknown, _call: HandlerCallContext): typeof result | Promise<typeof result> => result);
    const worker = startSharedWorkerAppForTesting({ id: "storage-private-test", globalScope: scope, privateCapabilities: grants,
      plugins: [definePlugin({ id: "storage", name: "Storage", runtime: "shared-worker", unitId: "storage.coordinator-worker", privateProvides: [browse],
        setup(ctx) { ctx.handlePrivate(browse, handler); },
      })], expose: [browse],
    });
    await worker.ready();
    const consumers = new Map<string, PluginConsumer>();
    const host = createKeymasterPluginHost({ runtime: "window-main", privateCapabilities: grants,
      runtimeSlotBindings: { [`storage\0storage.window\0rpc\0${browse.id}\0${browse.version}`]: "default" },
      runtimeUnitImplementationRegistry: { get: () => (ctx: PluginContext) => { consumers.set(ctx.pluginId, ctx.consumer); } },
    });
    let runtime: ReturnType<typeof connectSharedWorkerForTesting> | undefined;
    try {
      await host.registerAll([manifest("storage"), manifest("page")]);
      const app = await createWindowAppFromHost({ id: "storage-private-page", host: getWebLoomHost(host) });
      runtime = connectSharedWorkerForTesting({ id: "storage-private-test", url: "test:storage-private", client: { app } }, () => {
        const channel = new MessageChannel();
        queueMicrotask(() => scope.onconnect?.({ ports: [channel.port2] }));
        return { port: channel.port1 };
      });
      attachKeymasterRemoteRuntime(host, runtime);
      await vi.waitFor(() => expect(runtime!.state()).toMatchObject({ state: "ready" }));
      const storage = consumers.get("storage")!;
      const page = consumers.get("page")!;
      expect(() => page.privateCapability(browse)).toThrow(/not granted/);
      expect(() => storage.capability(browse)).toThrow();
      const publicCall = runtime.capability(browse);
      await expect(publicCall.call(request)).rejects.toMatchObject({ code: "permission_denied" });
      expect(handler).not.toHaveBeenCalled();
      const privateCall = storage.privateCapability(browse);
      await expect(privateCall.call(request)).resolves.toEqual(result);
      expect(handler).toHaveBeenCalledTimes(1);
      let inFlightSignal: AbortSignal | undefined;
      let releaseLateResult!: () => void;
      handler.mockImplementationOnce(async (_request, call) => {
        inFlightSignal = call.signal;
        await new Promise<void>(resolve => { releaseLateResult = resolve; });
        return result;
      });
      const pending = privateCall.call(request);
      const rejected = expect(pending).rejects.toBeDefined();
      await vi.waitFor(() => expect(inFlightSignal).toBeDefined());
      await host.revoke("storage", "locked");
      await rejected;
      await vi.waitFor(() => expect(inFlightSignal!.aborted).toBe(true));
      releaseLateResult();
      expect(() => privateCall.call(request)).toThrow();
      expect(() => storage.privateCapability(browse)).toThrow();
      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      await runtime?.dispose();
      await host.dispose();
      await worker.dispose();
    }
  });
});
