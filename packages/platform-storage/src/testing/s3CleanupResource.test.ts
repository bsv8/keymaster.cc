import { describe, expect, it } from "vitest";
import type { S3CleanupApi } from "./s3CleanupAdapter.js";
import { S3CleanupResource } from "./s3CleanupResource.js";

/** 单元测试专用的内存 S3 API；真实桶写入只在 Playwright real-resource 层发生。 */
class MemoryS3Api implements S3CleanupApi {
  readonly objects = new Map<string, { body: string; etag: string }>([
    ["run-resource-safety/business/one", { body: "one", etag: "business-v1" }],
    ["run-resource-safety/business/two", { body: "two", etag: "business-v2" }],
  ]);
  versions = [
    { key: "run-resource-safety/business/one", versionId: "v1" },
    { key: "run-resource-safety/business/old", versionId: "v2" },
  ];
  readonly uploads = [
    { key: "run-resource-safety/business/upload", uploadId: "upload-1" },
    { key: ".keymaster-e2e/control-upload", uploadId: "control-upload" },
  ];
  readonly abortedUploads: string[] = [];
  #etagCounter = 0;

  async getObject(key: string): Promise<{ body: string; etag?: string } | null> {
    const value = this.objects.get(key);
    return value ? { ...value } : null;
  }

  async putObject(key: string, body: string, options: { ifNoneMatch?: string } = {}): Promise<{ etag?: string }> {
    if (options.ifNoneMatch === "*" && this.objects.has(key)) throw new Error("conditional put conflict");
    const etag = `etag-${++this.#etagCounter}`;
    this.objects.set(key, { body, etag });
    return { etag };
  }

  async deleteObject(key: string, options: { ifMatch?: string } = {}): Promise<void> {
    const current = this.objects.get(key);
    if (options.ifMatch !== undefined && current?.etag !== options.ifMatch) throw new Error("conditional delete conflict");
    this.objects.delete(key);
  }

  async listObjectsV2(): Promise<{ keys: readonly string[]; nextCursor?: string }> {
    return { keys: [...this.objects.keys()] };
  }

  async listObjectVersions(): Promise<{ objects: readonly { key: string; versionId?: string }[]; nextCursor?: { key?: string; version?: string } }> {
    return { objects: [...this.versions] };
  }

  async listMultipartUploads(): Promise<{ uploads: readonly { key: string; uploadId: string }[]; nextCursor?: { key?: string; uploadId?: string } }> {
    return { uploads: [...this.uploads] };
  }

  async deleteObjects(objects: readonly { key: string; versionId?: string }[]): Promise<void> {
    for (const object of objects) {
      if (object.versionId === undefined) this.objects.delete(object.key);
      else this.versions = this.versions.filter((item) => item.key !== object.key || item.versionId !== object.versionId);
    }
  }

  async abortMultipartUpload(_key: string, uploadId: string): Promise<void> {
    this.abortedUploads.push(uploadId);
  }
}

function resourceConfig() {
  return {
    endpoint: "https://s3.example.test",
    region: "us-east-1",
    bucket: "keymaster-e2e-bucket",
    accessKeyId: "unit-access",
    secretAccessKey: { read: () => "unit-secret" },
  };
}

describe("S3CleanupResource 作用域和 lease", () => {
  it("在内存单元层验证 prefix、全量、版本和 multipart 收尾", async () => {
    const api = new MemoryS3Api();
    const resource = new S3CleanupResource(resourceConfig(), api);
    await resource.acquireLease("run-resource-safety");

    const competing = new S3CleanupResource(resourceConfig(), api);
    await expect(competing.acquireLease("other-run")).rejects.toThrow(/lease is held/iu);
    expect(await resource.countBusinessObjects("run-resource-safety", "run-resource-safety/business/")).toBe(2);
    await expect(resource.countBusinessObjects("run-resource-safety", "../outside/")).rejects.toThrow(/prefix is invalid/iu);

    await api.putObject("run-resource-safety/scenario/object", "scenario");
    await api.putObject("outside-run/keep", "keep");
    const prefixSummary = await resource.cleanup("run-resource-safety", "run-resource-safety/scenario/");
    expect(prefixSummary).toEqual({ deletedObjects: 1, deletedVersions: 0, abortedMultipartUploads: 0 });
    expect(api.objects.has("outside-run/keep")).toBe(true);

    await expect(resource.cleanup("other-run")).rejects.toThrow(/current run lease/iu);
    const summary = await resource.cleanup("run-resource-safety");
    expect(summary).toEqual({ deletedObjects: 3, deletedVersions: 2, abortedMultipartUploads: 2 });
    expect(api.abortedUploads).toEqual(["upload-1", "control-upload"]);

    await resource.releaseLease("run-resource-safety");
    expect(api.objects.has(".keymaster-e2e/lease.json")).toBe(false);
  });
});
