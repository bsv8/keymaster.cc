import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { SecretString } from "../../support/secretString.js";
import type { E2ES3Config, E2ESatSubscriptionConfig, LoadedE2EConfig } from "./types.js";

/** secp256k1 的阶；这里只用于检查资金种子格式，不导出或记录私钥。 */
const SECP256K1_ORDER = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const DEFAULT_CONFIG_DIR = "/home/david/.config/keymaster-e2e";
const JSON_FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

export class E2EConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "E2EConfigError";
    this.code = code;
  }
}

function reject(code: string, message: string): never {
  throw new E2EConfigError(code, message);
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function checkDirectory(directory: string, workspaceRoot: string): Promise<string> {
  const requested = path.resolve(directory);
  let realDirectory: string;
  try {
    const link = await lstat(requested);
    if (!link.isDirectory() || link.isSymbolicLink()) reject("config-directory-type", "E2E 配置目录必须是非符号链接目录");
    realDirectory = await realpath(requested);
  } catch (error) {
    if (error instanceof E2EConfigError) throw error;
    reject("config-directory-missing", "E2E 配置目录不存在或不可读取");
  }
  let realWorkspace: string;
  try { realWorkspace = await realpath(path.resolve(workspaceRoot)); }
  catch { reject("workspace-path-invalid", "无法确认 Git 工作树真实路径"); }
  if (isWithin(realWorkspace, realDirectory)) reject("config-directory-in-worktree", "E2E 配置目录必须位于 Git 工作树之外");
  const stat = await lstat(realDirectory);
  const mode = stat.mode & 0o777;
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) reject("config-directory-owner", "E2E 配置目录必须归当前运行用户所有");
  if ((mode & ~DIRECTORY_MODE) !== 0 || (mode & DIRECTORY_MODE) !== DIRECTORY_MODE) reject("config-directory-mode", "E2E 配置目录必须是当前用户可读写进入且权限不宽于 0700");
  return realDirectory;
}

async function readPrivateFile(directory: string, filename: string): Promise<string> {
  const target = path.join(directory, filename);
  let stat;
  try { stat = await lstat(target); }
  catch { reject("config-file-missing", `${filename} 不存在或不可读取`); }
  if (!stat.isFile() || stat.isSymbolicLink()) reject("config-file-type", `${filename} 必须是普通文件且不能是符号链接`);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) reject("config-file-owner", `${filename} 必须归当前运行用户所有`);
  const mode = stat.mode & 0o777;
  if ((mode & ~JSON_FILE_MODE) !== 0 || (mode & 0o400) === 0) reject("config-file-mode", `${filename} 权限必须不宽于 0600`);
  try { return await readFile(target, "utf8"); }
  catch { reject("config-file-read", `${filename} 不可读取`); }
}

function parseObject(text: string, filename: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) reject("config-json-shape", `${filename} 必须是 JSON 对象`);
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof E2EConfigError) throw error;
    reject("config-json-invalid", `${filename} 不是有效 JSON`);
  }
}

function requiredString(value: unknown, field: string, filename: string): string {
  if (typeof value !== "string" || value.trim() === "") reject("config-field-invalid", `${filename} 缺少合法字段 ${field}`);
  return value.trim();
}

function validateEndpoint(value: string, field: string, filename: string): string {
  let url;
  try { url = new URL(value); }
  catch { reject("config-url-invalid", `${filename} 字段 ${field} 必须是有效 URL`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) reject("config-url-invalid", `${filename} 字段 ${field} 必须是无凭据、无 query、无 fragment 的 HTTPS URL`);
  return url.toString().replace(/\/$/u, "");
}

function validateBucket(value: string, filename: string): string {
  if (!/^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])?$/u.test(value) || value.length < 3 || value.length > 63 || value.includes("..")) reject("config-bucket-invalid", `${filename} 的 bucket 不是合法 S3 桶名称`);
  return value;
}

function parseS3(value: Record<string, unknown>): E2ES3Config {
  const filename = "s3.json";
  if (value.purpose !== "keymaster-e2e") reject("config-purpose-invalid", "s3.json 必须声明 purpose=keymaster-e2e");
  if (value.allowBucketWideCleanup !== true) reject("config-cleanup-not-authorized", "s3.json 必须明确 allowBucketWideCleanup=true");
  const endpoint = validateEndpoint(requiredString(value.endpoint, "endpoint", filename), "endpoint", filename);
  const region = requiredString(value.region, "region", filename);
  const bucket = validateBucket(requiredString(value.bucket, "bucket", filename), filename);
  const accessKeyId = requiredString(value.accessKeyId, "accessKeyId", filename);
  const secret = requiredString(value.secretAccessKey, "secretAccessKey", filename);
  const session = value.sessionToken === undefined ? undefined : requiredString(value.sessionToken, "sessionToken", filename);
  const ownershipKey = value.ownershipKey === undefined ? ".keymaster-e2e/ownership.json" : requiredString(value.ownershipKey, "ownershipKey", filename);
  const leaseKey = value.leaseKey === undefined ? ".keymaster-e2e/lease.json" : requiredString(value.leaseKey, "leaseKey", filename);
  const validControlKey = (key: string): boolean => key.startsWith(".keymaster-e2e/") && key.length > ".keymaster-e2e/".length && !key.split("/").includes("..") && !key.endsWith("/");
  if (!validControlKey(ownershipKey) || !validControlKey(leaseKey) || ownershipKey === leaseKey) reject("config-control-key-invalid", "S3 ownership 和 lease key 必须是 .keymaster-e2e/ 下的两个不同对象");
  return {
    purpose: "keymaster-e2e", allowBucketWideCleanup: true, endpoint, region, bucket, accessKeyId,
    secretAccessKey: new SecretString(secret),
    ...(session === undefined ? {} : { sessionToken: new SecretString(session) }),
    ownershipKey, leaseKey,
  };
}

function parseSatSubscription(value: Record<string, unknown>): E2ESatSubscriptionConfig {
  const websocket = requiredString(value.websocket, "websocket", "satsubscription.json");
  let parsed;
  try { parsed = new URL(websocket); }
  catch { reject("config-url-invalid", "satsubscription.json 的 websocket 必须是有效 URL"); }
  if (parsed.protocol !== "wss:" || parsed.username || parsed.password || parsed.search || parsed.hash) reject("config-url-invalid", "satsubscription.json 的 websocket 必须是无凭据的 wss:// 地址");
  const webrtcDirect = requiredString(value["webrtc-direct"], "webrtc-direct", "satsubscription.json");
  const expected = value.expectedServicePublicKeyHex === undefined ? undefined : requiredString(value.expectedServicePublicKeyHex, "expectedServicePublicKeyHex", "satsubscription.json");
  if (expected !== undefined && !/^0[23][0-9a-f]{64}$/iu.test(expected)) reject("config-identity-invalid", "satsubscription.json 的 expectedServicePublicKeyHex 不是合法压缩公钥");
  const testnetApiBaseUrl = value.testnetApiBaseUrl === undefined || value.testnetApiBaseUrl === ""
    ? "https://api.whatsonchain.com/v1/bsv"
    : validateEndpoint(requiredString(value.testnetApiBaseUrl, "testnetApiBaseUrl", "satsubscription.json"), "testnetApiBaseUrl", "satsubscription.json");
  const authorization = value.testnetApiAuthorization === undefined || value.testnetApiAuthorization === ""
    ? undefined
    : new SecretString(requiredString(value.testnetApiAuthorization, "testnetApiAuthorization", "satsubscription.json"));
  return {
    websocket: parsed.toString(),
    webrtcDirect,
    ...(expected === undefined ? {} : { expectedServicePublicKeyHex: expected.toLowerCase() }),
    testnetApiBaseUrl,
    ...(authorization === undefined ? {} : { testnetApiAuthorization: authorization }),
  };
}

function parseSeed(text: string): SecretString {
  const normalized = text.trim();
  if (!/^[0-9a-f]{64}$/iu.test(normalized)) reject("seed-format-invalid", "seed-key.hex 必须是 64 位十六进制私钥");
  const scalar = BigInt(`0x${normalized}`);
  if (scalar <= 0n || scalar >= SECP256K1_ORDER) reject("seed-scalar-invalid", "seed-key.hex 不是合法 secp256k1 私钥标量");
  return new SecretString(normalized.toLowerCase());
}

/**
 * 读取并验证三类真实资源配置。
 *
 * 失败只报告文件名、字段和门禁类别，不回显任何字段值；调用者负责在
 * 本轮结束时对返回的 SecretString 调用 clear()。
 */
export async function loadE2EConfig(options: { readonly workspaceRoot?: string; readonly configDir?: string } = {}): Promise<LoadedE2EConfig> {
  const directory = await checkDirectory(options.configDir ?? process.env.KEYMASTER_E2E_CONFIG_DIR ?? DEFAULT_CONFIG_DIR, options.workspaceRoot ?? process.cwd());
  const s3 = parseS3(parseObject(await readPrivateFile(directory, "s3.json"), "s3.json"));
  const satsubscription = parseSatSubscription(parseObject(await readPrivateFile(directory, "satsubscription.json"), "satsubscription.json"));
  const testnet = { privateKeyHex: parseSeed(await readPrivateFile(directory, "seed-key.hex")) };
  return { directory, s3, satsubscription, testnet };
}

/** 仅用于测试/诊断配置指纹，输入不包含任何秘密值。 */
export function publicConfigFingerprint(config: Pick<LoadedE2EConfig, "directory" | "s3" | "satsubscription">): string {
  const publicShape = JSON.stringify({ directory: config.directory, endpoint: config.s3.endpoint, bucket: config.s3.bucket, region: config.s3.region, websocket: config.satsubscription.websocket, webrtcDirect: config.satsubscription.webrtcDirect, testnetApiBaseUrl: config.satsubscription.testnetApiBaseUrl });
  return createHash("sha256").update(publicShape).digest("hex").slice(0, 16);
}
