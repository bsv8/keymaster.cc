import { describe, expect, it } from "vitest";
import { CENTRAL_STORAGE_DECLARATIONS } from "./storage/systemStorageDeclarations.js";
import {
  COORDINATOR_RESPONSE_RESULT_PARSERS,
  COORDINATOR_LOCAL_STORAGE_RPC_CAPABILITY,
  COORDINATOR_OWNER_STORAGE_RPC_CAPABILITY,
  COORDINATOR_RPC_CAPABILITY,
  COORDINATOR_TOPIC_STREAM_CAPABILITY,
  parseCoordinatorResponseFor,
  toCoordinatorRpcRequest,
} from "./sessionCoordinatorRuntime.js";
import type { CoordinatorRpcRequest } from "./sessionCoordinatorRuntime.js";

function parse(parser: { parse(value: never): unknown }, value: unknown): unknown {
  return parser.parse(value as never);
}

function catalogEntry() {
  return {
    bucketId: "bucket-1",
    label: "Local",
    backend: "local",
    configRevision: 1,
    keyDerivation: {
      algorithm: "pbkdf2-hmac-sha-256",
      passwordEncoding: "utf-8",
      iterations: 100_000,
      outputLengthBits: 256,
      saltB64Url: "salt",
    },
    encryptedConfig: {
      cipher: {
        algorithm: "aes-gcm",
        keyLengthBits: 256,
        ivB64Url: "iv",
        tagLengthBits: 128,
        ciphertextAndTagB64Url: "ciphertext",
      },
    },
    snapshotRevision: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function rpcRequest(kind: CoordinatorRpcRequest["kind"], nested: Record<string, unknown> = {}): CoordinatorRpcRequest {
  return { kind, ...nested } as unknown as CoordinatorRpcRequest;
}

describe("Coordinator runtime contract parsers", () => {
  it("accepts the initial platform schema version through the full response boundary", () => {
    const request = {
      kind: "storage.platform.bind",
      pluginId: "vault",
      declaration: CENTRAL_STORAGE_DECLARATIONS.storageMultipartUploads,
      expectedSessionEpoch: "epoch-1",
    } as const satisfies CoordinatorRpcRequest;
    const grant = {
      platformGrantId: "platform-1",
      bucketId: "bucket-1",
      bucketGeneration: 1,
      moduleId: CENTRAL_STORAGE_DECLARATIONS.storageMultipartUploads.moduleId,
      purposeId: CENTRAL_STORAGE_DECLARATIONS.storageMultipartUploads.purposeId,
      authority: CENTRAL_STORAGE_DECLARATIONS.storageMultipartUploads.authority,
      model: CENTRAL_STORAGE_DECLARATIONS.storageMultipartUploads.model,
      schemaVersion: CENTRAL_STORAGE_DECLARATIONS.storageMultipartUploads.schemaVersion,
      sessionEpoch: "epoch-1",
    };
    const response = { sessionEpoch: "epoch-1", ack: { status: "ok" }, operationResult: grant };
    const parsedRequest = COORDINATOR_RPC_CAPABILITY.request.parse(request);
    // Worker 先做 request-aware 校验，transport 校验 DTO，页面再次校验结果。
    const workerResponse = parseCoordinatorResponseFor(parsedRequest, response);
    const delivered = COORDINATOR_RPC_CAPABILITY.response.parse(structuredClone(workerResponse));
    expect(parseCoordinatorResponseFor(request, delivered).operationResult).toEqual(grant);

    for (const schemaVersion of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "1", undefined]) {
      expect(() => parseCoordinatorResponseFor(request, {
        ...response, operationResult: { ...grant, schemaVersion },
      })).toThrow(/schemaVersion/);
    }
  });

  it("rejects unknown RPC kinds and transport identity before dispatch", () => {
    expect(() => parse(COORDINATOR_RPC_CAPABILITY.request, { kind: "made-up" })).toThrow();
    expect(() => parse(COORDINATOR_RPC_CAPABILITY.request, { kind: "session.close", requestId: "forged" })).toThrow();
  });

  it("rebuilds owner storage requests instead of retaining unvalidated fields", () => {
    const result = parse(COORDINATOR_OWNER_STORAGE_RPC_CAPABILITY.request, {
      type: "owner.put",
      storageGrantId: "grant",
      key: "settings",
      value: { enabled: true },
      condition: { ifRevision: 3, partition: "default" },
      extraCapability: { postMessage() {} },
    }) as Record<string, unknown>;
    expect(result).toEqual({
      type: "owner.put",
      storageGrantId: "grant",
      key: "settings",
      value: { enabled: true },
      condition: { ifRevision: 3, partition: "default" },
    });
    expect(() => parse(COORDINATOR_OWNER_STORAGE_RPC_CAPABILITY.request, {
      type: "owner.put",
      storageGrantId: "grant",
      key: "settings",
      value: { invalid: 1n },
    })).toThrow();
  });

  it("accepts only valid recovery enums and typed acknowledgement values", () => {
    expect(() => parse(COORDINATOR_LOCAL_STORAGE_RPC_CAPABILITY.request, {
      type: "initial-setup-recovery-write",
      record: {
        format: "keymaster.storage.initial-setup-recovery",
        version: 1,
        transactionId: "tx-1",
        bucketId: "bucket-1",
        configRevision: 1,
        snapshotRevision: 0,
        backend: "local",
        phase: "not-a-phase",
        catalog: "empty",
        runtimeInstalled: false,
        cleanup: "unconfirmed",
        status: "failed",
        updatedAt: 1,
      },
    })).toThrow();

    const response = parse(COORDINATOR_RPC_CAPABILITY.response, {
      sessionEpoch: "epoch-1",
      ack: { status: "blocked", reason: { key: "blocked", fallback: "Blocked", values: { count: 1 } } },
      operationResult: { ok: true },
    }) as Record<string, unknown>;
    expect(response).toEqual({
      sessionEpoch: "epoch-1",
      ack: { status: "blocked", reason: { key: "blocked", fallback: "Blocked", values: { count: 1 } } },
      operationResult: { ok: true },
    });
    expect(() => parse(COORDINATOR_RPC_CAPABILITY.response, {
      sessionEpoch: "epoch-1",
      ack: { status: "blocked", reason: { key: "blocked", fallback: "Blocked", values: { nested: {} } } },
    })).toThrow();
  });

  it("preserves an own undefined result so strict callers can distinguish it from absence", () => {
    const response = parse(COORDINATOR_RPC_CAPABILITY.response, {
      sessionEpoch: "epoch-1",
      ack: { status: "ok" },
      operationResult: undefined,
    }) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(response, "operationResult")).toBe(true);
  });

  it("uses topic/type discriminators and strips unknown event fields", () => {
    const result = parse(COORDINATOR_TOPIC_STREAM_CAPABILITY.item, {
      topic: "session.state",
      type: "session.state.changed",
      sessionRevision: 1,
      sessionEpoch: "epoch-1",
      cause: "bootstrap",
      vaultStatus: "locked",
      activePublicKeyHex: null,
      selectedPublicKeyHex: null,
      keyspaceGeneration: 0,
      untrusted: { postMessage() {} },
    }) as Record<string, unknown>;
    expect(result).toEqual({
      topic: "session.state",
      type: "session.state.changed",
      sessionRevision: 1,
      sessionEpoch: "epoch-1",
      cause: "bootstrap",
      vaultStatus: "locked",
      activePublicKeyHex: null,
      selectedPublicKeyHex: null,
      keyspaceGeneration: 0,
    });
    expect(() => parse(COORDINATOR_TOPIC_STREAM_CAPABILITY.item, {
      topic: "session.state",
      type: "session.state.changed.forged",
      sessionRevision: 1,
      sessionEpoch: "epoch-1",
      cause: "bootstrap",
      vaultStatus: "locked",
      activePublicKeyHex: null,
      keyspaceGeneration: 0,
    })).toThrow();
  });

  it("parses channel baselines and typed Sat incoming events", () => {
    expect(parse(COORDINATOR_TOPIC_STREAM_CAPABILITY.item, {
      topic: "channel.events",
      type: "channel.message.received",
      channelRevision: 0,
      sessionEpoch: "epoch-1",
    })).toEqual({
      topic: "channel.events",
      type: "channel.message.received",
      channelRevision: 0,
      sessionEpoch: "epoch-1",
    });
    expect(parse(COORDINATOR_TOPIC_STREAM_CAPABILITY.item, {
      topic: "channel.events",
      type: "channel.subscription.changed",
      channelRevision: 1,
      sessionEpoch: "epoch-1",
      subscriptionStatuses: [{
        channel: "topic",
        phase: "subscribed",
        errorCode: null,
        errorMessage: null,
        updatedAtMs: 1,
      }],
    })).toEqual({
      topic: "channel.events",
      type: "channel.subscription.changed",
      channelRevision: 1,
      sessionEpoch: "epoch-1",
      subscriptionStatuses: [{
        channel: "topic",
        phase: "subscribed",
        errorCode: null,
        errorMessage: null,
        updatedAtMs: 1,
      }],
    });
    expect(parse(COORDINATOR_TOPIC_STREAM_CAPABILITY.item, {
      topic: "sat.events",
      type: "sat.events.changed",
      satRevision: 1,
      sessionEpoch: "epoch-1",
      event: {
        type: "incoming",
        event: {
          deliveryId: "delivery-1",
          ingressSupplierId: "supplier-1",
          channel: "topic",
          requestIdHex: "aa",
          contentJson: new Uint8Array([123, 125]),
          chargedAmount: "0.125",
          receivedAtMs: 1,
        },
      },
    })).toMatchObject({
      topic: "sat.events",
      event: { type: "incoming", event: { chargedAmount: "0.125" } },
    });
  });

  it("selects a typed response parser by request kind", () => {
    expect(COORDINATOR_RESPONSE_RESULT_PARSERS["storage.control"]).toBeTypeOf("function");
    expect(parseCoordinatorResponseFor(rpcRequest("storage.control", { control: { type: "status" } }), {
      sessionEpoch: "epoch-1", ack: { status: "ok" }, operationResult: "ready",
    }).operationResult).toBe("ready");
  });

  it("parses each typed result after the generic capability envelope", () => {
    const grant = parseCoordinatorResponseFor(rpcRequest("storage.owner.bind"), {
      sessionEpoch: "epoch-1",
      ack: { status: "ok" },
      operationResult: {
        storageGrantId: "grant-1",
        bucketId: "bucket-1",
        bucketGeneration: 2,
        ownerPublicKeyHex: "02" + "11".repeat(32),
        moduleId: "message",
        purposeId: "history",
        authority: "built-in-module",
        model: "kv",
        schemaVersion: 1,
        sessionEpoch: "epoch-1",
        private: "discard",
      },
    });
    expect(grant.operationResult).toEqual({
      storageGrantId: "grant-1",
      bucketId: "bucket-1",
      bucketGeneration: 2,
      ownerPublicKeyHex: "02" + "11".repeat(32),
      moduleId: "message",
      purposeId: "history",
      authority: "built-in-module",
      model: "kv",
      schemaVersion: 1,
      sessionEpoch: "epoch-1",
    });
    expect(() => parseCoordinatorResponseFor(rpcRequest("storage.owner.delete"), {
      sessionEpoch: "epoch-1",
      ack: { status: "ok" },
      operationResult: false,
    })).toThrow();
  });

  it("accepts an empty files purposeId in owner grants", () => {
    const grant = parseCoordinatorResponseFor(rpcRequest("storage.owner.bind"), {
      sessionEpoch: "epoch-1",
      ack: { status: "ok" },
      operationResult: {
        storageGrantId: "grant-1",
        bucketId: "bucket-1",
        bucketGeneration: 2,
        ownerPublicKeyHex: "02" + "11".repeat(32),
        moduleId: "p2p",
        // files 模型允许空 purposeId,表示模块根(webRTC p2p/setting.json)。
        purposeId: "",
        authority: "built-in-module",
        model: "files",
        schemaVersion: 1,
        sessionEpoch: "epoch-1",
      },
    });
    expect(grant.operationResult).toMatchObject({ moduleId: "p2p", purposeId: "", model: "files" });
  });

  it("accepts an empty owner file-list prefix and parses owner file results", () => {
    const request = toCoordinatorRpcRequest({
      kind: "storage.owner.data",
      data: { type: "owner.file-list", storageGrantId: "grant-1", input: { prefix: "" } },
      expectedSessionEpoch: "epoch-1",
    } as never) as Extract<CoordinatorRpcRequest, { kind: "storage.owner.data" }>;
    expect(request.data).toEqual({
      type: "owner.file-list",
      storageGrantId: "grant-1",
      input: { prefix: "" },
    });

    const listed = parseCoordinatorResponseFor(request, {
      sessionEpoch: "epoch-1",
      ack: { status: "ok" },
      operationResult: { files: [{ path: "02aa.json", size: 12 }] },
    });
    expect(listed.operationResult).toEqual({ files: [{ path: "02aa.json", size: 12 }] });

    const read = parseCoordinatorResponseFor(
      rpcRequest("storage.owner.data", { data: { type: "owner.file-get", storageGrantId: "grant-1", path: "02aa.json" } }),
      {
        sessionEpoch: "epoch-1",
        ack: { status: "ok" },
        operationResult: { path: "02aa.json", bytes: new Uint8Array([1, 2]) },
      },
    );
    expect((read.operationResult as { bytes: Uint8Array }).bytes).toBeInstanceOf(Uint8Array);
    expect(() => parseCoordinatorResponseFor(
      rpcRequest("storage.owner.data", { data: { type: "owner.file-get", storageGrantId: "grant-1", path: "02aa.json" } }),
      { sessionEpoch: "epoch-1", ack: { status: "ok" }, operationResult: { path: "02aa.json" } },
    )).toThrow(/bytes is invalid/);
  });

  it("enforces request-aware result presence, void responses, and failure fencing", () => {
    expect(() => parseCoordinatorResponseFor(rpcRequest("storage.grant"), {
      sessionEpoch: "epoch-1",
      ack: { status: "ok" },
    })).toThrow(/missing operationResult/);
    expect(() => parseCoordinatorResponseFor(rpcRequest("lock"), {
      sessionEpoch: "epoch-1",
      ack: { status: "ok" },
      operationResult: undefined,
    })).toThrow(/void response/);
    expect(() => parseCoordinatorResponseFor(rpcRequest("storage.grant"), {
      sessionEpoch: "epoch-1",
      ack: { status: "validation-error", message: "bad" },
      operationResult: "forged-grant",
    })).toThrow(/failure contains operationResult/);
    expect(parseCoordinatorResponseFor(rpcRequest("storage.owner.data", { data: { type: "owner.delete" } }), {
      sessionEpoch: "epoch-1",
      ack: { status: "ok" },
    })).toMatchObject({ ack: { status: "ok" } });
  });

  it("dispatches nested Vault and crypto results by the complete request", () => {
    const key = {
      publicKeyHex: "02" + "11".repeat(32),
      label: "Primary",
      capabilities: ["p2pkh"],
      createdAt: "2026-01-01T00:00:00.000Z",
      format: "generated",
    };
    expect(parseCoordinatorResponseFor(rpcRequest("vault.operation", { operation: { type: "listKeys" } }), {
      sessionEpoch: "epoch-1",
      ack: { status: "ok" },
      operationResult: [key],
    }).operationResult).toEqual([key]);
    expect(() => parseCoordinatorResponseFor(rpcRequest("vault.operation", { operation: { type: "verifyPassword" } }), {
      sessionEpoch: "epoch-1",
      ack: { status: "ok" },
      operationResult: key,
    })).toThrow();

    const cryptoRequest = rpcRequest("crypto", { operation: { type: "signDigest", format: "der" } });
    expect(parseCoordinatorResponseFor(cryptoRequest, {
      sessionEpoch: "epoch-1",
      ack: { status: "ok" },
      cryptoResult: { type: "signDigest", format: "der", signatureHex: "aa" },
    }).cryptoResult).toEqual({ type: "signDigest", format: "der", signatureHex: "aa" });
    expect(() => parseCoordinatorResponseFor(cryptoRequest, {
      sessionEpoch: "epoch-1",
      ack: { status: "ok" },
      cryptoResult: { type: "deriveP2pkhAddress", address: "1" },
    })).toThrow();
  });

  it("revalidates every binary storage-data branch and strips nested extras", () => {
    const put = parse(COORDINATOR_RPC_CAPABILITY.request, {
      kind: "storage.data",
      data: {
        type: "put",
        grantId: "grant-1",
        input: {
          path: "data.bin",
          content: { $type: "binary", bytes: new ArrayBuffer(2), extra: "discard" },
          overwrite: true,
          extraInput: "discard",
        },
      },
      expectedSessionEpoch: "epoch-1",
    }) as Record<string, unknown>;
    expect(put).toEqual({
      kind: "storage.data",
      data: {
        type: "put",
        grantId: "grant-1",
        input: { path: "data.bin", content: { $type: "binary", bytes: expect.any(ArrayBuffer) }, overwrite: true },
      },
      expectedSessionEpoch: "epoch-1",
    });
    expect(() => parse(COORDINATOR_RPC_CAPABILITY.request, {
      kind: "storage.data",
      data: { type: "put", grantId: "grant-1", input: { path: "data.bin", content: { $type: "binary", bytes: "not-binary" } } },
      expectedSessionEpoch: "epoch-1",
    })).toThrow();
    expect(() => parse(COORDINATOR_RPC_CAPABILITY.request, {
      kind: "storage.data",
      data: { type: "upload-part", grantId: "grant-1", input: { uploadId: "upload-1", partNumber: 1, content: { $type: "binary", bytes: new Uint8Array([1]) } } },
      expectedSessionEpoch: "epoch-1",
    })).toThrow();
  });

  it("accepts only bounded JSON records for P2PKH provider configuration", () => {
    const valid = parse(COORDINATOR_RPC_CAPABILITY.request, {
      kind: "p2pkh.provider-config.update",
      providerId: "provider-1",
      config: { endpoint: "https://example.test", retry: { enabled: true, limits: [1, 2, null] } },
      expectedSessionEpoch: "epoch-1",
      ignored: "discard",
    }) as Record<string, unknown>;
    expect(valid).toEqual({
      kind: "p2pkh.provider-config.update",
      providerId: "provider-1",
      config: { endpoint: "https://example.test", retry: { enabled: true, limits: [1, 2, null] } },
      expectedSessionEpoch: "epoch-1",
    });

    for (const config of [
      { value: 1n },
      ["not", "a", "record"],
      new Map([["enabled", true]]),
      { value: Number.POSITIVE_INFINITY },
    ]) {
      expect(() => parse(COORDINATOR_RPC_CAPABILITY.request, {
        kind: "p2pkh.provider-config.update", providerId: "provider-1", config, expectedSessionEpoch: "epoch-1",
      })).toThrow();
    }

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => parse(COORDINATOR_RPC_CAPABILITY.request, {
      kind: "p2pkh.provider-config.update", providerId: "provider-1", config: cyclic, expectedSessionEpoch: "epoch-1",
    })).toThrow(/cycle/);

    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "endpoint", { enumerable: true, get: () => "must-not-read" });
    expect(() => parse(COORDINATOR_RPC_CAPABILITY.request, {
      kind: "p2pkh.provider-config.update", providerId: "provider-1", config: accessor, expectedSessionEpoch: "epoch-1",
    })).toThrow();
  });

  it("selects each request-aware response family instead of the outer kind alone", () => {
    const response = (request: CoordinatorRpcRequest, operationResult: unknown) => parseCoordinatorResponseFor(request, {
      sessionEpoch: "epoch-1",
      ack: { status: "ok" },
      operationResult,
    });

    expect(response(rpcRequest("storage.control", { control: { type: "status" } }), "ready").operationResult).toBe("ready");
    expect(response(rpcRequest("storage.data", { data: { type: "list" } }), {
      prefix: "/",
      parentPrefix: "/",
      directories: [],
      files: [],
    }).operationResult).toEqual({ prefix: "/", parentPrefix: "/", directories: [], files: [] });

    const ownerEntry = { key: "settings", value: { enabled: true }, revision: 1, updatedAt: 2 };
    expect(response(rpcRequest("storage.owner.data", { data: { type: "owner.get" } }), ownerEntry).operationResult).toEqual(ownerEntry);
    expect(response(rpcRequest("storage.platform.data", { data: { type: "platform.get" } }), ownerEntry).operationResult).toEqual(ownerEntry);

    expect(response(rpcRequest("msfile.control", { control: { type: "settings.mediaBlockReadConcurrency.get" } }), 2).operationResult).toBe(2);
    expect(response(rpcRequest("msfile.data", { data: { type: "read-seed" } }), {
      contentHashHex: "aa",
      content: { $type: "binary", bytes: new ArrayBuffer(0) },
    }).operationResult).toEqual({ contentHashHex: "aa", content: { $type: "binary", bytes: expect.any(ArrayBuffer) } });

    expect(response(rpcRequest("sat.operation", { operation: { type: "ensure" } }), null).operationResult).toBeNull();
    expect(response(rpcRequest("channel.operation", { operation: { type: "release" } }), null).operationResult).toBeNull();

    const key = {
      publicKeyHex: "02" + "11".repeat(32),
      label: "Primary",
      capabilities: ["p2pkh"],
      createdAt: "2026-01-01T00:00:00.000Z",
      format: "generated",
    };
    expect(response(rpcRequest("vault.operation", { operation: { type: "listKeys" } }), [key]).operationResult).toEqual([key]);

    expect(parseCoordinatorResponseFor(rpcRequest("crypto", { operation: { type: "signDigest", format: "der" } }), {
      sessionEpoch: "epoch-1",
      ack: { status: "ok" },
      cryptoResult: { type: "signDigest", format: "der", signatureHex: "aa" },
    }).cryptoResult).toEqual({ type: "signDigest", format: "der", signatureHex: "aa" });

    expect(response(rpcRequest("p2pkh.provider-config.get", { providerId: "woc" }), {
      endpoint: "https://example.test",
      limits: [1, 2],
    }).operationResult).toEqual({ endpoint: "https://example.test", limits: [1, 2] });
  });

  it("rejects transport identity on both sides of the Coordinator RPC boundary", () => {
    expect(() => parse(COORDINATOR_RPC_CAPABILITY.request, {
      kind: "session.close", clientId: "forged",
    })).toThrow();
    expect(() => parse(COORDINATOR_RPC_CAPABILITY.request, {
      kind: "session.close", operationId: "forged",
    })).toThrow();
    expect(parse(COORDINATOR_RPC_CAPABILITY.request, {
      kind: "window-p2p.executor.identity.sign-peer-record",
      leaseId: "lease-1",
      expectedSessionEpoch: "epoch-1",
      peerId: "12D3KooWBusinessPeer",
      addresses: [],
      sequence: "0",
    })).toMatchObject({ peerId: "12D3KooWBusinessPeer" });
    expect(() => parse(COORDINATOR_RPC_CAPABILITY.request, {
      kind: "window-p2p.executor.identity.sign-peer-record",
      clientId: "forged",
      leaseId: "lease-1",
      expectedSessionEpoch: "epoch-1",
      peerId: "12D3KooWBusinessPeer",
      addresses: [],
      sequence: "0",
    })).toThrow();
    expect(() => parse(COORDINATOR_RPC_CAPABILITY.response, {
      sessionEpoch: "epoch-1", ack: { status: "ok" }, requestId: "forged",
    })).toThrow();
    expect(() => parse(COORDINATOR_RPC_CAPABILITY.response, {
      sessionEpoch: "epoch-1", ack: { status: "ok" }, callId: "forged",
    })).toThrow();
  });
});
