import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { normalizeRelativeStoragePath, networkIdentityStorageRoot, traceDev, type NetworkIdentity, type ModuleFileStore, type ModuleFileObject, type OwnerAppStorageGrant } from "@keymaster/contracts";
import { StorageRuntimeError } from "../runtime/storageError.js";
import type { ConnectS3Config, ConnectS3Failure } from "./protocol.js";

export type ConnectFileStore = Pick<ModuleFileStore, "list" | "put" | "delete" | "close"> & {
  readonly bindingId?: object;
  get(...args: Parameters<ModuleFileStore["get"]>): Promise<(ModuleFileObject & { contentType?: string }) | undefined>;
};
/** 每个 App 使用独立公钥；proof 的该公钥当前沿用 publisherPublicKeyHex 字段名。 */
export function connectS3Root(ctx: OwnerAppStorageGrant): string {
  return `${networkIdentityStorageRoot(ctx)}${ctx.appIdentity.publisherPublicKeyHex}/files/`;
}
export function createConnectS3FileStore(config: ConnectS3Config, ctx: OwnerAppStorageGrant, live: () => boolean, lifetime: AbortSignal): ConnectFileStore {
  const root = connectS3Root(ctx);
  const credentials = { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}) };
  const client = new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: config.forcePathStyle, credentials,
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED", maxAttempts: 1 });
  let closed = false;
  const assert = () => { if (closed || lifetime.aborted || !live()) throw new StorageRuntimeError("storage_unavailable", "S3 storage binding is no longer available"); };
  const path = (value: string) => {
    try { if (normalizeRelativeStoragePath(value) !== value) throw Error(); }
    catch { throw new StorageRuntimeError("storage_invalid_path", "Invalid App file path"); }
    return root + value;
  };
  const relative = (value: string) => {
    if (!value.startsWith(root)) throw new StorageRuntimeError("storage_provider_error", "S3 returned an object outside the App directory");
    const result = value.slice(root.length); path(result); return result;
  };
  const revision = (value?: string) => { if (!value) throw new StorageRuntimeError("storage_provider_error", "S3 ETag is not available; check CORS exposed headers"); return value; };
  async function run<T>(operation: string, signal: AbortSignal | undefined, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    assert();
    const cancel = new AbortController();
    const abort = () => cancel.abort();
    lifetime.addEventListener("abort", abort, { once: true }); signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted || lifetime.aborted) cancel.abort();
    const started = Date.now();
    try {
      if (cancel.signal.aborted) throw new StorageRuntimeError("storage_unavailable", "S3 request cancelled");
      const value = await task(cancel.signal); assert();
      if (cancel.signal.aborted) throw new StorageRuntimeError("storage_unavailable", "S3 request cancelled");
      traceDev("storage.connect-s3", "request.completed", () => ({ operation, elapsedMs: Date.now() - started }));
      return value;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      traceDev("storage.connect-s3", "request.failed", () => ({ operation, status, cancelled: cancel.signal.aborted, elapsedMs: Date.now() - started }));
      if (error instanceof StorageRuntimeError) throw error;
      if (cancel.signal.aborted || !live()) throw new StorageRuntimeError("storage_unavailable", "S3 request cancelled");
      throw new StorageRuntimeError(status === 409 || status === 412 ? "storage_conflict" : status === 403 ? "storage_forbidden" : "storage_provider_error", "S3 operation failed");
    } finally { lifetime.removeEventListener("abort", abort); signal?.removeEventListener("abort", abort); }
  }
  const close = () => { if (closed) return; closed = true; client.destroy(); credentials.accessKeyId = ""; credentials.secretAccessKey = ""; credentials.sessionToken = ""; lifetime.removeEventListener("abort", close); };
  lifetime.addEventListener("abort", close, { once: true });
  return {
    async list(input = {}) {
      const prefix = input.prefix ? path(input.prefix.replace(/\/$/u, "")) + "/" : root;
      return run("list", input.signal, async signal => {
        const result = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix, MaxKeys: input.limit ?? 200, ContinuationToken: input.cursor }), { abortSignal: signal });
        if (result.IsTruncated && !result.NextContinuationToken) throw new StorageRuntimeError("storage_provider_error", "S3 pagination token is missing");
        return { files: (result.Contents ?? []).map(object => {
          if (!object.Key || object.Size === undefined || !object.LastModified) throw new StorageRuntimeError("storage_provider_error", "S3 object metadata is incomplete");
          if (!object.Key.startsWith(prefix)) throw new StorageRuntimeError("storage_provider_error", "S3 list prefix mismatch");
          return { path: relative(object.Key), size: object.Size, revision: revision(object.ETag), lastModified: object.LastModified.toISOString() };
        }), ...(result.IsTruncated ? { nextCursor: result.NextContinuationToken! } : {}) };
      });
    },
    async get(value, options) {
      const key = path(value);
      return run("get", options?.signal, async signal => {
        try {
          const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key, IfMatch: options?.ifRevision }), { abortSignal: signal });
          if (!result.Body || !result.LastModified) throw new StorageRuntimeError("storage_provider_error", "S3 object metadata is incomplete");
          return { path: value, bytes: await result.Body.transformToByteArray(), ...(result.ContentType ? { contentType: result.ContentType } : {}), revision: revision(result.ETag), lastModified: result.LastModified.toISOString() };
        } catch (error) {
          // 只有明确 NoSuchKey 才表示不存在；桶缺失和权限失败不能伪装成空文件。
          if ((error as { name?: string })?.name === "NoSuchKey") return undefined;
          throw error;
        }
      });
    },
    async put(value, bytes, options) {
      const key = path(value);
      return run("put", options?.signal, async signal => {
        const result = await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: bytes, ContentType: options?.contentType,
          IfNoneMatch: options?.ifNoneMatch ? "*" : undefined, IfMatch: options?.ifRevision }), { abortSignal: signal });
        return { revision: revision(result.ETag), lastModified: new Date().toISOString() };
      });
    },
    async delete(value, options) {
      const key = path(value);
      await run("delete", options?.signal, async signal => { await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key, IfMatch: options?.ifRevision }), { abortSignal: signal }); });
    },
    close,
  };
}

/** 不跨公开 RPC 传播原始服务错误，保留可操作的阶段与清理结果。 */
export class ConnectS3ProbeError extends Error {
  constructor(readonly failure: ConnectS3Failure) { super("S3 connection check failed"); }
}

/** 使用候选配置执行真实远端检查；不读取或修改钱包保存的配置。 */
export async function probeConnectS3(config: ConnectS3Config, options: {
  identity: NetworkIdentity;
  lifetime: AbortSignal;
  signal?: AbortSignal;
  assertLive(): void;
}): Promise<void> {
  const credentials = { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}) };
  const client = new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: config.forcePathStyle, credentials,
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED", maxAttempts: 1 });
  const probeId = crypto.randomUUID();
  const walletRoot = networkIdentityStorageRoot(options.identity);
  const objectKey = `${walletRoot}.connection-check/${probeId}.bin`;
  const expected = crypto.getRandomValues(new Uint8Array(32));
  const signal = AbortSignal.any([options.lifetime, AbortSignal.timeout(30_000), ...(options.signal ? [options.signal] : [])]);
  let stage: ConnectS3Failure["stage"] = "list";
  let writeAttempted = false;
  let collision = false;
  let failure: ConnectS3Failure | undefined;
  const assert = () => { options.assertLive(); signal.throwIfAborted(); };
  const statusOf = (error: unknown) => {
    const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    return typeof status === "number" && status >= 100 && status <= 599 ? status : undefined;
  };
  const started = Date.now();
  try {
    assert();
    await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: walletRoot, MaxKeys: 1 }), { abortSignal: signal });
    stage = "write"; assert();
    writeAttempted = true;
    const written = await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: objectKey, Body: expected, ContentType: "application/octet-stream", IfNoneMatch: "*" }), { abortSignal: signal });
    if (!written.ETag) throw new Error("S3 ETag is unavailable");
    stage = "read"; assert();
    const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: objectKey, IfMatch: written.ETag }), { abortSignal: signal });
    stage = "verify";
    if (!result.Body || result.ContentLength !== expected.length || result.ETag !== written.ETag) throw new Error("S3 test object metadata mismatch");
    const actual = await result.Body.transformToByteArray();
    assert();
    if (actual.length !== expected.length || actual.some((byte, index) => byte !== expected[index])) throw new Error("S3 test object content mismatch");
  } catch (error) {
    const httpStatus = statusOf(error);
    // 条件创建明确冲突时，目标不是本次测试创建的对象，绝不能删除。
    collision = stage === "write" && (httpStatus === 409 || httpStatus === 412);
    failure = { stage: signal.aborted ? "cancelled" : stage, cleanupFailed: false, ...(httpStatus === undefined ? {} : { httpStatus }) };
  } finally {
    if (writeAttempted && !collision) {
      try {
        // 普通取消后仍尽力清理；钱包锁定/换代后不再发起新的远端操作。
        options.assertLive(); options.lifetime.throwIfAborted();
        const cleanupSignal = AbortSignal.any([options.lifetime, AbortSignal.timeout(10_000)]);
        await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: objectKey }), { abortSignal: cleanupSignal });
        options.assertLive(); cleanupSignal.throwIfAborted();
        try {
          await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: objectKey }), { abortSignal: cleanupSignal });
          throw new Error("S3 test object still exists after deletion");
        } catch (error) {
          if ((error as { name?: string })?.name !== "NoSuchKey") throw error;
        }
      } catch (error) {
        failure = { ...(failure ?? { stage: "delete" as const }), cleanupFailed: true, objectKey,
          ...(statusOf(error) === undefined ? {} : { httpStatus: statusOf(error) }) };
      }
    }
    client.destroy(); credentials.accessKeyId = ""; credentials.secretAccessKey = ""; credentials.sessionToken = ""; expected.fill(0);
  }
  if (failure) {
    traceDev("storage.connect-s3", "probe.failed", () => ({ probeId, stage: failure.stage, httpStatus: failure.httpStatus, cleanupFailed: failure.cleanupFailed, elapsedMs: Date.now() - started }));
    throw new ConnectS3ProbeError(failure);
  }
  options.assertLive(); signal.throwIfAborted();
  traceDev("storage.connect-s3", "probe.completed", () => ({ probeId, elapsedMs: Date.now() - started }));
}
