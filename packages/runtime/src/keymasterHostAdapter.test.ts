import { describe, expect, it } from "vitest";
import type { RemoteServiceReference } from "webloom-framework";
import {
  KEYMASTER_REMOTE_SERVICE_MESSAGE_PREFIX,
  createKeymasterPluginHost,
  keymasterRemoteServiceMessageCodec,
} from "./keymasterHostAdapter.js";
import { createRuntimeUnitImplementationRegistry, type RuntimeHandle, type RuntimeStatusSnapshot } from "webloom-framework";

function reference(): RemoteServiceReference {
  return {
    capabilityId: "coordinator.crypto",
    runtime: "shared-worker",
    contractVersion: "1.0.0",
    runtimeInstanceId: "runtime:1",
    serviceInstanceId: "service:1",
    attributes: {
      authorityInstanceId: "authority:1",
      scopeId: "scope:1",
      handoverGeneration: 2,
      sessionEpoch: "session:1",
      ownerPublicKeyHex: "02" + "11".repeat(32),
      ownerGeneration: 3,
    },
    status: "ready",
    grantId: "grant:1",
    authorizationRevision: 1,
  };
}

describe("Keymaster WebLoom v2 service codec", () => {
  it("only carries call lifecycle messages and preserves v2 identity fields", () => {
    const encoded = keymasterRemoteServiceMessageCodec.encode({
      type: keymasterRemoteServiceMessageCodec.type("call"),
      protocolVersion: keymasterRemoteServiceMessageCodec.protocolVersion,
      callId: "call:1",
      capabilityId: reference().capabilityId,
      contractVersion: reference().contractVersion,
      serviceInstanceId: reference().serviceInstanceId,
      grantId: reference().grantId,
      request: { type: "deriveP2pkhAddress" },
    }) as Record<string, unknown>;

    expect(encoded.type).toBe(`${KEYMASTER_REMOTE_SERVICE_MESSAGE_PREFIX}.call`);
    expect(encoded.connectionId).toBeUndefined();
    expect(encoded.reference).toBeUndefined();
    expect(keymasterRemoteServiceMessageCodec.decode(encoded)).toEqual(encoded);
    expect(() => keymasterRemoteServiceMessageCodec.type("snapshot" as never)).toThrow();
  });
});

describe("Keymaster Host remote RuntimeHandle projection", () => {
  it("uses the live RuntimeHandle as the service/snapshot source and fails closed on disconnect", async () => {
    let snapshot: RuntimeStatusSnapshot = {
      runtimeId: "coordinator",
      runtimeKind: "shared-worker",
      runtimeInstanceId: "worker-runtime:1",
      state: "ready",
      revision: 1,
      units: [{
        pluginId: "remote-product",
        unitId: "remote-product.worker",
        runtime: "shared-worker",
        instanceId: "remote-unit:1",
        state: "enabled",
      }],
      services: [{
        capabilityId: "remote.service",
        runtime: "shared-worker",
        contractVersion: "remote.service.v1",
        runtimeInstanceId: "worker-runtime:1",
        serviceInstanceId: "remote-unit:1",
        attributes: {},
        status: "ready",
      }],
    };
    const listeners = new Set<(nextSnapshot: RuntimeStatusSnapshot) => void>();
    const runtime: RuntimeHandle = {
      runtimeKind: "shared-worker",
      runtimeId: "coordinator",
      runtimeInstanceId: "worker-runtime:1",
      state: () => snapshot,
      capability: () => { throw new Error("not used"); },
      subscribe(listener) {
        listeners.add(listener);
        listener(snapshot);
        return () => listeners.delete(listener);
      },
      dispose: async () => undefined,
    };
    const fallbackBridge = {} as import("webloom-framework").RemoteServiceBridge;
    let seenBridge: unknown;
    const host = createKeymasterPluginHost({
      runtime: "window-main",
      remoteRuntime: runtime,
      serviceBridgeForPlugin: () => fallbackBridge,
      runtimeUnitSnapshots: () => [],
      disableConfigPersistence: true,
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([{
        pluginId: "remote-product",
        unitId: "remote-product.window",
        setup(context) {
          seenBridge = context.serviceBridge;
          context.provide("local.service", { ok: true });
        },
      }]),
    });
    await host.register({
      id: "remote-product",
      name: "Remote product",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      units: [
        {
          id: "remote-product.worker",
          runtime: "shared-worker",
          scopeKind: "root",
          provides: ["remote.service"],
          providedContracts: { "remote.service": "remote.service.v1" },
        },
        {
          id: "remote-product.window",
          runtime: "window-main",
          scopeKind: "root",
          dependencies: [{
            capability: "remote.service",
            contractVersion: "remote.service.v1",
            sourceRuntime: "shared-worker",
            scopeKind: "root",
          }],
          provides: ["local.service"],
          providedContracts: { "local.service": "local.service.v1" },
        },
      ],
    });

    expect(seenBridge).toBe(fallbackBridge);
    expect(host.state("remote-product").units).toMatchObject([
      { unitId: "remote-product.worker", kind: "enabled", instanceId: "remote-unit:1" },
      { unitId: "remote-product.window", kind: "enabled" },
    ]);

    snapshot = {
      ...snapshot,
      state: "disconnected",
      revision: 2,
      units: [],
      services: [],
    };
    for (const listener of listeners) listener(snapshot);
    for (let attempt = 0; attempt < 20 && host.state("remote-product").kind === "stopping"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(host.state("remote-product").kind).toBe("blocked");
    expect(host.state("remote-product").blockedBy).toContain("remote.service");
    await host.dispose("test");
  });
});
