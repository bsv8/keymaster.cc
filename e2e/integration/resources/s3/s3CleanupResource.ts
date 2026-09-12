import type { E2ES3Config } from "../config/types.js";
import { createS3CleanupApi, type S3CleanupApi } from "../../../../packages/platform-storage/src/testing/s3CleanupAdapter.js";

const CONTROL_PREFIX = ".keymaster-e2e/";
const OWNERSHIP_OWNER = "keymaster.cc";
const OWNERSHIP_PURPOSE = "exclusive-e2e-testing";

/** S3 控制对象的非敏感投影；ETag 只用于条件释放 lease。 */
interface ControlObject {
  readonly body: string;
  readonly etag?: string;
}

type S3Api = S3CleanupApi;

/** 将 AWS SDK 封装成可在 Resource 层测试的最小 API。 */
export function createAwsS3Api(config: E2ES3Config): S3Api {
  return createS3CleanupApi({
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey.read(),
    ...(config.sessionToken === undefined ? {} : { sessionToken: config.sessionToken.read() }),
  });
}

export interface S3OwnershipDocument {
  readonly owner: "keymaster.cc";
  readonly purpose: "exclusive-e2e-testing";
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
 * E2E 专用 S3 生命周期 Resource。
 *
 * 桶级清理只有在本地授权、远端 ownership 和当前 lease 三者同时成立时
 * 才能执行；调用者不能直接拿 AWS SDK 绕过这个边界。
 */
export class S3CleanupResource {
  readonly #config: E2ES3Config;
  readonly #api: S3Api;
  #lease: S3Lease | undefined;

  constructor(config: E2ES3Config, api = createAwsS3Api(config)) {
    this.#config = config;
    this.#api = api;
  }

  async assertOwnership(): Promise<S3OwnershipDocument> {
    const object = await this.#api.getObject(this.#config.ownershipKey);
    if (!object) throw new Error("E2E S3 ownership document is missing");
    let parsed: unknown;
    try { parsed = JSON.parse(object.body); }
    catch { throw new Error("E2E S3 ownership document is invalid JSON"); }
    const value = parsed as { owner?: unknown; purpose?: unknown };
    if (value.owner !== OWNERSHIP_OWNER || value.purpose !== OWNERSHIP_PURPOSE) throw new Error("E2E S3 ownership document does not authorize this bucket");
    return { owner: OWNERSHIP_OWNER, purpose: OWNERSHIP_PURPOSE };
  }

  async acquireLease(runId: string, now = Date.now(), ttlMs = 30 * 60_000): Promise<S3Lease> {
    if (this.#lease) throw new Error("E2E S3 lease is already held by this resource");
    await this.assertOwnership();
    const existing = await this.#api.getObject(this.#config.leaseKey);
    if (existing) {
      let expiresAt = Number.NaN;
      try { expiresAt = Number((JSON.parse(existing.body) as { expiresAt?: unknown }).expiresAt); } catch { /* treat malformed lease as active */ }
      if (!Number.isFinite(expiresAt) || expiresAt > now) throw new Error("E2E S3 bucket lease is held by another run");
      // 过期 lease 也不能无条件删除；使用 ETag 条件删除，避免抢走新运行的 lease。
      if (!existing.etag) throw new Error("E2E S3 expired lease has no ETag and cannot be recovered safely");
      await this.#api.deleteObject(this.#config.leaseKey, { ifMatch: existing.etag });
    }
    const lease = { version: 1, runId, acquiredAt: now, expiresAt: now + ttlMs };
    const created = await this.#api.putObject(this.#config.leaseKey, JSON.stringify(lease), { ifNoneMatch: "*" });
    this.#lease = { runId, expiresAt: lease.expiresAt, ...(created.etag === undefined ? {} : { etag: created.etag }) };
    return this.#lease;
  }

  /** Teardown 在另一个 Playwright project 中运行，只能认领本轮已有 lease。 */
  async adoptLease(runId: string, now = Date.now()): Promise<void> {
    await this.assertOwnership();
    const object = await this.#api.getObject(this.#config.leaseKey);
    if (!object) throw new Error("E2E S3 lease is missing during teardown");
    let value: { runId?: unknown; expiresAt?: unknown };
    try { value = JSON.parse(object.body) as { runId?: unknown; expiresAt?: unknown }; }
    catch { throw new Error("E2E S3 lease is invalid JSON"); }
    if (value.runId !== runId || typeof value.expiresAt !== "number" || value.expiresAt <= now) throw new Error("E2E S3 lease does not belong to this run or has expired");
    this.#lease = { runId, expiresAt: value.expiresAt, ...(object.etag === undefined ? {} : { etag: object.etag }) };
  }

  assertLease(runId: string): void {
    if (!this.#lease || this.#lease.runId !== runId) throw new Error("E2E S3 cleanup requires the current run lease");
  }

  async cleanup(runId: string): Promise<S3CleanupSummary> {
    this.assertLease(runId);
    await this.assertOwnership();
    let deletedObjects = 0;
    let cursor: string | undefined;
    do {
      const page = await this.#api.listObjectsV2(cursor);
      const keys = page.keys.filter((key) => !key.startsWith(CONTROL_PREFIX));
      if (keys.length) {
        await this.#api.deleteObjects(keys.map((key) => ({ key })));
        deletedObjects += keys.length;
      }
      cursor = page.nextCursor;
    } while (cursor);

    let deletedVersions = 0;
    let versionCursor: { key?: string; version?: string } | undefined;
    do {
      const page = await this.#api.listObjectVersions(versionCursor);
      const objects = page.objects.filter((object) => !object.key.startsWith(CONTROL_PREFIX));
      if (objects.length) {
        await this.#api.deleteObjects(objects);
        deletedVersions += objects.length;
      }
      versionCursor = page.nextCursor;
    } while (versionCursor);

    let abortedMultipartUploads = 0;
    let uploadCursor: { key?: string; uploadId?: string } | undefined;
    do {
      const page = await this.#api.listMultipartUploads(uploadCursor);
      for (const upload of page.uploads) {
        if (!upload.key.startsWith(CONTROL_PREFIX)) {
          await this.#api.abortMultipartUpload(upload.key, upload.uploadId);
          abortedMultipartUploads += 1;
        }
      }
      uploadCursor = page.nextCursor;
    } while (uploadCursor);

    await this.assertNoBusinessObjects();
    return { deletedObjects, deletedVersions, abortedMultipartUploads };
  }

  async assertNoBusinessObjects(): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await this.#api.listObjectsV2(cursor);
      if (page.keys.some((key) => !key.startsWith(CONTROL_PREFIX))) throw new Error("E2E S3 cleanup left a business object");
      cursor = page.nextCursor;
    } while (cursor);
    let versionCursor: { key?: string; version?: string } | undefined;
    do {
      const page = await this.#api.listObjectVersions(versionCursor);
      if (page.objects.some((object) => !object.key.startsWith(CONTROL_PREFIX))) throw new Error("E2E S3 cleanup left a version or delete marker");
      versionCursor = page.nextCursor;
    } while (versionCursor);
  }

  async releaseLease(runId: string): Promise<void> {
    this.assertLease(runId);
    if (!this.#lease?.etag) throw new Error("E2E S3 lease has no ETag and cannot be released safely");
    await this.#api.deleteObject(this.#config.leaseKey, { ifMatch: this.#lease.etag });
    this.#lease = undefined;
  }
}
