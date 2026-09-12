/**
 * Node 侧 E2E S3 清理适配器。
 *
 * 它只提供 AWS SDK 到最小清理接口的转换，不知道 E2E ownership/lease 规则；
 * 规则仍由 e2e/integration/resources/s3 的 Resource 负责，避免生产页面获得
 * 桶级删除能力。
 */
import {
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export interface S3CleanupApiConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface S3CleanupApi {
  getObject(key: string): Promise<{ readonly body: string; readonly etag?: string } | null>;
  putObject(key: string, body: string, options?: { readonly ifNoneMatch?: string }): Promise<{ readonly etag?: string }>;
  deleteObject(key: string, options?: { readonly ifMatch?: string }): Promise<void>;
  listObjectsV2(cursor?: string): Promise<{ readonly keys: readonly string[]; readonly nextCursor?: string }>;
  listObjectVersions(cursor?: { readonly key?: string; readonly version?: string }): Promise<{
    readonly objects: readonly { readonly key: string; readonly versionId?: string }[];
    readonly nextCursor?: { readonly key?: string; readonly version?: string };
  }>;
  listMultipartUploads(cursor?: { readonly key?: string; readonly uploadId?: string }): Promise<{
    readonly uploads: readonly { readonly key: string; readonly uploadId: string }[];
    readonly nextCursor?: { readonly key?: string; readonly uploadId?: string };
  }>;
  deleteObjects(objects: readonly { readonly key: string; readonly versionId?: string }[]): Promise<void>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
}

function notFound(error: unknown): boolean {
  const value = error as { name?: unknown; $metadata?: { httpStatusCode?: number } } | undefined;
  return value?.name === "NotFound" || value?.name === "NoSuchKey" || value?.$metadata?.httpStatusCode === 404;
}

async function readBody(body: unknown): Promise<string> {
  if (body && typeof body === "object" && "transformToString" in body && typeof body.transformToString === "function") return await (body.transformToString as () => Promise<string>)();
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  throw new Error("S3 control object body is not supported");
}

/** 创建带有条件写入、版本和 multipart 读取能力的 S3 清理 API。 */
export function createS3CleanupApi(config: S3CleanupApiConfig): S3CleanupApi {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: false,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      ...(config.sessionToken === undefined ? {} : { sessionToken: config.sessionToken }),
    },
  });
  const common = { Bucket: config.bucket };
  return {
    async getObject(key) {
      try {
        const result = await client.send(new GetObjectCommand({ ...common, Key: key }));
        return { body: await readBody(result.Body), ...(result.ETag === undefined ? {} : { etag: result.ETag }) };
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
    },
    async putObject(key, body, options = {}) {
      const result = await client.send(new PutObjectCommand({ ...common, Key: key, Body: body, ...(options.ifNoneMatch === undefined ? {} : { IfNoneMatch: options.ifNoneMatch }) }));
      return result.ETag === undefined ? {} : { etag: result.ETag };
    },
    async deleteObject(key, options = {}) {
      await client.send(new DeleteObjectCommand({ ...common, Key: key, ...(options.ifMatch === undefined ? {} : { IfMatch: options.ifMatch }) }));
    },
    async listObjectsV2(cursor) {
      const result = await client.send(new ListObjectsV2Command({ ...common, ContinuationToken: cursor }));
      return { keys: (result.Contents ?? []).flatMap((item) => item.Key === undefined ? [] : [item.Key]), ...(result.NextContinuationToken === undefined ? {} : { nextCursor: result.NextContinuationToken }) };
    },
    async listObjectVersions(cursor = {}) {
      const result = await client.send(new ListObjectVersionsCommand({ ...common, KeyMarker: cursor.key, VersionIdMarker: cursor.version }));
      const objects = [
        ...(result.Versions ?? []).flatMap((item) => item.Key === undefined ? [] : [{ key: item.Key, ...(item.VersionId === undefined ? {} : { versionId: item.VersionId }) }]),
        ...(result.DeleteMarkers ?? []).flatMap((item) => item.Key === undefined ? [] : [{ key: item.Key, ...(item.VersionId === undefined ? {} : { versionId: item.VersionId }) }]),
      ];
      const nextCursor = result.IsTruncated && (result.NextKeyMarker !== undefined || result.NextVersionIdMarker !== undefined) ? { key: result.NextKeyMarker, version: result.NextVersionIdMarker } : undefined;
      return { objects, ...(nextCursor === undefined ? {} : { nextCursor }) };
    },
    async listMultipartUploads(cursor = {}) {
      const result = await client.send(new ListMultipartUploadsCommand({ ...common, KeyMarker: cursor.key, UploadIdMarker: cursor.uploadId }));
      const uploads = (result.Uploads ?? []).flatMap((item) => item.Key === undefined || item.UploadId === undefined ? [] : [{ key: item.Key, uploadId: item.UploadId }]);
      const nextCursor = result.IsTruncated && (result.NextKeyMarker !== undefined || result.NextUploadIdMarker !== undefined) ? { key: result.NextKeyMarker, uploadId: result.NextUploadIdMarker } : undefined;
      return { uploads, ...(nextCursor === undefined ? {} : { nextCursor }) };
    },
    async deleteObjects(objects) {
      for (let offset = 0; offset < objects.length; offset += 1_000) {
        const result = await client.send(new DeleteObjectsCommand({ ...common, Delete: { Objects: objects.slice(offset, offset + 1_000).map((object) => ({ Key: object.key, ...(object.versionId === undefined ? {} : { VersionId: object.versionId }) })) } }));
        if ((result.Errors ?? []).length > 0) throw new Error("S3 object cleanup returned deletion errors");
      }
    },
    async abortMultipartUpload(key, uploadId) {
      await client.send(new AbortMultipartUploadCommand({ ...common, Key: key, UploadId: uploadId }));
    },
  };
}

