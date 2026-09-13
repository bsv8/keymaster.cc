import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { SecretString } from "../../support/secretString.js";
import type { E2ES3Config, E2ESatSubscriptionConfig, E2ESatSubscriptionPageConfig, LoadedE2EConfig, LoadedE2ES3Config, LoadedE2ESatSubscriptionConfig } from "./types.js";

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

function parseS3(value: Record<string, unknown>): E2ES3Config {
  const filename = "s3.json";
  const endpoint = validateEndpoint(requiredString(value.endpoint, "endpoint", filename), "endpoint", filename);
  const region = requiredString(value.region, "region", filename);
  // 不根据名称判断是否“专用桶”；s3.json 给出的桶就是本次测试使用的桶。
  const bucket = requiredString(value.bucket, "bucket", filename);
  const accessKeyId = requiredString(value.accessKeyId, "accessKeyId", filename);
  const secret = requiredString(value.secretAccessKey, "secretAccessKey", filename);
  const session = value.sessionToken === undefined ? undefined : requiredString(value.sessionToken, "sessionToken", filename);
  return {
    endpoint, region, bucket, accessKeyId,
    secretAccessKey: new SecretString(secret),
    ...(session === undefined ? {} : { sessionToken: new SecretString(session) }),
  };
}

/** 只解析页面表单需要的三个公开 Sat 字段，不触碰链 API 或授权字段。 */
function parseSatSubscriptionPage(value: Record<string, unknown>): E2ESatSubscriptionPageConfig {
  const websocket = requiredString(value.websocket, "websocket", "satsubscription.json");
  const webrtcDirect = requiredString(value["webrtc-direct"], "webrtc-direct", "satsubscription.json");
  // 真实配置字段名是 publickeyhex；兼容旧模板中的 expectedServicePublicKeyHex，
  // 但最终统一暴露为页面供应商配置所需的 supplierPublicKeyHex。
  const publicKeyValue = value.publickeyhex ?? value.expectedServicePublicKeyHex;
  const publicKeyField = value.publickeyhex !== undefined ? "publickeyhex" : "expectedServicePublicKeyHex";
  const supplierPublicKeyHex = requiredString(publicKeyValue, publicKeyField, "satsubscription.json");
  if (!/^0[23][0-9a-f]{64}$/iu.test(supplierPublicKeyHex)) reject("config-identity-invalid", "satsubscription.json 的 publickeyhex 不是合法压缩公钥");
  return {
    websocket,
    webrtcDirect,
    supplierPublicKeyHex: supplierPublicKeyHex.toLowerCase(),
  };
}

/** 解析完整资源配置；只有 resource-setup 资金准备会使用链 API 字段。 */
function parseSatSubscription(value: Record<string, unknown>): E2ESatSubscriptionConfig {
  const pageConfig = parseSatSubscriptionPage(value);
  const testnetApiBaseUrl = value.testnetApiBaseUrl === undefined || value.testnetApiBaseUrl === ""
    ? "https://api.whatsonchain.com/v1/bsv"
    : validateEndpoint(requiredString(value.testnetApiBaseUrl, "testnetApiBaseUrl", "satsubscription.json"), "testnetApiBaseUrl", "satsubscription.json");
  const authorization = value.testnetApiAuthorization === undefined || value.testnetApiAuthorization === ""
    ? undefined
    : new SecretString(requiredString(value.testnetApiAuthorization, "testnetApiAuthorization", "satsubscription.json"));
  return {
    ...pageConfig,
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

/**
 * 只加载真实 S3 Journey 所需的配置。
 *
 * 这样 S3 初始化不会因为同一目录里的 SatSubscription/testnet 配置暂时
 * 不可用而无法执行；该 Journey 仍然只连接 s3.json 指定的真实桶。
 */
export async function loadE2ES3Config(options: { readonly workspaceRoot?: string; readonly configDir?: string } = {}): Promise<LoadedE2ES3Config> {
  const directory = await checkDirectory(options.configDir ?? process.env.KEYMASTER_E2E_CONFIG_DIR ?? DEFAULT_CONFIG_DIR, options.workspaceRoot ?? process.cwd());
  const s3 = parseS3(parseObject(await readPrivateFile(directory, "s3.json"), "s3.json"));
  return { directory, s3 };
}

/**
 * 只加载真实 SatSubscription 页面 Journey 所需的配置。
 *
 * 该函数只读取公开连接入口和供应商公钥，不读取 S3 凭据或 testnet 私钥；
 * 页面测试仍必须通过 page.fill/page.click 把映射后的字段交给真实页面。
 */
export async function loadE2ESatSubscriptionConfig(options: { readonly workspaceRoot?: string; readonly configDir?: string } = {}): Promise<LoadedE2ESatSubscriptionConfig> {
  const directory = await checkDirectory(options.configDir ?? process.env.KEYMASTER_E2E_CONFIG_DIR ?? DEFAULT_CONFIG_DIR, options.workspaceRoot ?? process.cwd());
  const satsubscription = parseSatSubscriptionPage(parseObject(await readPrivateFile(directory, "satsubscription.json"), "satsubscription.json"));
  return { directory, satsubscription };
}

/** 仅用于测试/诊断配置指纹，输入不包含任何秘密值。 */
export function publicConfigFingerprint(config: Pick<LoadedE2EConfig, "directory" | "s3" | "satsubscription">): string {
  const publicShape = JSON.stringify({ directory: config.directory, endpoint: config.s3.endpoint, bucket: config.s3.bucket, region: config.s3.region, websocket: config.satsubscription.websocket, webrtcDirect: config.satsubscription.webrtcDirect, supplierPublicKeyHex: config.satsubscription.supplierPublicKeyHex, testnetApiBaseUrl: config.satsubscription.testnetApiBaseUrl });
  return createHash("sha256").update(publicShape).digest("hex").slice(0, 16);
}

/** 真实 S3 单资源运行状态使用的公开配置指纹。 */
export function publicS3ConfigFingerprint(config: Pick<LoadedE2ES3Config, "directory" | "s3">): string {
  const publicShape = JSON.stringify({ directory: config.directory, endpoint: config.s3.endpoint, bucket: config.s3.bucket, region: config.s3.region });
  return createHash("sha256").update(publicShape).digest("hex").slice(0, 16);
}
