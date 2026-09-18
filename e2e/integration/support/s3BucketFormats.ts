// 按 KeymasterFormats 校验真实 S3 桶中的业务文件与浏览器身份文件。
//
// S3 桶里只有"桶内文件"：
//   - `<prefix>/keys/<公钥>.keyhold`  KeyHold 文档（一个 Key 一个文件）
//   - `<prefix>/<公钥>/lock.json`     Key 应用锁
// 设备记录 `keymaster.device.<ID>` 与 `keymaster.session` 和其它后端一样
// 只保存在本机 localStorage，不进入远端桶。
//
// 校验对象是外部 S3 API 读到的真实字节，不是页面断言。

import { expect, type Page } from "@playwright/test";
import { createAwsS3Api, type S3CleanupResourceConfig } from "../resources/s3/s3CleanupResource.js";
import {
  assertKeyHoldDocument,
  assertKeyLockDocument,
  base64UrlBytes,
  expectExactKeys,
  parseJson,
  PUBLIC_KEY_PATTERN,
  readRawLocalStorage,
} from "./localBucketFormats.js";

const SESSION_ID_PATTERN = /^[0-9a-f]{32}$/u;

export interface S3BucketStorageExpectation {
  /** 逻辑桶根：连接配置里的对象前缀（如 `e2e-<runId>/J-REAL-S3-INIT`）。 */
  readonly prefix: string;
  readonly ownerPublicKeyHex: string;
  readonly keyLabel: string;
  readonly sessionId: string;
}

export interface S3IdentityExpectation {
  readonly bucketId: string;
  readonly ownerPublicKeyHex: string;
  /** 可选：与 `keymaster.session` 交叉校验的一次性期望值。 */
  readonly sessionId?: string;
}

function fail(message: string): never {
  throw new Error(message);
}

function normalizedPrefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+|\/+$/gu, "");
  if (!trimmed) fail("S3 逻辑桶前缀不能为空");
  return trimmed;
}

/** 只读列出整个桶的对象键；调用方自行按前缀过滤。 */
async function listAllKeys(config: S3CleanupResourceConfig): Promise<string[]> {
  const api = createAwsS3Api(config);
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.listObjectsV2(cursor);
    keys.push(...page.keys);
    cursor = page.nextCursor;
  } while (cursor);
  return keys;
}

/** 读取当前浏览器 session 的 sessionId（锁文件 holder 校验用）。 */
export async function readS3SessionId(page: Page): Promise<string> {
  const entries = await readRawLocalStorage(page);
  const sessionEntry = entries.find((entry) => entry.key === "keymaster.session");
  if (!sessionEntry) fail("缺少浏览器 session 记录 keymaster.session");
  const session = parseJson(sessionEntry.value, "session 记录");
  if (typeof session.sessionId !== "string" || !SESSION_ID_PATTERN.test(session.sessionId)) fail("session.sessionId 必须是 32 位小写 hex");
  return session.sessionId;
}

/**
 * 校验 S3 桶中本场景前缀下的业务文件内容与旧格式缺席。
 *
 * 需要当前存在有效的 Key 应用锁（初始化完成后、或解锁恢复后调用）。
 */
export async function assertS3BucketStorage(
  config: S3CleanupResourceConfig,
  expectation: S3BucketStorageExpectation,
): Promise<void> {
  const prefix = normalizedPrefix(expectation.prefix);
  const keys = (await listAllKeys(config)).filter((key) => key.startsWith(`${prefix}/`));
  const api = createAwsS3Api(config);

  // 1) keys/ 目录：一 Key 一文件，文件名就是公钥。
  const keyHoldPath = `${prefix}/keys/${expectation.ownerPublicKeyHex}.keyhold`;
  const keyFiles = keys.filter((key) => key.startsWith(`${prefix}/keys/`));
  expect(keyFiles, `keys/ 下应只有首 Key 的 KeyHold 文件,实际: ${keyFiles.join(", ")}`).toEqual([keyHoldPath]);
  const keyHoldObject = await api.getObject(keyHoldPath);
  if (!keyHoldObject) fail(`S3 桶缺少 KeyHold 文件 ${keyHoldPath}`);
  assertKeyHoldDocument(parseJson(keyHoldObject.body, "S3 KeyHold 文档"), {
    publicKeyHex: expectation.ownerPublicKeyHex,
    label: expectation.keyLabel,
  });

  // 2) Key 应用锁：使用中的 Key 必须持有未过期锁，holder 是当前 session。
  const lockPath = `${prefix}/${expectation.ownerPublicKeyHex}/lock.json`;
  const lockObject = await api.getObject(lockPath);
  if (!lockObject) fail(`S3 桶缺少 Key 应用锁 ${lockPath}`);
  assertKeyLockDocument(parseJson(lockObject.body, "S3 Key 锁文件"), { sessionId: expectation.sessionId });

  // 3) 旧格式不得出现（旧 keys.json 容器与旧 .keymaster/buckets/ 物理根）。
  const legacy = keys.filter((key) =>
    key === `${prefix}/keys.json`
    || key === `${prefix}/keymaster/keys.json`
    || key.startsWith(`${prefix}/.keymaster/buckets/`));
  expect(legacy, `S3 桶出现旧格式对象: ${legacy.join(", ")}`).toEqual([]);
}

/**
 * 校验 S3 身份文件：设备记录带 s3 location + 启动密码密文，session 指向当前桶与 Key。
 *
 * 私钥、启动密码与访问凭据都不允许以明文出现在浏览器目录里。
 */
export async function assertS3IdentityStorage(page: Page, expectation: S3IdentityExpectation): Promise<void> {
  const entries = await readRawLocalStorage(page);

  const deviceEntry = entries.find((entry) => entry.key === `keymaster.device.${expectation.bucketId}`);
  if (!deviceEntry) fail(`缺少设备桶记录 keymaster.device.${expectation.bucketId}`);
  const device = parseJson(deviceEntry.value, "设备桶记录");
  expectExactKeys(device, ["format", "version", "displayName", "location", "cipher", "capabilities"], "设备桶记录");
  if (device.format !== "keymaster.device" || device.version !== 1) fail("设备桶记录 format/version 必须是 keymaster.device/1");
  // 条件写能力在连接/初始化探测后随记录持久化；只允许已探测成功的两种取值。
  if (device.capabilities !== undefined) {
    const capabilities = device.capabilities as Record<string, unknown>;
    if (capabilities.conditionalWrites !== "native" && capabilities.conditionalWrites !== "best-effort") fail("设备桶记录 capabilities.conditionalWrites 非法");
  }
  const location = device.location as Record<string, unknown>;
  expectExactKeys(location, ["providerId", "endpoint", "region", "bucket", "prefix"], "设备桶记录 location");
  if (location.providerId !== "s3") fail("设备桶记录 location.providerId 必须是 s3");
  if (typeof location.endpoint !== "string" || !location.endpoint.startsWith("http")) fail("设备桶记录 location.endpoint 必须是 HTTPS 地址");
  if (typeof location.region !== "string" || location.region.length === 0) fail("设备桶记录 location.region 不能为空");
  if (typeof location.bucket !== "string" || location.bucket.length === 0) fail("设备桶记录 location.bucket 不能为空");
  const cipher = device.cipher as Record<string, unknown>;
  expectExactKeys(cipher, ["algorithm", "keyLengthBits", "ivB64Url", "tagLengthBits", "ciphertextAndTagB64Url"], "设备桶记录 cipher");
  if (cipher.algorithm !== "aes-gcm" || cipher.keyLengthBits !== 256 || cipher.tagLengthBits !== 128) fail("设备桶记录 cipher 算法参数不符合格式");
  if (base64UrlBytes(cipher.ivB64Url) !== 12) fail("设备桶记录 cipher.ivB64Url 必须是 12 字节");
  const cipherBytes = base64UrlBytes(cipher.ciphertextAndTagB64Url);
  if (cipherBytes === undefined || cipherBytes < 16) fail("设备桶记录 cipher 密文（含 16 字节 tag）不合法");

  for (const entry of entries) {
    if (entry.key.startsWith("keymaster.device.") && entry.key !== deviceEntry.key) {
      fail(`同一轮 S3 初始化不应登记第二个桶记录: ${entry.key}`);
    }
  }

  const sessionEntry = entries.find((entry) => entry.key === "keymaster.session");
  if (!sessionEntry) fail("缺少浏览器 session 记录 keymaster.session");
  const session = parseJson(sessionEntry.value, "session 记录");
  expectExactKeys(session, ["format", "version", "sessionId", "activeBucketId", "activeKey", "keyDerivation"], "session 记录");
  if (session.format !== "keymaster.session" || session.version !== 1) fail("session format/version 必须是 keymaster.session/1");
  if (typeof session.sessionId !== "string" || !SESSION_ID_PATTERN.test(session.sessionId)) fail("session.sessionId 必须是 32 位小写 hex");
  if (expectation.sessionId !== undefined && session.sessionId !== expectation.sessionId) fail("session.sessionId 与期望不一致");
  if (session.activeBucketId !== expectation.bucketId) fail("session.activeBucketId 必须等于当前桶 ID");
  if (session.activeKey !== expectation.ownerPublicKeyHex) fail("session.activeKey 必须等于首 Key 公钥");
  const derivation = session.keyDerivation as Record<string, unknown>;
  expectExactKeys(derivation, ["algorithm", "passwordEncoding", "iterations", "outputLengthBits", "saltB64Url"], "session keyDerivation");
  if (derivation.algorithm !== "pbkdf2-hmac-sha-256" || derivation.passwordEncoding !== "utf-8" || derivation.outputLengthBits !== 256) {
    fail("session keyDerivation 的算法/编码/长度不符合格式");
  }
  if (base64UrlBytes(derivation.saltB64Url) !== 16) fail("session keyDerivation.saltB64Url 必须是 16 字节");

  if (!PUBLIC_KEY_PATTERN.test(expectation.ownerPublicKeyHex)) fail("ownerPublicKeyHex 不是合法压缩公钥");

  for (const legacy of [
    "keymaster.device-bootstrap.v1",
    "keymaster.storage.catalog.v2",
    "keymaster.storage.catalog",
    "keymaster.storage.initial-setup.recovery.v1",
  ]) {
    if (entries.some((entry) => entry.key === legacy)) fail(`旧格式键仍然存在: ${legacy}`);
  }
}
