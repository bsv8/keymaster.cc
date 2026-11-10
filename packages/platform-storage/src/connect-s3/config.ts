import { StorageRuntimeError } from "../runtime/storageError.js";
import type { ConnectS3Config, ConnectS3Summary } from "./protocol.js";

export function normalizeConnectS3Config(value: ConnectS3Config): ConnectS3Config {
  const fail = (): never => { throw new StorageRuntimeError("storage_provider_error", "Invalid S3 configuration"); };
  const text = (s: string, max = 2048) => typeof s === "string" && s.length > 0 && s.length <= max && !/[\u0000-\u001f\u007f]/u.test(s) ? s : fail();
  let url: URL;
  try { url = new URL(text(value.endpoint)); } catch { return fail(); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") fail();
  const bucket = text(value.bucket, 63);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket)) fail();
  if (typeof value.forcePathStyle !== "boolean") fail();
  return { endpoint: url.origin, region: text(value.region, 64), bucket,
    forcePathStyle: value.forcePathStyle, accessKeyId: text(value.accessKeyId, 256), secretAccessKey: text(value.secretAccessKey, 4096),
    ...(value.sessionToken ? { sessionToken: text(value.sessionToken, 16384) } : {}),
  };
}
export function connectS3Summary(config: ConnectS3Config): ConnectS3Summary {
  const { endpoint, region, bucket, forcePathStyle } = config;
  return { endpoint, region, bucket, forcePathStyle };
}
