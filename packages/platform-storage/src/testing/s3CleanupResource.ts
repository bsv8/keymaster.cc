import { createS3CleanupApi, type S3CleanupApi } from "./s3CleanupAdapter.js";

const CONTROL_PREFIX = ".keymaster-e2e/";
const LEASE_KEY = `${CONTROL_PREFIX}lease.json`;

/** 只允许进入对象路径和运行报告的稳定标识符。 */
function assertSafeIdentifier(value: string, field = "identifier"): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function validatePrefix(runId: string, prefix: string): string {
  if (
    !prefix
    || !prefix.startsWith(`${runId}/`)
    || !prefix.endsWith("/")
    || prefix.startsWith("/")
    || prefix.startsWith(CONTROL_PREFIX)
    || prefix.includes("..")
    || /[\u0000-\u001f\u007f]/u.test(prefix)
  ) throw new Error("E2E S3 cleanup prefix is invalid");
  return prefix;
}

/** 一些 S3-compatible 服务不实现版本/ multipart 列表。 */
function isOptionalS3OperationUnsupported(error: unknown): boolean {
  const value = error as { name?: unknown; message?: unknown; $metadata?: { httpStatusCode?: unknown } } | undefined;
  return value?.$metadata?.httpStatusCode === 501
    || value?.name === "NotImplemented"
    || (typeof value?.message === "string" && /not implemented|unsupported/iu.test(value.message));
}

/** 访问密钥只通过 read() 短暂取得，不能被清理器持久化。 */
export interface S3CleanupResourceConfig {
  /** S3-compatible 服务的 HTTPS 地址。 */
  readonly endpoint: string;
  /** S3 签名区域。 */
  readonly region: string;
  /** 本次测试直接使用的物理桶名称。 */
  readonly bucket: string;
  /** S3 访问身份。 */
  readonly accessKeyId: string;
  /** S3 Secret Access Key 的短生命周期读取接口。 */
  readonly secretAccessKey: { read(): string };
  /** 可选临时会话令牌的短生命周期读取接口。 */
  readonly sessionToken?: { read(): string };
}

/** 将 AWS SDK 封装成 Resource 所需的最小真实 S3 API。 */
export function createAwsS3Api(config: S3CleanupResourceConfig): S3CleanupApi {
  return createS3CleanupApi({
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey.read(),
    ...(config.sessionToken === undefined ? {} : { sessionToken: config.sessionToken.read() }),
  });
}

export interface S3Lease {
  readonly runId: string;
  readonly expiresAt: number;
  readonly etag?: string;
}

export interface S3CleanupSummary {
  readonly deletedObjects: number;
  readonly deletedVersions: number;
  readonly abortedMultipartUploads: number;
}

/**
 * 真实 S3 生命周期 Resource。
 *
 * 桶由配置直接指定。带 prefix 的测试只清理自己的 prefix；不带 prefix 的
 * 测试清理该桶中的全部业务对象。控制前缀中的 lease 对象在清理期间保留，
 * 防止清理操作把自己的并发锁删除。
 */
export class S3CleanupResource {
  readonly #api: S3CleanupApi;
  #lease: S3Lease | undefined;

  constructor(config: S3CleanupResourceConfig, api = createAwsS3Api(config)) {
    this.#api = api;
  }

  async acquireLease(runId: string, now = Date.now(), ttlMs = 30 * 60_000): Promise<S3Lease> {
    if (this.#lease) throw new Error("E2E S3 lease is already held by this resource");
    const safeRunId = assertSafeIdentifier(runId, "run_id");
    const existing = await this.#api.getObject(LEASE_KEY);
    if (existing) {
      let expiresAt = Number.NaN;
      try { expiresAt = Number((JSON.parse(existing.body) as { expiresAt?: unknown }).expiresAt); } catch { /* malformed lease remains active */ }
      if (!Number.isFinite(expiresAt) || expiresAt > now) throw new Error("E2E S3 bucket lease is held by another run");
      // 过期 lease 也不能无条件删除；使用 ETag 条件删除，避免抢走新运行的 lease。
      if (!existing.etag) throw new Error("E2E S3 expired lease has no ETag and cannot be recovered safely");
      await this.#api.deleteObject(LEASE_KEY, { ifMatch: existing.etag });
    }
    const lease = { version: 1, runId: safeRunId, acquiredAt: now, expiresAt: now + ttlMs };
    const created = await this.#api.putObject(LEASE_KEY, JSON.stringify(lease), { ifNoneMatch: "*" });
    this.#lease = { runId: safeRunId, expiresAt: lease.expiresAt, ...(created.etag === undefined ? {} : { etag: created.etag }) };
    return this.#lease;
  }

  /** teardown 在另一个 Playwright project 中运行，只能认领本轮已有 lease。 */
  async adoptLease(runId: string, now = Date.now()): Promise<void> {
    const safeRunId = assertSafeIdentifier(runId, "run_id");
    const object = await this.#api.getObject(LEASE_KEY);
    if (!object) throw new Error("E2E S3 lease is missing during teardown");
    let value: { runId?: unknown; expiresAt?: unknown };
    try { value = JSON.parse(object.body) as { runId?: unknown; expiresAt?: unknown }; }
    catch { throw new Error("E2E S3 lease is invalid JSON"); }
    if (value.runId !== safeRunId || typeof value.expiresAt !== "number" || value.expiresAt <= now) throw new Error("E2E S3 lease does not belong to this run or has expired");
    this.#lease = { runId: safeRunId, expiresAt: value.expiresAt, ...(object.etag === undefined ? {} : { etag: object.etag }) };
  }

  assertLease(runId: string): void {
    if (!this.#lease || this.#lease.runId !== runId) throw new Error("E2E S3 cleanup requires the current run lease");
  }

  async cleanup(runId: string, prefix?: string): Promise<S3CleanupSummary> {
    const safeRunId = assertSafeIdentifier(runId, "run_id");
    this.assertLease(safeRunId);
    const scope = prefix === undefined ? undefined : validatePrefix(safeRunId, prefix);
    const inScope = (key: string): boolean => key !== LEASE_KEY && (scope === undefined || key.startsWith(scope));
    let deletedObjects = 0;
    let cursor: string | undefined;
    do {
      const page = await this.#api.listObjectsV2(cursor);
      const keys = page.keys.filter(inScope);
      if (keys.length) {
        await this.#api.deleteObjects(keys.map((key) => ({ key })));
        deletedObjects += keys.length;
      }
      cursor = page.nextCursor;
    } while (cursor);

    let deletedVersions = 0;
    let versionCursor: { key?: string; version?: string } | undefined;
    do {
      let page;
      try { page = await this.#api.listObjectVersions(versionCursor); }
      catch (error) {
        if (isOptionalS3OperationUnsupported(error)) break;
        throw error;
      }
      const objects = page.objects.filter((object) => inScope(object.key));
      if (objects.length) {
        await this.#api.deleteObjects(objects);
        deletedVersions += objects.length;
      }
      versionCursor = page.nextCursor;
    } while (versionCursor);

    let abortedMultipartUploads = 0;
    let uploadCursor: { key?: string; uploadId?: string } | undefined;
    do {
      let page;
      try { page = await this.#api.listMultipartUploads(uploadCursor); }
      catch (error) {
        if (isOptionalS3OperationUnsupported(error)) break;
        throw error;
      }
      for (const upload of page.uploads) {
        if (inScope(upload.key)) {
          await this.#api.abortMultipartUpload(upload.key, upload.uploadId);
          abortedMultipartUploads += 1;
        }
      }
      uploadCursor = page.nextCursor;
    } while (uploadCursor);

    await this.assertNoBusinessObjects(scope);
    return { deletedObjects, deletedVersions, abortedMultipartUploads };
  }

  async assertNoBusinessObjects(prefix?: string): Promise<void> {
    const inScope = (key: string): boolean => key !== LEASE_KEY && (prefix === undefined || key.startsWith(prefix));
    let cursor: string | undefined;
    do {
      const page = await this.#api.listObjectsV2(cursor);
      if (page.keys.some(inScope)) throw new Error("E2E S3 cleanup left a business object");
      cursor = page.nextCursor;
    } while (cursor);
    let versionCursor: { key?: string; version?: string } | undefined;
    do {
      let page;
      try { page = await this.#api.listObjectVersions(versionCursor); }
      catch (error) {
        if (isOptionalS3OperationUnsupported(error)) break;
        throw error;
      }
      if (page.objects.some((object) => inScope(object.key))) throw new Error("E2E S3 cleanup left a version or delete marker");
      versionCursor = page.nextCursor;
    } while (versionCursor);
  }

  /** 只读取本轮 prefix 下的对象数量，不返回对象内容。 */
  async countBusinessObjects(runId: string, prefix: string): Promise<number> {
    const safeRunId = assertSafeIdentifier(runId, "run_id");
    this.assertLease(safeRunId);
    const safePrefix = validatePrefix(safeRunId, prefix);
    let count = 0;
    let cursor: string | undefined;
    do {
      const page = await this.#api.listObjectsV2(cursor);
      count += page.keys.filter((key) => !key.startsWith(CONTROL_PREFIX) && key.startsWith(safePrefix)).length;
      cursor = page.nextCursor;
    } while (cursor);
    return count;
  }

  async releaseLease(runId: string): Promise<void> {
    this.assertLease(runId);
    if (!this.#lease?.etag) throw new Error("E2E S3 lease has no ETag and cannot be released safely");
    await this.#api.deleteObject(LEASE_KEY, { ifMatch: this.#lease.etag });
    this.#lease = undefined;
  }
}
