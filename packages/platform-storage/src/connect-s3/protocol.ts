import { defineCapability } from "webloom-framework";

/** Storage 私有设置面；不进入 Connect wire 或公共 Coordinator RPC。 */
export interface ConnectS3Config {
  endpoint: string;
  region: string;
  bucket: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}
export type ConnectS3Summary = Pick<ConnectS3Config, "endpoint" | "region" | "bucket" | "forcePathStyle">;
export type ConnectS3Request = { expectedSessionEpoch: string } & (
  { type: "get" } | { type: "save"; config: ConnectS3Config } | { type: "clear" } | { type: "probe" }
);
export interface ConnectS3Failure {
  stage: "configuration" | "list" | "write" | "read" | "verify" | "delete" | "cancelled";
  cleanupFailed: boolean;
  /** 仅返回给钱包自己的设置页，供人工清理本次随机测试对象。 */
  objectKey?: string;
  httpStatus?: number;
}
export interface ConnectS3Response { configured: boolean; config?: ConnectS3Summary; failure?: ConnectS3Failure }
export const STORAGE_PRIVATE_S3_CAPABILITY = defineCapability<ConnectS3Request, ConnectS3Response>({
  kind: "rpc", id: "storage.private.connect-s3", version: "1",
  request: { parse: value => structuredClone(value as ConnectS3Request) },
  response: { parse: value => {
    const response = value as ConnectS3Response;
    const config = response.config;
    const failure = response.failure;
    return { configured: response.configured, ...(failure ? { failure: { stage: failure.stage, cleanupFailed: failure.cleanupFailed,
      ...(failure.objectKey === undefined ? {} : { objectKey: failure.objectKey }), ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
    } } : {}), ...(config ? { config: {
      endpoint: config.endpoint, region: config.region, bucket: config.bucket, forcePathStyle: config.forcePathStyle,
    } } : {}) };
  } },
});
