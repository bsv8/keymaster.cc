import { describe, expect, it } from "vitest";
import { STORAGE_MAX_PAYLOAD_BYTES } from "@keymaster/contracts";
import type { NormalizedStorageProviderConfig } from "@keymaster/contracts";
import { createS3ObjectStore, createS3ObjectStoreCapabilityState, ensureS3XmlRuntime, mapS3Error, parseContentRange, readBody, s3FetchRequestInit, setS3ObjectStoreCapabilityMode, type S3ClientAdapter } from "./s3ObjectStore.js";
import { StoragePathError } from "./storagePath.js";

const config: NormalizedStorageProviderConfig = {
  version: 1,
  providerId: "aws-s3",
  connection: { region: "us-east-1", bucket: "bucket-name" },
  credentials: { kind: "access-key", accessKeyId: "key", secretAccessKey: "secret" }
};

describe("S3ObjectStore namespace guard", () => {
  it("rejects provider redirects at the fetch boundary", () => {
    expect(s3FetchRequestInit()).toEqual({ redirect: "error" });
  });

  it("installs the XML DOM surface required by S3 inside a SharedWorker", () => {
    const runtime = globalThis as unknown as { DOMParser?: typeof DOMParser; Node?: typeof Node };
    const previousParser = runtime.DOMParser;
    const previousNode = runtime.Node;
    try {
      delete runtime.DOMParser;
      delete runtime.Node;
      ensureS3XmlRuntime();
      const document = new runtime.DOMParser!().parseFromString("<ListBucketResult><Name>bucket</Name></ListBucketResult>", "application/xml");
      expect(document.documentElement.nodeName).toBe("ListBucketResult");
      expect(document.getElementsByTagName("Name")[0]?.textContent).toBe("bucket");
      expect(typeof runtime.Node).toBe("function");
      expect(runtime.Node?.ELEMENT_NODE).toBe(1);
      expect(runtime.Node?.TEXT_NODE).toBe(3);
    } finally {
      if (previousParser) runtime.DOMParser = previousParser; else delete runtime.DOMParser;
      if (previousNode) runtime.Node = previousNode; else delete runtime.Node;
    }
  });

  it("deserializes an S3 XML success response without native Worker DOM globals", async () => {
    const runtime = globalThis as unknown as { DOMParser?: typeof DOMParser; Node?: typeof Node; fetch: typeof fetch };
    const previousParser = runtime.DOMParser;
    const previousNode = runtime.Node;
    const previousFetch = runtime.fetch;
    let requested = false;
    try {
      delete runtime.DOMParser;
      delete runtime.Node;
      runtime.fetch = async () => {
        requested = true;
        return new Response('<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>bucket-name</Name><IsTruncated>false</IsTruncated><MaxKeys>1</MaxKeys><KeyCount>0</KeyCount></ListBucketResult>', {
          status: 200,
          headers: { "content-type": "application/xml", "x-amz-request-id": "request-id" }
        });
      };
      const store = createS3ObjectStore(config);
      try {
        await expect(store.probe("")).resolves.toBeUndefined();
        expect(requested).toBe(true);
      } finally {
        store.dispose();
      }
    } finally {
      runtime.fetch = previousFetch;
      if (previousParser) runtime.DOMParser = previousParser; else delete runtime.DOMParser;
      if (previousNode) runtime.Node = previousNode; else delete runtime.Node;
    }
  });

  it("rejects a sibling key before sending a provider request", async () => {
    const store = createS3ObjectStore(config);
    try {
      await expect(store.get({ namespaceRoot: "tenant/02aaaa/app-a/", key: "tenant/02aaaa/app-b/file" })).rejects.toBeInstanceOf(StoragePathError);
      await expect(store.list({ namespaceRoot: "tenant/02aaaa/app-a/", prefix: "tenant/02aaaa/app-b/", maxKeys: 1 })).rejects.toBeInstanceOf(StoragePathError);
    } finally {
      store.dispose();
    }
  });

  it("applies the final namespace guard to every object operation", async () => {
    const store = createS3ObjectStore(config);
    const input = { namespaceRoot: "tenant/02aaaa/app-a/", key: "tenant/02aaaa/app-b/file" };
    try {
      await expect(store.put({ ...input, bytes: new Uint8Array(0) })).rejects.toBeInstanceOf(StoragePathError);
      await expect(store.head(input)).rejects.toBeInstanceOf(StoragePathError);
      await expect(store.delete({ ...input })).rejects.toBeInstanceOf(StoragePathError);
      await expect(store.createMultipart({ ...input })).rejects.toBeInstanceOf(StoragePathError);
      await expect(store.uploadPart({ ...input, uploadId: "upload", partNumber: 1, bytes: new Uint8Array(0) })).rejects.toBeInstanceOf(StoragePathError);
      await expect(store.completeMultipart({ ...input, uploadId: "upload", parts: [] })).rejects.toBeInstanceOf(StoragePathError);
      await expect(store.abortMultipart({ ...input, uploadId: "upload" })).rejects.toBeInstanceOf(StoragePathError);
    } finally {
      store.dispose();
    }
  });

  it("bounds streamed response accumulation and requires valid ranges", async () => {
    const oversized = (async function* () {
      yield new Uint8Array(STORAGE_MAX_PAYLOAD_BYTES);
      yield new Uint8Array(1);
    })();
    await expect(readBody(oversized)).rejects.toMatchObject({ code: "storage_limit_exceeded" });
    expect(parseContentRange("bytes 4-7/20", 4)).toEqual({ offset: 4, end: 7, totalSize: 20 });
    expect(parseContentRange(undefined, 4, 4)).toEqual({ offset: 4, end: 7, totalSize: 8 });
    expect(() => parseContentRange("bytes 4-7/*", 4)).toThrow("unknown total size");
  });

  it("classifies authentication, conditional conflict and network failures", () => {
    expect(mapS3Error({ $metadata: { httpStatusCode: 401 } })).toMatchObject({ code: "storage_forbidden", diagnostic: "authentication" });
    expect(mapS3Error({ name: "ConditionalRequestConflict" })).toMatchObject({ code: "storage_conflict", diagnostic: "provider" });
    expect(mapS3Error(new TypeError("network failed"))).toMatchObject({ code: "storage_unavailable", diagnostic: "network" });
    expect(mapS3Error({ name: "TypeError", message: "Failed to fetch" })).toMatchObject({ code: "storage_unavailable", diagnostic: "network" });
    expect(mapS3Error({ name: "Error", message: "request failed", cause: { name: "TypeError", message: "Load failed" } })).toMatchObject({ code: "storage_unavailable", diagnostic: "network" });
    expect(mapS3Error({ name: "UnexpectedProviderError", message: "request abcdefghijklmnopqrstuvwxyz012345 failed at https://secret.example/path", $metadata: { httpStatusCode: 418 } }).message)
      .toBe("Storage provider operation failed (HTTP 418; error UnexpectedProviderError; request [redacted] failed at [url])");
  });

  it("captures multipart commands and diagnoses an unexposed ETag", async () => {
    const commands: Array<{ name: string; input: unknown }> = [];
    const responses: unknown[] = [{ ETag: '"etag-part"' }, {}];
    const client: S3ClientAdapter = {
      send: async (command) => {
        commands.push({ name: (command as { constructor: { name: string } }).constructor.name, input: (command as { input: unknown }).input });
        return responses.shift() ?? {};
      },
      destroy: () => undefined
    };
    const store = createS3ObjectStore(config, { client });
    try {
      await expect(store.uploadPart({ namespaceRoot: "tenant/", key: "tenant/file.bin", uploadId: "upload-1", partNumber: 2, bytes: new Uint8Array([1, 2]) })).resolves.toBe("etag-part");
      expect(commands[0]).toMatchObject({ name: "UploadPartCommand", input: { Bucket: "bucket-name", Key: "tenant/file.bin", UploadId: "upload-1", PartNumber: 2 } });
      await expect(store.uploadPart({ namespaceRoot: "tenant/", key: "tenant/file.bin", uploadId: "upload-1", partNumber: 3, bytes: new Uint8Array([3]) })).rejects.toMatchObject({ code: "storage_provider_error", diagnostic: "cors" });
    } finally {
      store.dispose();
    }
  });

  it("falls back after a precise 501/NotImplemented and caches the capability", async () => {
    const commands: Array<{ name: string; input: Record<string, unknown> }> = [];
    let conditionalAttempt = true;
    const client: S3ClientAdapter = {
      send: async (command) => {
        const value = command as { constructor: { name: string }; input: Record<string, unknown> };
        commands.push({ name: value.constructor.name, input: value.input });
        if (value.constructor.name === "PutObjectCommand" && value.input.IfNoneMatch && conditionalAttempt) {
          conditionalAttempt = false;
          throw Object.assign(new Error("unsupported"), { name: "NotImplemented", $metadata: { httpStatusCode: 501 } });
        }
        if (value.constructor.name === "HeadObjectCommand") throw Object.assign(new Error("missing"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
        return { ETag: '"etag"' };
      },
      destroy: () => undefined
    };
    const store = createS3ObjectStore(config, { client });
    try {
      await expect(store.put({ namespaceRoot: "tenant/", key: "tenant/first", bytes: new Uint8Array([1]), ifNoneMatch: "*" })).resolves.toMatchObject({ etag: "etag" });
      await expect(store.put({ namespaceRoot: "tenant/", key: "tenant/second", bytes: new Uint8Array([2]), ifNoneMatch: "*" })).resolves.toMatchObject({ etag: "etag" });
      expect(commands.map(({ name, input }) => ({ name, ifNoneMatch: input.IfNoneMatch }))).toEqual([
        { name: "PutObjectCommand", ifNoneMatch: "*" },
        { name: "HeadObjectCommand", ifNoneMatch: undefined },
        { name: "PutObjectCommand", ifNoneMatch: undefined },
        { name: "HeadObjectCommand", ifNoneMatch: undefined },
        { name: "PutObjectCommand", ifNoneMatch: undefined }
      ]);
      expect(Object.prototype.hasOwnProperty.call(commands[2]!.input, "IfNoneMatch")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(commands[4]!.input, "IfNoneMatch")).toBe(false);
    } finally {
      store.dispose();
    }
  });

  it("reports a conflict when best-effort HEAD finds an existing object", async () => {
    const commands: string[] = [];
    const client: S3ClientAdapter = {
      send: async (command) => {
        const value = command as { constructor: { name: string } };
        commands.push(value.constructor.name);
        if (value.constructor.name === "PutObjectCommand") throw Object.assign(new Error("unsupported"), { Code: "NotImplemented", $metadata: { httpStatusCode: 501 } });
        return {};
      },
      destroy: () => undefined
    };
    const store = createS3ObjectStore(config, { client });
    try {
      await expect(store.put({ namespaceRoot: "tenant/", key: "tenant/existing", bytes: new Uint8Array(0), ifNoneMatch: "*" })).rejects.toMatchObject({ code: "storage_conflict" });
      expect(commands).toEqual(["PutObjectCommand", "HeadObjectCommand"]);
    } finally {
      store.dispose();
    }
  });

  it("falls back for multipart completion after a precise 501 and caches the mode", async () => {
    const commands: Array<{ name: string; input: Record<string, unknown> }> = [];
    const client: S3ClientAdapter = {
      send: async (command) => {
        const value = command as { constructor: { name: string }; input: Record<string, unknown> };
        commands.push({ name: value.constructor.name, input: value.input });
        if (value.constructor.name === "CompleteMultipartUploadCommand" && value.input.IfNoneMatch) {
          throw Object.assign(new Error("unsupported"), { name: "NotImplemented", $metadata: { httpStatusCode: 501 } });
        }
        if (value.constructor.name === "HeadObjectCommand") throw Object.assign(new Error("missing"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
        return { ETag: '"complete-etag"' };
      },
      destroy: () => undefined
    };
    const store = createS3ObjectStore(config, { client });
    try {
      await expect(store.completeMultipart({ namespaceRoot: "tenant/", key: "tenant/multipart", uploadId: "upload", parts: [{ partNumber: 1, etag: "part" }], ifNoneMatch: "*" })).resolves.toMatchObject({ etag: "complete-etag" });
      await expect(store.completeMultipart({ namespaceRoot: "tenant/", key: "tenant/multipart-2", uploadId: "upload-2", parts: [{ partNumber: 1, etag: "part" }], ifNoneMatch: "*" })).resolves.toMatchObject({ etag: "complete-etag" });
      expect(commands.map(({ name, input }) => ({ name, ifNoneMatch: input.IfNoneMatch }))).toEqual([
        { name: "CompleteMultipartUploadCommand", ifNoneMatch: "*" },
        { name: "HeadObjectCommand", ifNoneMatch: undefined },
        { name: "CompleteMultipartUploadCommand", ifNoneMatch: undefined },
        { name: "HeadObjectCommand", ifNoneMatch: undefined },
        { name: "CompleteMultipartUploadCommand", ifNoneMatch: undefined }
      ]);
      expect(Object.prototype.hasOwnProperty.call(commands[2]!.input, "IfNoneMatch")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(commands[4]!.input, "IfNoneMatch")).toBe(false);
    } finally {
      store.dispose();
    }
  });

  it("does not downgrade non-501 provider failures", async () => {
    const commands: string[] = [];
    const client: S3ClientAdapter = {
      send: async (command) => {
        commands.push((command as { constructor: { name: string } }).constructor.name);
        throw Object.assign(new Error("denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
      },
      destroy: () => undefined
    };
    const store = createS3ObjectStore(config, { client });
    try {
      await expect(store.put({ namespaceRoot: "tenant/", key: "tenant/denied", bytes: new Uint8Array(0), ifNoneMatch: "*" })).rejects.toMatchObject({ code: "storage_forbidden" });
      expect(commands).toEqual(["PutObjectCommand"]);
    } finally {
      store.dispose();
    }
  });

  it.each([
    { label: "501 with a different error name", error: { name: "OtherError", $metadata: { httpStatusCode: 501 } } },
    { label: "NotImplemented with a different status", error: { name: "NotImplemented", $metadata: { httpStatusCode: 500 } } }
  ])("does not downgrade $label", async ({ error }) => {
    const commands: string[] = [];
    const client: S3ClientAdapter = {
      send: async (command) => {
        commands.push((command as { constructor: { name: string } }).constructor.name);
        throw Object.assign(new Error("unsupported condition"), error);
      },
      destroy: () => undefined
    };
    const store = createS3ObjectStore(config, { client });
    try {
      await expect(store.put({ namespaceRoot: "tenant/", key: "tenant/not-supported", bytes: new Uint8Array(0), ifNoneMatch: "*" })).rejects.toMatchObject({ code: "storage_provider_error" });
      expect(commands).toEqual(["PutObjectCommand"]);
    } finally {
      store.dispose();
    }
  });

  it.each([
    { label: "409 ConditionalRequestConflict", error: { name: "ConditionalRequestConflict", $metadata: { httpStatusCode: 409 } } },
    { label: "412 PreconditionFailed", error: { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } } }
  ])("locks native after $label and never downgrades a later 501", async ({ error }) => {
    const commands: Array<{ name: string; input: Record<string, unknown> }> = [];
    let attempt = 0;
    const client: S3ClientAdapter = {
      send: async (command) => {
        const value = command as { constructor: { name: string }; input: Record<string, unknown> };
        commands.push({ name: value.constructor.name, input: value.input });
        if (value.constructor.name === "PutObjectCommand") {
          attempt++;
          if (attempt === 1) throw Object.assign(new Error("conflict"), error);
          throw Object.assign(new Error("later unsupported"), { name: "NotImplemented", $metadata: { httpStatusCode: 501 } });
        }
        return { ETag: '"etag"' };
      },
      destroy: () => undefined
    };
    const store = createS3ObjectStore(config, { client });
    try {
      await expect(store.put({ namespaceRoot: "tenant/", key: "tenant/conflict", bytes: new Uint8Array(0), ifNoneMatch: "*" })).rejects.toMatchObject({ code: "storage_conflict" });
      await expect(store.put({ namespaceRoot: "tenant/", key: "tenant/later", bytes: new Uint8Array(0), ifNoneMatch: "*" })).rejects.toMatchObject({ code: "storage_provider_error" });
      expect(commands.map(({ name }) => name)).toEqual(["PutObjectCommand", "PutObjectCommand"]);
      expect(commands.every(({ input }) => input.IfNoneMatch === "*")).toBe(true);
    } finally {
      store.dispose();
    }
  });

  it.each(["put", "complete"] as const)("locks %s native after success and never downgrades a later 501", async (kind) => {
    const commands: Array<{ name: string; input: Record<string, unknown> }> = [];
    let attempt = 0;
    const client: S3ClientAdapter = {
      send: async (command) => {
        const value = command as { constructor: { name: string }; input: Record<string, unknown> };
        commands.push({ name: value.constructor.name, input: value.input });
        if (++attempt === 2) throw Object.assign(new Error("later unsupported"), { name: "NotImplemented", $metadata: { httpStatusCode: 501 } });
        return { ETag: '"etag"' };
      },
      destroy: () => undefined
    };
    const store = createS3ObjectStore(config, { client });
    const invoke = () => kind === "put"
      ? store.put({ namespaceRoot: "tenant/", key: "tenant/native", bytes: new Uint8Array(0), ifNoneMatch: "*" })
      : store.completeMultipart({ namespaceRoot: "tenant/", key: "tenant/native", uploadId: "upload", parts: [], ifNoneMatch: "*" });
    try {
      await expect(invoke()).resolves.toMatchObject({ etag: "etag" });
      await expect(invoke()).rejects.toMatchObject({ code: "storage_provider_error" });
      expect(commands).toHaveLength(2);
      expect(commands.map(({ name }) => name)).toEqual([kind === "put" ? "PutObjectCommand" : "CompleteMultipartUploadCommand", kind === "put" ? "PutObjectCommand" : "CompleteMultipartUploadCommand"]);
      expect(commands.every(({ input }) => input.IfNoneMatch === "*")).toBe(true);
    } finally {
      store.dispose();
    }
  });

  it("keeps unknown after an ordinary probe error so a later request can probe", async () => {
    const commands: Array<{ name: string; input: Record<string, unknown> }> = [];
    let attempt = 0;
    const client: S3ClientAdapter = {
      send: async (command) => {
        const value = command as { constructor: { name: string }; input: Record<string, unknown> };
        commands.push({ name: value.constructor.name, input: value.input });
        if (++attempt === 1) throw new TypeError("network failed");
        return { ETag: '"etag"' };
      },
      destroy: () => undefined
    };
    const store = createS3ObjectStore(config, { client });
    try {
      await expect(store.put({ namespaceRoot: "tenant/", key: "tenant/first", bytes: new Uint8Array(0), ifNoneMatch: "*" })).rejects.toMatchObject({ code: "storage_unavailable" });
      await expect(store.put({ namespaceRoot: "tenant/", key: "tenant/second", bytes: new Uint8Array(0), ifNoneMatch: "*" })).resolves.toMatchObject({ etag: "etag" });
      expect(commands.map(({ name }) => name)).toEqual(["PutObjectCommand", "PutObjectCommand"]);
    } finally {
      store.dispose();
    }
  });

  it("gates concurrent unknown probes and lets a waiting request honor its AbortSignal", async () => {
    let release!: () => void;
    const firstResponse = new Promise<void>((resolve) => { release = resolve; });
    const commands: string[] = [];
    const client: S3ClientAdapter = {
      send: async (command) => {
        commands.push((command as { constructor: { name: string } }).constructor.name);
        await firstResponse;
        return { ETag: '"etag"' };
      },
      destroy: () => undefined
    };
    const store = createS3ObjectStore(config, { client });
    try {
      const first = store.put({ namespaceRoot: "tenant/", key: "tenant/first", bytes: new Uint8Array(0), ifNoneMatch: "*" });
      const cancelled = new AbortController();
      const second = store.put({ namespaceRoot: "tenant/", key: "tenant/second", bytes: new Uint8Array(0), ifNoneMatch: "*", signal: cancelled.signal });
      await Promise.resolve();
      expect(commands).toEqual(["PutObjectCommand"]);
      cancelled.abort();
      await expect(second).rejects.toMatchObject({ code: "storage_unavailable" });
      release();
      await expect(first).resolves.toMatchObject({ etag: "etag" });
      expect(commands).toEqual(["PutObjectCommand"]);
    } finally {
      store.dispose();
    }
  });

  it("lets a waiting request reprobe after the first ordinary probe failure", async () => {
    let release!: () => void;
    const firstResponse = new Promise<void>((resolve) => { release = resolve; });
    const commands: string[] = [];
    let attempt = 0;
    const client: S3ClientAdapter = {
      send: async (command) => {
        commands.push((command as { constructor: { name: string } }).constructor.name);
        if (++attempt === 1) {
          await firstResponse;
          throw new TypeError("temporary network failure");
        }
        return { ETag: '"etag"' };
      },
      destroy: () => undefined
    };
    const store = createS3ObjectStore(config, { client });
    try {
      const first = store.put({ namespaceRoot: "tenant/", key: "tenant/first", bytes: new Uint8Array(0), ifNoneMatch: "*" });
      const second = store.put({ namespaceRoot: "tenant/", key: "tenant/second", bytes: new Uint8Array(0), ifNoneMatch: "*" });
      await Promise.resolve();
      expect(commands).toEqual(["PutObjectCommand"]);
      release();
      await expect(first).rejects.toMatchObject({ code: "storage_unavailable" });
      await expect(second).resolves.toMatchObject({ etag: "etag" });
      expect(commands).toEqual(["PutObjectCommand", "PutObjectCommand"]);
    } finally {
      store.dispose();
    }
  });

  it("maintains independent PUT and multipart capability modes", async () => {
    const state = createS3ObjectStoreCapabilityState();
    const commands: Array<{ name: string; input: Record<string, unknown> }> = [];
    const client: S3ClientAdapter = {
      send: async (command) => {
        const value = command as { constructor: { name: string }; input: Record<string, unknown> };
        commands.push({ name: value.constructor.name, input: value.input });
        if (value.constructor.name === "PutObjectCommand" && value.input.IfNoneMatch) throw Object.assign(new Error("unsupported"), { name: "NotImplemented", $metadata: { httpStatusCode: 501 } });
        if (value.constructor.name === "HeadObjectCommand") throw Object.assign(new Error("missing"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
        return { ETag: '"etag"' };
      },
      destroy: () => undefined
    };
    const store = createS3ObjectStore(config, { client, capabilityState: state });
    try {
      await expect(store.put({ namespaceRoot: "tenant/", key: "tenant/plain", bytes: new Uint8Array(0), ifNoneMatch: "*" })).resolves.toMatchObject({ etag: "etag" });
      await expect(store.completeMultipart({ namespaceRoot: "tenant/", key: "tenant/multipart", uploadId: "upload", parts: [], ifNoneMatch: "*" })).resolves.toMatchObject({ etag: "etag" });
      expect(state.put).toMatchObject({ mode: "best-effort", source: "automatic" });
      expect(state.complete).toMatchObject({ mode: "native", source: "automatic" });
      expect(commands.map(({ name, input }) => ({ name, ifNoneMatch: input.IfNoneMatch }))).toEqual([
        { name: "PutObjectCommand", ifNoneMatch: "*" },
        { name: "HeadObjectCommand", ifNoneMatch: undefined },
        { name: "PutObjectCommand", ifNoneMatch: undefined },
        { name: "CompleteMultipartUploadCommand", ifNoneMatch: "*" }
      ]);
    } finally {
      store.dispose();
    }
  });

  it("does not let an older automatic probe overwrite a newer manual revision", async () => {
    const state = createS3ObjectStoreCapabilityState();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const client: S3ClientAdapter = {
      send: async (command) => {
        if ((command as { constructor: { name: string } }).constructor.name === "PutObjectCommand") { await gate; return { ETag: '"etag"' }; }
        return {};
      },
      destroy: () => undefined
    };
    const store = createS3ObjectStore(config, { client, capabilityState: state });
    try {
      const pending = store.put({ namespaceRoot: "tenant/", key: "tenant/revision", bytes: new Uint8Array(0), ifNoneMatch: "*" });
      await Promise.resolve();
      setS3ObjectStoreCapabilityMode(state, "put", "best-effort", "manual");
      release();
      await expect(pending).resolves.toMatchObject({ etag: "etag" });
      expect(state.put).toMatchObject({ mode: "best-effort", source: "manual" });
    } finally {
      store.dispose();
    }
  });
});
