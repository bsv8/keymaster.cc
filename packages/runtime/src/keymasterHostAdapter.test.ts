import { describe, expect, it } from "vitest";
import type { RemoteServiceReference, RemoteServiceSnapshot } from "webloom-framework";
import {
  KEYMASTER_REMOTE_SERVICE_MESSAGE_PREFIX,
  keymasterRemoteServiceMessageCodec,
} from "./keymasterHostAdapter.js";

function reference(): RemoteServiceReference {
  return {
    capabilityId: "coordinator.crypto",
    providerInstanceId: "provider:1",
    execution: "coordinator-worker",
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
          execution: "coordinator-worker",
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
