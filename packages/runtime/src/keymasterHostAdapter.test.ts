import { describe, expect, it } from "vitest";
import type { RemoteServiceReference, RemoteServiceSnapshot } from "webloom-framework";
import {
  KEYMASTER_REMOTE_SERVICE_MESSAGE_PREFIX,
  createKeymasterPluginHost,
  keymasterRemoteServiceMessageCodec,
} from "./keymasterHostAdapter.js";
import { createRuntimeUnitImplementationRegistry, type RuntimeHandle, type RuntimeStatusSnapshot } from "webloom-framework";

function reference(): RemoteServiceReference {
  return {
    capabilityId: "coordinator.crypto",
    providerInstanceId: "provider:1",
    runtime: "shared-worker",
    contractVersion: "1.0.0",
    authorityInstanceId: "authority:1",
    scopeId: "scope:1",
    handoverGeneration: 2,
    attributes: {
      sessionEpoch: "session:1",
      ownerPublicKeyHex: "02" + "11".repeat(32),
      ownerGeneration: 3,
    },
    status: "ready",
    snapshotRevision: 4,
    grantId: "grant:1",
    authorizationRevision: 1,
  };
}

describe("Keymaster WebLoom legacy service codec", () => {
  it("keeps the legacy message names and field layout on the wire", () => {
    const snapshot: RemoteServiceSnapshot = {
      connectionId: "connection:1",
      authorityInstanceId: "authority:1",
      snapshotRevision: 4,
      baseline: true,
      services: [reference()],
    };

    const encoded = keymasterRemoteServiceMessageCodec.encode({
      type: keymasterRemoteServiceMessageCodec.type("snapshot"),
      snapshot,
    }) as { type: string; snapshot: { services: Array<Record<string, unknown>> } };

    expect(encoded.type).toBe(`${KEYMASTER_REMOTE_SERVICE_MESSAGE_PREFIX}.snapshot`);
    expect(encoded.snapshot.services[0]).toMatchObject({
      sessionEpoch: "session:1",
      ownerPublicKeyHex: "02" + "11".repeat(32),
      ownerGeneration: 3,
    });
    expect(encoded.snapshot.services[0]?.attributes).toBeUndefined();
  });

  it("maps legacy identity fields into WebLoom attributes after decoding", () => {
    const decoded = keymasterRemoteServiceMessageCodec.decode({
      type: `${KEYMASTER_REMOTE_SERVICE_MESSAGE_PREFIX}.snapshot`,
      snapshot: {
        connectionId: "connection:1",
        authorityInstanceId: "authority:1",
        snapshotRevision: 4,
        baseline: true,
        services: [{
          capabilityId: "coordinator.crypto",
          providerInstanceId: "provider:1",
          runtime: "shared-worker",
          contractVersion: "1.0.0",
          authorityInstanceId: "authority:1",
          scopeId: "scope:1",
          handoverGeneration: 2,
          sessionEpoch: "session:1",
          ownerPublicKeyHex: "02" + "11".repeat(32),
          ownerGeneration: 3,
          status: "ready",
          snapshotRevision: 4,
        }],
      },
    });

    const decodedSnapshot = decoded?.snapshot as { services: Array<Record<string, unknown>> };
    expect(decodedSnapshot.services[0]?.attributes).toMatchObject({
      sessionEpoch: "session:1",
      ownerPublicKeyHex: "02" + "11".repeat(32),
      ownerGeneration: 3,
    });
    // Provider 侧仍能在同一解码结果中读取旧字段，最终边界校验无需改 wire schema。
    expect(decodedSnapshot.services[0]?.ownerGeneration).toBe(3);
  });
});

describe("Keymaster Host remote RuntimeHandle projection", () => {
  it("uses the live RuntimeHandle as the service/snapshot source and fails closed on disconnect", async () => {
    const remoteBridge = {} as import("webloom-framework").RemoteServiceBridge;
    let snapshot: RuntimeStatusSnapshot = {
      runtimeId: "coordinator",
      runtimeKind: "shared-worker",
      runtimeInstanceId: "worker-runtime:1",
      connectionId: "connection:1",
      state: "ready",
      snapshotRevision: 1,
      units: [{
        pluginId: "remote-product",
        unitId: "remote-product.worker",
        runtime: "shared-worker",
        instanceId: "remote-unit:1",
        state: "enabled",
      }],
      services: [{
        capabilityId: "remote.service",
        providerInstanceId: "remote-unit:1",
        runtime: "shared-worker",
        contractVersion: "remote.service.v1",
        authorityInstanceId: "worker-runtime:1",
        scopeId: "scope:remote-unit:1",
        handoverGeneration: 0,
        attributes: {},
        status: "ready",
        connectionId: "connection:1",
        snapshotRevision: 1,
      }],
    };
    const listeners = new Set<(nextSnapshot: RuntimeStatusSnapshot) => void>();
    const runtime: RuntimeHandle = {
      runtimeKind: "shared-worker",
      runtimeId: "coordinator",
      runtimeInstanceId: "worker-runtime:1",
      connectionId: "connection:1",
      serviceBridge: remoteBridge,
      state: () => snapshot,
      ready: async () => undefined,
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

    expect(seenBridge).toBe(remoteBridge);
    expect(host.state("remote-product").units).toMatchObject([
      { unitId: "remote-product.worker", kind: "enabled", instanceId: "remote-unit:1" },
      { unitId: "remote-product.window", kind: "enabled" },
    ]);

    snapshot = {
      ...snapshot,
      state: "disconnected",
      snapshotRevision: 2,
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
