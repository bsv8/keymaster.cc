import { describe, expect, it } from "vitest";
import type { NormalizedStorageProviderConfig, StorageAppContext, VaultSealedSecret } from "@keymaster/contracts";
import type { S3ObjectStore, S3ObjectStoreCapabilityState } from "./s3ObjectStore.js";
import { createStorageService } from "./storageService.js";
import { setS3ObjectStoreCapabilityMode } from "./s3ObjectStore.js";
import { createConnectObjectStoreFixture } from "./s3DiskObjectStoreFixture.js";
import type { StorageDb, StoredMultipartUploadRecord, StoredProviderConfigRecord } from "./storageDb.js";
import { StorageServiceError } from "./storageErrors.js";
import { STORAGE_MAX_PAYLOAD_BYTES, STORAGE_PART_SIZE_BYTES } from "@keymaster/contracts";

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(value: string): Uint8Array {
  const result = new Uint8Array(value.length / 2);
  for (let i = 0; i < result.length; i++) result[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return result;
}

function makeDb(): StorageDb & { uploads: Map<string, StoredMultipartUploadRecord> } {
  let provider: StoredProviderConfigRecord | null = null;
  const uploads = new Map<string, StoredMultipartUploadRecord>();
  return Object.assign({
    getProviderConfig: async () => provider,
    replaceProviderConfig: async (value: StoredProviderConfigRecord) => { provider = value; },
    clearProviderConfig: async () => { provider = null; uploads.clear(); },
    resetStorage: async () => { provider = null; uploads.clear(); },
    putMultipart: async (value: StoredMultipartUploadRecord) => { uploads.set(value.internalUploadId, value); },
    getMultipart: async (value: string) => uploads.get(value) ?? null,
    deleteMultipart: async (value: string) => { uploads.delete(value); },
    listMultiparts: async () => [...uploads.values()],
    close: () => undefined
  }, { uploads });
}

function makeSecret() {
  return {
    seal: async (_scope: string, plaintext: Uint8Array): Promise<VaultSealedSecret> => ({ version: 1, saltHex: "", nonceHex: "", ciphertextHex: bytesToHex(plaintext) }),
    open: async (_scope: string, sealed: VaultSealedSecret) => hexToBytes(sealed.ciphertextHex)
  };
}

function makeStore(calls: { listPrefixes: string[]; abortedUploads?: string[] }): S3ObjectStore {
  const objects = new Map<string, Uint8Array>();
  let uploadNumber = 0;
  const multipart = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  return {
    async probe() {},
    async list(input) {
      calls.listPrefixes.push(input.prefix);
      const entries = [...objects.entries()].filter(([key]) => key.startsWith(input.prefix));
      const common = new Set<string>();
      const direct = entries.flatMap(([key, value]) => {
        const suffix = key.slice(input.prefix.length);
        const slash = suffix.indexOf("/");
        if (input.delimiter && slash >= 0) {
          common.add(`${input.prefix}${suffix.slice(0, slash + 1)}`);
          return [];
        }
        return [{ key, size: value.byteLength, etag: `etag-${key}` }];
      });
      return { objects: direct, commonPrefixes: [...common], nextContinuationToken: input.continuationToken ? undefined : "page-2" };
    },
    async put(input) {
      if (input.ifNoneMatch === "*" && objects.has(input.key)) throw new StorageServiceError("storage_conflict");
      objects.set(input.key, new Uint8Array(input.bytes));
      return { etag: `etag-${input.key}` };
    },
    async head(input) { return objects.has(input.key); },
    async get(input) {
      const value = objects.get(input.key);
      if (!value) throw new StorageServiceError("storage_not_found");
      const match = input.range ? /^bytes=(\d+)-(\d+)$/u.exec(input.range) : null;
      const start = match ? Number(match[1]) : 0;
      const end = match ? Math.min(Number(match[2]), value.length - 1) : value.length - 1;
      return { bytes: value.slice(start, end + 1), totalSize: value.length, etag: `etag-${input.key}` };
    },
    async delete(input) { objects.delete(input.key); },
    async createMultipart(input) {
      const id = `s3-upload-${++uploadNumber}`;
      multipart.set(id, { key: input.key, parts: new Map() });
      return id;
    },
    async uploadPart(input) {
      const upload = multipart.get(input.uploadId);
      if (!upload) throw new StorageServiceError("storage_not_found");
      upload.parts.set(input.partNumber, new Uint8Array(input.bytes));
      return `part-${input.partNumber}`;
    },
    async completeMultipart(input) {
      const upload = multipart.get(input.uploadId);
      if (!upload) throw new StorageServiceError("storage_not_found");
      if (input.ifNoneMatch === "*" && objects.has(upload.key)) throw new StorageServiceError("storage_conflict");
      const value = new Uint8Array(input.parts.reduce((size, part) => size + (multipart.get(input.uploadId)?.parts.get(part.partNumber)?.byteLength ?? 0), 0));
      let offset = 0;
      for (const part of input.parts) { const chunk = upload.parts.get(part.partNumber)!; value.set(chunk, offset); offset += chunk.byteLength; }
      objects.set(upload.key, value); multipart.delete(input.uploadId);
      return { etag: `etag-${upload.key}` };
    },
    async abortMultipart(input) { multipart.delete(input.uploadId); calls.abortedUploads?.push(input.uploadId); },
    dispose() {}
  };
}

type CapabilityBehavior = "native" | "best-effort" | "silent" | "inconclusive" | "second-error";
interface CapabilityCall { operation: string; namespaceRoot: string; key: string; uploadId?: string; }

function makeCapabilityStore(state: S3ObjectStoreCapabilityState, behavior: { put: CapabilityBehavior; complete: CapabilityBehavior }, options: { cleanupFailure?: boolean; calls?: CapabilityCall[]; gate?: Promise<void> } = {}): S3ObjectStore {
  const base = makeStore({ listPrefixes: [] });
  const putAttempts = new Map<string, number>();
  const completeAttempts = new Map<string, number>();
  return {
    ...base,
    async put(input) {
      options.calls?.push({ operation: "put", namespaceRoot: input.namespaceRoot, key: input.key });
      if (input.ifNoneMatch) {
        const attempt = (putAttempts.get(input.key) ?? 0) + 1;
        putAttempts.set(input.key, attempt);
        if (attempt === 1) {
          if (options.gate) await options.gate;
          if (behavior.put === "inconclusive") throw new StorageServiceError("storage_provider_error");
          setS3ObjectStoreCapabilityMode(state, "put", behavior.put === "best-effort" ? "best-effort" : "native", "automatic");
          return base.put(input);
        }
        if (behavior.put === "silent") return base.put({ ...input, ifNoneMatch: undefined });
        if (behavior.put === "second-error") throw new StorageServiceError("storage_provider_error");
        throw new StorageServiceError("storage_conflict");
      }
      return base.put(input);
    },
    async completeMultipart(input) {
      options.calls?.push({ operation: "complete", namespaceRoot: input.namespaceRoot, key: input.key, uploadId: input.uploadId });
      if (input.ifNoneMatch) {
        const attempt = (completeAttempts.get(input.key) ?? 0) + 1;
        completeAttempts.set(input.key, attempt);
        if (attempt === 1) {
          if (behavior.complete === "inconclusive") throw new StorageServiceError("storage_provider_error");
          setS3ObjectStoreCapabilityMode(state, "complete", behavior.complete === "best-effort" ? "best-effort" : "native", "automatic");
          return base.completeMultipart(input);
        }
        if (behavior.complete === "silent") return base.completeMultipart({ ...input, ifNoneMatch: undefined });
        if (behavior.complete === "second-error") throw new StorageServiceError("storage_provider_error");
        throw new StorageServiceError("storage_conflict");
      }
      return base.completeMultipart(input);
    },
    async createMultipart(input) { options.calls?.push({ operation: "create", namespaceRoot: input.namespaceRoot, key: input.key }); return base.createMultipart(input); },
    async uploadPart(input) { options.calls?.push({ operation: "uploadPart", namespaceRoot: input.namespaceRoot, key: input.key, uploadId: input.uploadId }); return base.uploadPart(input); },
    async delete(input) { options.calls?.push({ operation: "delete", namespaceRoot: input.namespaceRoot, key: input.key }); if (options.cleanupFailure) throw new StorageServiceError("storage_provider_error"); return base.delete(input); },
    async abortMultipart(input) { options.calls?.push({ operation: "abort", namespaceRoot: input.namespaceRoot, key: input.key, uploadId: input.uploadId }); if (options.cleanupFailure) throw new StorageServiceError("storage_provider_error"); return base.abortMultipart(input); }
  };
}

const identityA = { version: 1 as const, publisherPublicKeyHex: `02${"11".repeat(32)}`, appId: "app-a", appName: "App A", identityDigestHex: "aa".repeat(32) };
const identityB = { ...identityA, appId: "app-b", identityDigestHex: "bb".repeat(32) };

function context(appIdentity = identityA): StorageAppContext {
  return { connectSessionId: "session-a", transportOrigin: "https://app.example", appIdentity };
}

async function createAbortService(mode: "success" | "reject" | "timeout" | "nostore" | "old-generation") {
  const db = makeDb();
  const calls = { listPrefixes: [] as string[], abortedUploads: [] as string[] };
  const base = makeStore(calls);
  const store: S3ObjectStore = mode === "timeout"
    ? { ...base, async abortMultipart() { await new Promise<void>(() => undefined); } }
    : mode === "reject"
      ? { ...base, async abortMultipart() { throw new StorageServiceError("storage_provider_error"); } }
      : base;
  const service = await createStorageService({
    db, secret: makeSecret(), vault: { status: () => "unlocked", onLifecycleChange: () => () => undefined },
    objectStoreFactory: () => store
  });
  await service.activateProvider({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket", prefix: "tenant/" }, credentials: { mode: "replace", accessKeyId: "key", secretAccessKey: "secret" } });
  await db.putMultipart({ internalUploadId: `internal-${mode}`, connectSessionId: "session-a", transportOrigin: "https://app.example", publisherPublicKeyHex: identityA.publisherPublicKeyHex, appId: identityA.appId, relativePath: "file.bin", physicalKey: "tenant/file.bin", sealedS3UploadId: { version: 1, saltHex: "", nonceHex: "", ciphertextHex: bytesToHex(new TextEncoder().encode("remote-upload")) }, providerGeneration: mode === "old-generation" ? 999 : 1, expectedSize: 0, overwrite: false, parts: [], expiresAt: Date.now() + 60_000, createdAt: Date.now() });
  if (mode === "nostore") service.dispose();
  return { service, db };
}

async function createCapabilityService(behavior: { put: CapabilityBehavior; complete: CapabilityBehavior }, options: { cleanupFailure?: boolean; calls?: CapabilityCall[]; gate?: Promise<void> } = {}) {
  const states: S3ObjectStoreCapabilityState[] = [];
  const service = await createStorageService({
    db: makeDb(), secret: makeSecret(), vault: { status: () => "unlocked", onLifecycleChange: () => () => undefined },
    objectStoreFactory: (_config, state) => { states.push(state!); return makeCapabilityStore(state!, behavior, options); }
  });
  await service.activateProvider({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket", prefix: "tenant/" }, credentials: { mode: "replace", accessKeyId: "key", secretAccessKey: "secret" } });
  return { service, states };
}

describe("StorageServiceImpl", () => {
  it("cancels a never-resolving probe so the mutation lane recovers immediately", async () => {
    let hanging = true; const base = makeStore({ listPrefixes: [] });
    const service = await createStorageService({ db: makeDb(), secret: makeSecret(), vault: { status: () => "unlocked", onLifecycleChange: () => () => undefined }, objectStoreFactory: () => ({ ...base, async probe() { if (hanging) await new Promise<void>(() => undefined); } }) });
    const draft = { providerId: "aws-s3" as const, connection: { region: "us-east-1", bucket: "bucket", prefix: "" }, credentials: { mode: "replace" as const, accessKeyId: "key", secretAccessKey: "secret" } };
    const pending = service.probeProvider(draft); await new Promise((resolve) => setTimeout(resolve, 10)); service.cancelProbe();
    await expect(pending).resolves.toMatchObject({ ok: false });
    hanging = false; await expect(service.probeProvider(draft)).resolves.toMatchObject({ ok: true }); service.dispose();
  });

  it("completes clear while a provider data request never settles", async () => {
    const base = makeStore({ listPrefixes: [] });
    const service = await createStorageService({ db: makeDb(), secret: makeSecret(), vault: { status: () => "unlocked", onLifecycleChange: () => () => undefined }, objectStoreFactory: () => ({ ...base, async list() { return await new Promise<never>(() => undefined); } }) });
    await service.activateProvider({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket", prefix: "" }, credentials: { mode: "replace", accessKeyId: "key", secretAccessKey: "secret" } });
    void service.list(context(), {}); await new Promise((resolve) => setTimeout(resolve, 10));
    const started = Date.now(); await service.clearProviderConfig();
    expect(Date.now() - started).toBeLessThan(800); service.dispose();
  });

  it("closes the clear gate before snapshot and cleans the in-flight multipart", async () => {
    const db = makeDb(); const calls = { listPrefixes: [] as string[], abortedUploads: [] as string[] }; const base = makeStore(calls); let release!: () => void;
    const store: S3ObjectStore = { ...base, async uploadPart() { await new Promise<void>((resolve) => { release = resolve; }); return "late-etag"; } };
    const service = await createStorageService({ db, secret: makeSecret(), vault: { status: () => "unlocked", onLifecycleChange: () => () => undefined }, objectStoreFactory: () => store });
    await service.activateProvider({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket", prefix: "" }, credentials: { mode: "replace", accessKeyId: "key", secretAccessKey: "secret" } });
    const upload = await service.beginUpload(context(), { path: "late.bin", size: 1 });
    const part = service.uploadPart(context(), { uploadId: upload.uploadId, partNumber: 1, content: { $type: "binary", bytes: new Uint8Array([7]).buffer } });
    await new Promise((resolve) => setTimeout(resolve, 10)); const clear = service.clearProviderConfig(); await new Promise((resolve) => setTimeout(resolve, 260)); release();
    await expect(part).rejects.toMatchObject({ code: "storage_unavailable" }); await clear;
    expect(calls.abortedUploads).toContain("s3-upload-1");
    expect(await db.getMultipart(upload.uploadId)).toBeNull(); service.dispose();
  });

  it("serializes concurrent parts so neither durable part update is lost", async () => {
    const db = makeDb();
    const service = await createStorageService({ db, secret: makeSecret(), vault: { status: () => "unlocked", onLifecycleChange: () => () => undefined }, objectStoreFactory: () => makeStore({ listPrefixes: [] }) });
    await service.activateProvider({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket", prefix: "" }, credentials: { mode: "replace", accessKeyId: "key", secretAccessKey: "secret" } });
    const begin = await service.beginUpload(context(), { path: "concurrent.bin", size: STORAGE_PART_SIZE_BYTES * 2 });
    const first = service.uploadPart(context(), { uploadId: begin.uploadId, partNumber: 1, content: { $type: "binary", bytes: new ArrayBuffer(STORAGE_PART_SIZE_BYTES) } });
    const second = service.uploadPart(context(), { uploadId: begin.uploadId, partNumber: 2, content: { $type: "binary", bytes: new ArrayBuffer(STORAGE_PART_SIZE_BYTES) } });
    await Promise.all([first, second]);
    const record = await db.getMultipart(begin.uploadId);
    expect(record?.parts.map((part) => part.partNumber)).toEqual([1, 2]);
    await expect(service.completeUpload(context(), { uploadId: begin.uploadId })).resolves.toMatchObject({ path: "concurrent.bin", size: STORAGE_PART_SIZE_BYTES * 2 });
    service.dispose();
  });

  it("bounds password-rotation drain when a provider never settles", async () => {
    const base = makeStore({ listPrefixes: [] });
    const service = await createStorageService({
      db: makeDb(), secret: makeSecret(), vault: { status: () => "unlocked", onLifecycleChange: () => () => undefined },
      objectStoreFactory: () => ({ ...base, async list() { return await new Promise<never>(() => undefined); } })
    });
    await service.activateProvider({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket", prefix: "" }, credentials: { mode: "replace", accessKeyId: "key", secretAccessKey: "secret" } });
    void service.list(context(), {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    const started = Date.now();
    await service.beginPasswordRotation();
    expect(Date.now() - started).toBeLessThan(800);
    service.dispose();
  });

  it("deletes durable multipart only after remote abort succeeds", async () => {
    const { service, db } = await createAbortService("success");
    await service.abortSession("session-a");
    expect(await db.getMultipart("internal-success")).toBeNull();
  });

  it.each(["reject", "timeout", "nostore", "old-generation"] as const)("retains durable multipart when cleanup is %s", async (mode) => {
    const { service, db } = await createAbortService(mode);
    await service.abortSession("session-a");
    expect(await db.getMultipart(`internal-${mode}`)).not.toBeNull();
  }, 3000);

  it("bounds session cleanup globally across many hanging uploads", async () => {
    const { service, db } = await createAbortService("timeout");
    const seed = await db.getMultipart("internal-timeout");
    for (let i = 0; i < 7; i++) await db.putMultipart({ ...seed!, internalUploadId: `internal-timeout-${i}` });
    const started = Date.now(); await service.abortSession("session-a");
    expect(Date.now() - started).toBeLessThan(1500);
    expect((await db.listMultiparts()).length).toBe(8);
  }, 2500);

  it("manually detects native PUT and Complete independently", async () => {
    const { service } = await createCapabilityService({ put: "native", complete: "native" });
    const result = await service.probeConditionalCapabilities();
    expect(result).toMatchObject({ put: "native", complete: "native", cleanupWarning: false });
    expect(service.getConditionalCapabilities()).toMatchObject({ put: { mode: "native", source: "manual" }, complete: { mode: "native", source: "manual" } });
    service.dispose();
  });

  it("manually detects precise unsupported and silent-ignore as best-effort", async () => {
    const { service } = await createCapabilityService({ put: "best-effort", complete: "silent" });
    const result = await service.probeConditionalCapabilities();
    expect(result).toMatchObject({ put: "best-effort", complete: "best-effort" });
    expect(service.getConditionalCapabilities()).toMatchObject({ put: { mode: "best-effort" }, complete: { mode: "best-effort" } });
    service.dispose();
  });

  it("keeps the prior mode for an inconclusive Complete result", async () => {
    const behavior: { put: CapabilityBehavior; complete: CapabilityBehavior } = { put: "native", complete: "native" };
    const { service } = await createCapabilityService(behavior);
    await service.probeConditionalCapabilities();
    behavior.complete = "second-error";
    const result = await service.probeConditionalCapabilities();
    expect(result.complete).toBe("inconclusive");
    expect(service.getConditionalCapabilities()?.complete).toMatchObject({ mode: "native", source: "manual" });
    service.dispose();
  });

  it("commits one capability while retaining the other on inconclusive", async () => {
    const { service } = await createCapabilityService({ put: "inconclusive", complete: "native" });
    const result = await service.probeConditionalCapabilities();
    expect(result).toMatchObject({ put: "inconclusive", complete: "native" });
    expect(service.getConditionalCapabilities()).toMatchObject({ put: { mode: "unknown" }, complete: { mode: "native", source: "manual" } });
    service.dispose();
  });

  it("reports cleanup warnings without discarding capability conclusions", async () => {
    const { service } = await createCapabilityService({ put: "native", complete: "native" }, { cleanupFailure: true });
    const result = await service.probeConditionalCapabilities();
    expect(result).toMatchObject({ put: "native", complete: "native", cleanupWarning: true });
    expect(service.getConditionalCapabilities()?.put.mode).toBe("native");
    service.dispose();
  });

  it("keeps every manual capability request inside its reserved namespace", async () => {
    const calls: CapabilityCall[] = [];
    const { service } = await createCapabilityService({ put: "native", complete: "native" }, { calls });
    await service.probeConditionalCapabilities();
    const roots = new Set(calls.map((call) => call.namespaceRoot));
    expect(roots.size).toBe(1);
    const [root] = [...roots];
    expect(root).toMatch(/^tenant\/\.keymaster-system\/capability-probe\/[0-9a-f-]+\/$/u);
    for (const call of calls) {
      expect(call.namespaceRoot).toBe(root);
      expect(call.key.startsWith(root!)).toBe(true);
    }
    expect(calls.some((call) => call.operation === "delete" && call.key.endsWith("put.bin"))).toBe(true);
    expect(calls.some((call) => call.operation === "delete" && call.key.endsWith("complete.bin"))).toBe(true);
    service.dispose();
  });

  it("aborts an unfinished conflicting Complete and deletes both probe objects", async () => {
    const calls: CapabilityCall[] = [];
    const { service } = await createCapabilityService({ put: "native", complete: "native" }, { calls });
    await service.probeConditionalCapabilities();
    const completeCalls = calls.filter((call) => call.operation === "complete");
    expect(completeCalls).toHaveLength(2);
    expect(calls.some((call) => call.operation === "abort" && call.uploadId === completeCalls[1]?.uploadId)).toBe(true);
    expect(calls.filter((call) => call.operation === "delete")).toHaveLength(2);
    service.dispose();
  });

  it("cancels a manual probe without committing conclusions", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { service } = await createCapabilityService({ put: "native", complete: "native" }, { gate });
    const pending = service.probeConditionalCapabilities();
    await Promise.resolve();
    service.cancelProbe();
    release();
    await expect(pending).rejects.toMatchObject({ code: "storage_unavailable" });
    expect(service.getConditionalCapabilities()).toMatchObject({ put: { mode: "unknown" }, complete: { mode: "unknown" } });
    service.dispose();
  });

  it("rejects an old manual probe when activation replaces its generation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const states: S3ObjectStoreCapabilityState[] = [];
    const service = await createStorageService({
      db: makeDb(), secret: makeSecret(), vault: { status: () => "unlocked", onLifecycleChange: () => () => undefined },
      objectStoreFactory: (_config, state) => { states.push(state!); return makeCapabilityStore(state!, { put: "native", complete: "native" }, { gate }); }
    });
    await service.activateProvider({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "before", prefix: "tenant/" }, credentials: { mode: "replace", accessKeyId: "key", secretAccessKey: "secret" } });
    const pending = service.probeConditionalCapabilities();
    await Promise.resolve();
    const replacement = service.activateProvider({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "after", prefix: "tenant/" }, credentials: { mode: "replace", accessKeyId: "key", secretAccessKey: "secret" } });
    await replacement;
    release();
    await expect(pending).rejects.toMatchObject({ code: "storage_unavailable" });
    expect(service.getConditionalCapabilities()).toMatchObject({ generation: 2, put: { mode: "unknown" }, complete: { mode: "unknown" } });
    service.dispose();
  });

  it("allows manual reclassification in both directions", async () => {
    const behavior: { put: CapabilityBehavior; complete: CapabilityBehavior } = { put: "native", complete: "native" };
    const { service } = await createCapabilityService(behavior);
    await service.probeConditionalCapabilities();
    behavior.put = "best-effort"; behavior.complete = "best-effort";
    await service.probeConditionalCapabilities();
    expect(service.getConditionalCapabilities()).toMatchObject({ put: { mode: "best-effort", source: "manual" }, complete: { mode: "best-effort", source: "manual" } });
    behavior.put = "native"; behavior.complete = "native";
    await service.probeConditionalCapabilities();
    expect(service.getConditionalCapabilities()).toMatchObject({ put: { mode: "native", source: "manual" }, complete: { mode: "native", source: "manual" } });
    service.dispose();
  });

  it("pins list prefixes to the app namespace and rejects a foreign cursor", async () => {
    const calls = { listPrefixes: [] as string[] };
    const service = await createStorageService({
      db: makeDb(), secret: makeSecret(), vault: { status: () => "unlocked", onLifecycleChange: () => () => undefined },
      objectStoreFactory: () => makeStore(calls), now: () => 1000, generateId: () => "fixed"
    });
    await service.activateProvider({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket-name", prefix: "tenant/" }, credentials: { mode: "replace", accessKeyId: "key", secretAccessKey: "secret" } });
    await expect(service.getProviderConnection()).resolves.toEqual({
      providerId: "aws-s3",
      connection: { region: "us-east-1", bucket: "bucket-name", prefix: "tenant/" }
    });
    const first = await service.list(context(), {});
    expect(calls.listPrefixes[0]).toBe(`tenant/${identityA.publisherPublicKeyHex}/app-a/`);
    expect(first.nextCursor).toBe("cursor-fixed");
    await expect(service.list(context(identityB), { cursor: first.nextCursor })).rejects.toMatchObject({ code: "storage_invalid_upload" });
    const nested = await service.list(context(), { prefix: "nested/child" });
    expect(nested.prefix).toBe("nested/child/");
    expect(nested.parentPrefix).toBe("nested/");
    service.dispose();
  });

  it("bounds unconsumed continuation cursors", async () => {
    const service = await createStorageService({
      db: makeDb(), secret: makeSecret(), vault: { status: () => "unlocked", onLifecycleChange: () => () => undefined },
      objectStoreFactory: () => makeStore({ listPrefixes: [] }), generateId: (() => { let n = 0; return () => String(++n); })()
    });
    await service.activateProvider({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket", prefix: "" }, credentials: { mode: "replace", accessKeyId: "key", secretAccessKey: "secret" } });
    const first = await service.list(context(), { limit: 1 });
    for (let i = 0; i < 600; i++) await service.list(context(), { limit: 1 });
    const cursors = (service as unknown as { cursors: Map<string, { connectSessionId: string }> }).cursors;
    expect(cursors.size).toBeLessThanOrEqual(512);
    expect([...cursors.values()].filter((cursor) => cursor.connectSessionId === "session-a").length).toBeLessThanOrEqual(64);
    await expect(service.list(context(), { limit: 1, cursor: first.nextCursor })).rejects.toMatchObject({ code: "storage_invalid_upload" });
    service.dispose();
  });

  it("shares capability state across lock/unlock and replaces it on provider generation changes", async () => {
    let vaultStatus: "unlocked" | "locked" = "unlocked";
    let lifecycle: ((snapshot: { status: "unlocked" | "locked" }) => void) | undefined;
    const states: S3ObjectStoreCapabilityState[] = [];
    const service = await createStorageService({
      db: makeDb(), secret: makeSecret(), vault: {
        status: () => vaultStatus,
        onLifecycleChange: (listener) => { lifecycle = listener as typeof lifecycle; return () => { lifecycle = undefined; }; }
      },
      objectStoreFactory: (_config, state) => { if (!state) throw new Error("missing capability state"); states.push(state); return makeStore({ listPrefixes: [] }); }
    });
    await service.activateProvider({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "generation-a", prefix: "tenant/" }, credentials: { mode: "replace", accessKeyId: "key", secretAccessKey: "secret" } });
    expect(states).toHaveLength(1);
    const firstGenerationState = states[0];
    let updates = 0;
    const unsubscribe = service.subscribe(() => { updates += 1; });
    setS3ObjectStoreCapabilityMode(firstGenerationState!, "put", "native", "automatic");
    expect(service.getConditionalCapabilities()?.put).toMatchObject({ mode: "native", source: "automatic" });
    expect(updates).toBeGreaterThan(0);
    unsubscribe();

    vaultStatus = "locked";
    lifecycle?.({ status: "locked" });
    expect(service.status()).toBe("locked");
    vaultStatus = "unlocked";
    lifecycle?.({ status: "unlocked" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(states).toHaveLength(2);
    expect(states[1]).toBe(firstGenerationState);

    await service.activateProvider({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "generation-b", prefix: "tenant/" }, credentials: { mode: "replace", accessKeyId: "key", secretAccessKey: "secret" } });
    expect(states).toHaveLength(3);
    expect(states[2]).not.toBe(firstGenerationState);
    service.dispose();
  });

  it("discards a capability result when Vault locks during detection", async () => {
    let vaultStatus: "unlocked" | "locked" = "unlocked";
    let lifecycle: ((snapshot: { status: "unlocked" | "locked" }) => void) | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let capabilityRequest = false;
    const states: S3ObjectStoreCapabilityState[] = [];
    const service = await createStorageService({
      db: makeDb(), secret: makeSecret(), vault: {
        status: () => vaultStatus,
        onLifecycleChange: (listener) => { lifecycle = listener as typeof lifecycle; return () => { lifecycle = undefined; }; }
      },
      objectStoreFactory: (_config, state) => {
        states.push(state!);
        const base = makeStore({ listPrefixes: [] });
        return { ...base, async put(input) { if (input.ifNoneMatch && !capabilityRequest) { capabilityRequest = true; await gate; } return base.put(input); } };
      }
    });
    await service.activateProvider({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket", prefix: "tenant/" }, credentials: { mode: "replace", accessKeyId: "key", secretAccessKey: "secret" } });
    const probe = service.probeConditionalCapabilities();
    await Promise.resolve();
    vaultStatus = "locked";
    lifecycle?.({ status: "locked" });
    release();
    await expect(probe).rejects.toMatchObject({ code: "storage_unavailable" });
    expect(service.getConditionalCapabilities()?.put.mode).toBe("unknown");
    service.dispose();
  });

  it("keeps the internal multipart id separate from the provider upload id", async () => {
    const service = await createStorageService({
      db: makeDb(), secret: makeSecret(), vault: { status: () => "unlocked", onLifecycleChange: () => () => undefined },
      objectStoreFactory: () => makeStore({ listPrefixes: [] }), generateId: () => "internal", now: () => 1000
    });
    await service.activateProvider({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket-name", prefix: "" }, credentials: { mode: "replace", accessKeyId: "key", secretAccessKey: "secret" } });
    const begin = await service.beginUpload(context(), { path: "file.bin", size: 3 });
    expect(begin.uploadId).toBe("upload-internal");
    expect(begin.uploadId).not.toContain("s3-upload");
    await service.uploadPart(context(), { uploadId: begin.uploadId, partNumber: 1, content: { $type: "binary", bytes: new Uint8Array([1, 2, 3]).buffer } });
    const result = await service.completeUpload(context(), { uploadId: begin.uploadId });
    expect(result.path).toBe("file.bin");
    await expect(service.completeUpload(context(), { uploadId: begin.uploadId })).rejects.toMatchObject({ code: "storage_invalid_upload" });
    service.dispose();
  });

  it("rejects unsafe range arithmetic and provider range metadata", async () => {
    const base = makeStore({ listPrefixes: [] });
    let response: { bytes: Uint8Array; offset?: number; totalSize?: number } = { bytes: new Uint8Array([1]), offset: 0, totalSize: 1 };
    const service = await createStorageService({ db: makeDb(), secret: makeSecret(), vault: { status: () => "unlocked", onLifecycleChange: () => () => undefined }, objectStoreFactory: () => ({ ...base, async get() { return response; } }) });
    await service.activateProvider({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket", prefix: "" }, credentials: { mode: "replace", accessKeyId: "key", secretAccessKey: "secret" } });
    await expect(service.getRange(context(), { path: "file", offset: Number.MAX_SAFE_INTEGER, length: 2 })).rejects.toMatchObject({ code: "storage_limit_exceeded" });
    response = { bytes: new Uint8Array([1]), offset: Number.MAX_SAFE_INTEGER + 1, totalSize: 1 };
    await expect(service.getRange(context(), { path: "file" })).rejects.toMatchObject({ code: "storage_provider_error" });
    response = { bytes: new Uint8Array([1]), offset: 0, totalSize: Number.MAX_SAFE_INTEGER + 1 };
    await expect(service.getRange(context(), { path: "file" })).rejects.toMatchObject({ code: "storage_provider_error" });
    response = { bytes: new Uint8Array([1]), offset: Number.MAX_SAFE_INTEGER, totalSize: Number.MAX_SAFE_INTEGER };
    await expect(service.getRange(context(), { path: "file", offset: Number.MAX_SAFE_INTEGER, length: 1 })).rejects.toMatchObject({ code: "storage_provider_error" });
    service.dispose();
  });

  it("maps oversized path segments to storage_invalid_path", async () => {
    const service = await createStorageService({ db: makeDb(), secret: makeSecret(), vault: { status: () => "unlocked", onLifecycleChange: () => () => undefined }, objectStoreFactory: () => makeStore({ listPrefixes: [] }) });
    await service.activateProvider({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket", prefix: "" }, credentials: { mode: "replace", accessKeyId: "key", secretAccessKey: "secret" } });
    await expect(service.put(context(), { path: "x".repeat(256), content: { $type: "binary", bytes: new ArrayBuffer(0) } })).rejects.toMatchObject({ code: "storage_invalid_path" });
    service.dispose();
  });

  it("enforces overwrite:false for multipart targets", async () => {
    const service = await createStorageService({
      db: makeDb(), secret: makeSecret(), vault: { status: () => "unlocked", onLifecycleChange: () => () => undefined },
      objectStoreFactory: () => makeStore({ listPrefixes: [] }), generateId: () => "overwrite", now: () => 1000
    });
    await service.activateProvider({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket-name", prefix: "" }, credentials: { mode: "replace", accessKeyId: "key", secretAccessKey: "secret" } });
    await service.put(context(), { path: "existing.bin", content: { $type: "binary", bytes: new Uint8Array([1]).buffer } });
    await expect(service.beginUpload(context(), { path: "existing.bin", size: 1, overwrite: false })).rejects.toMatchObject({ code: "storage_conflict" });
    service.dispose();
  });

  it("best-effort aborts uploads and atomically retires local state on Clear", async () => {
    const calls = { listPrefixes: [] as string[], abortedUploads: [] as string[] };
    const db = makeDb();
    const service = await createStorageService({
      db, secret: makeSecret(), vault: { status: () => "unlocked", onLifecycleChange: () => () => undefined },
      objectStoreFactory: () => makeStore(calls), generateId: () => "clear", now: () => 1000
    });
    await service.activateProvider({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket-name", prefix: "" }, credentials: { mode: "replace", accessKeyId: "key", secretAccessKey: "secret" } });
    await service.beginUpload(context(), { path: "pending.bin", size: 1 });

    await service.clearProviderConfig();

    expect(calls.abortedUploads).toEqual(["s3-upload-1"]);
    await expect(db.getProviderConfig()).resolves.toBeNull();
    await expect(db.listMultiparts()).resolves.toEqual([]);
    expect(service.status()).toBe("unconfigured");
    await expect(service.put(context(), { path: "new.bin", content: { $type: "binary", bytes: new Uint8Array([1]).buffer } })).rejects.toMatchObject({ code: "storage_not_configured" });
    service.dispose();
  });

  it("keeps the old client usable and local upload records intact when Clear commit fails", async () => {
    const calls = { listPrefixes: [] as string[], abortedUploads: [] as string[] };
    const db = makeDb();
    const service = await createStorageService({
      db, secret: makeSecret(), vault: { status: () => "unlocked", onLifecycleChange: () => () => undefined },
      objectStoreFactory: () => makeStore(calls), generateId: () => "clear-failure", now: () => 1000
    });
    await service.activateProvider({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket-name", prefix: "" }, credentials: { mode: "replace", accessKeyId: "key", secretAccessKey: "secret" } });
    await service.beginUpload(context(), { path: "pending.bin", size: 1 });
    db.clearProviderConfig = async () => { throw new Error("fixture clear failure"); };

    await expect(service.clearProviderConfig()).rejects.toThrow("fixture clear failure");

    // Reset follows the same local-commit-first rule on transaction failure.
    expect(calls.abortedUploads).toEqual([]);
    await expect(db.getProviderConfig()).resolves.not.toBeNull();
    await expect(db.listMultiparts()).resolves.toHaveLength(1);
    expect(service.status()).toBe("ready");
    await expect(service.put(context(), { path: "still-usable.bin", content: { $type: "binary", bytes: new Uint8Array([1]).buffer } })).resolves.toMatchObject({ path: "still-usable.bin" });
    service.dispose();
  });

  it("best-effort aborts uploads during destructive reset", async () => {
    const calls = { listPrefixes: [] as string[], abortedUploads: [] as string[] };
    const db = makeDb();
    const service = await createStorageService({
      db, secret: makeSecret(), vault: { status: () => "unlocked", onLifecycleChange: () => () => undefined },
      objectStoreFactory: () => makeStore(calls), generateId: () => "reset", now: () => 1000
    });
    await service.activateProvider({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket-name", prefix: "" }, credentials: { mode: "replace", accessKeyId: "key", secretAccessKey: "secret" } });
    await service.beginUpload(context(), { path: "pending.bin", size: 1 });

    await service.resetStorage();

    // Reset follows the same local-commit-first rule on transaction failure.
    expect(calls.abortedUploads).toEqual(["s3-upload-1"]);
    await expect(db.listMultiparts()).resolves.toEqual([]);
    expect(service.status()).toBe("unconfigured");
    service.dispose();
  });

  it("re-arms request cancellation and preserves the old client when reset fails", async () => {
    const calls = { listPrefixes: [] as string[], abortedUploads: [] as string[] };
    const db = makeDb();
    const service = await createStorageService({
      db, secret: makeSecret(), vault: { status: () => "unlocked", onLifecycleChange: () => () => undefined },
      objectStoreFactory: () => makeStore(calls), generateId: () => "reset-failure", now: () => 1000
    });
    await service.activateProvider({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket-name", prefix: "" }, credentials: { mode: "replace", accessKeyId: "key", secretAccessKey: "secret" } });
    await service.beginUpload(context(), { path: "pending.bin", size: 1 });
    db.resetStorage = async () => { throw new Error("fixture reset failure"); };

    await expect(service.resetStorage()).rejects.toThrow("fixture reset failure");

    expect(calls.abortedUploads).toEqual([]);
    await expect(db.getProviderConfig()).resolves.not.toBeNull();
    await expect(db.listMultiparts()).resolves.toHaveLength(1);
    expect(service.status()).toBe("ready");
    await expect(service.put(context(), { path: "still-usable.bin", content: { $type: "binary", bytes: new Uint8Array([1]).buffer } })).resolves.toMatchObject({ path: "still-usable.bin" });
    service.dispose();
  });

  it("rejects a provider response that exceeds the requested range", async () => {
    const store = makeStore({ listPrefixes: [] });
    store.get = async () => ({ bytes: new Uint8Array(STORAGE_MAX_PAYLOAD_BYTES + 1), offset: 0, totalSize: STORAGE_MAX_PAYLOAD_BYTES + 1 });
    const service = await createStorageService({
      db: makeDb(), secret: makeSecret(), vault: { status: () => "unlocked", onLifecycleChange: () => () => undefined },
      objectStoreFactory: () => store, generateId: () => "range", now: () => 1000
    });
    await service.activateProvider({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket-name", prefix: "" }, credentials: { mode: "replace", accessKeyId: "key", secretAccessKey: "secret" } });
    await expect(service.getRange(context(), { path: "large.bin", offset: 0, length: STORAGE_MAX_PAYLOAD_BYTES })).rejects.toMatchObject({ code: "storage_limit_exceeded" });
    service.dispose();
  });

  it("cancels in-flight provider work immediately when Vault locks", async () => {
    const calls = { listPrefixes: [] as string[] };
    const store = makeStore(calls);
    let started!: () => void;
    let abortObserved!: () => void;
    let releaseCancelled!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const abortPromise = new Promise<void>((resolve) => { abortObserved = resolve; });
    store.put = async ({ signal }) => {
      started();
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => {
          abortObserved();
          releaseCancelled = resolve;
        }, { once: true });
      });
      throw new StorageServiceError("storage_unavailable", "Storage operation was cancelled");
    };
    let lifecycle!: (snapshot: { status: "locked" }) => void;
    const service = await createStorageService({
      db: makeDb(), secret: makeSecret(), vault: { status: () => "unlocked", onLifecycleChange: (listener: any) => { lifecycle = listener; return () => undefined; } },
      objectStoreFactory: () => store, generateId: () => "rotation", now: () => 1000
    });
    await service.activateProvider({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket-name", prefix: "" }, credentials: { mode: "replace", accessKeyId: "key", secretAccessKey: "secret" } });
    const request = service.put(context(), { path: "file.bin", content: { $type: "binary", bytes: new Uint8Array([1]).buffer } });
    const requestResult = expect(request).rejects.toMatchObject({ code: "storage_unavailable" });
    await startedPromise;
    lifecycle({ status: "locked" });
    await abortPromise;
    releaseCancelled();
    await requestResult;
    expect(service.status()).toBe("locked");
    service.dispose();
  });

  it("exposes an S3Disk-shaped facade without provider credentials", async () => {
    const calls = { listPrefixes: [] as string[], abortedUploads: [] as string[] };
    const service = await createStorageService({
      db: makeDb(), secret: makeSecret(), vault: { status: () => "unlocked", onLifecycleChange: () => () => undefined },
      objectStoreFactory: () => makeStore(calls), generateId: () => "fixture", now: () => 1000
    });
    await service.activateProvider({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket-name", prefix: "" }, credentials: { mode: "replace", accessKeyId: "key", secretAccessKey: "secret" } });
    const facade = createConnectObjectStoreFixture({ service, context: context() });
    await facade.createDirectory("", "docs");
    await expect(facade.deleteDirectoryMarker("docs/")).resolves.toBeUndefined();
    const file = new File(["hello connect"], "hello.txt", { type: "text/plain" });
    await facade.putObject("docs", file, { overwrite: false });
    const listing = await facade.listDirectory("docs");
    expect(listing.files.map((entry) => entry.key)).toContain("docs/hello.txt");
    expect(await facade.getObjectBlob("docs/hello.txt").then((value) => value.text())).toBe("hello connect");
    await facade.deleteObject("docs/hello.txt");

    const abortController = new AbortController();
    const large = new File([new Uint8Array(STORAGE_PART_SIZE_BYTES + 1)], "large.bin");
    await expect(facade.putObject("", large, {
      abortSignal: abortController.signal,
      onProgress: ({ loaded }) => { if (loaded > 0) abortController.abort(new Error("fixture cancellation")); }
    })).rejects.toThrow("fixture cancellation");
    expect(calls.abortedUploads).toHaveLength(1);
    facade.dispose();
    service.dispose();
  });
});
