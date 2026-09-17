// 按 KeymasterFormats 校验 Local 桶在浏览器里的实际存储文件。
//
// 对 Local 桶而言,"桶内文件"就是 localStorage 里的键:
//   - `keymaster.device.<ID>` 设备桶记录(keymaster.device.v1)
//   - `keymaster.session`      浏览器 session(keymaster.session.v1)
//   - `keymaster.bucket.<ID>.keys/<公钥>.keyhold`  KeyHold 文档
//   - `keymaster.bucket.<ID>.<公钥>/lock.json`     Key 应用锁
//
// Local 物理键 = 逻辑桶路径加 `keymaster.bucket.<ID>.` 前缀。
//
// 这里不读私钥明文;只验证公开结构和密文封装形状。

import { expect, type Page } from "@playwright/test";

export interface LocalBucketStorageExpectation {
  readonly bucketId: string;
  readonly ownerPublicKeyHex: string;
  readonly keyLabel: string;
}

export interface LocalBucketStorageSnapshot {
  readonly deviceRecord: Record<string, unknown>;
  readonly session: Record<string, unknown>;
  readonly sessionId: string;
  readonly keyHold: Record<string, unknown>;
  readonly keyLock?: Record<string, unknown>;
}

export interface RawEntry {
  readonly key: string;
  readonly value: string;
}

const PUBLIC_KEY_PATTERN = /^(02|03)[0-9a-f]{64}$/u;
const SESSION_ID_PATTERN = /^[0-9a-f]{32}$/u;

function fail(message: string): never {
  throw new Error(message);
}

function parseJson(raw: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail(`${label} 必须是 JSON 对象`);
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    fail(`${label} 不是合法 JSON`);
  }
}

function expectExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) fail(`${label} 含未定义字段: ${extra.join(", ")}`);
}

/**
 * 桶内文件的 localStorage 值是原始字节的 base64（Local 适配器的物理编码），
 * 解析前必须先解码回 UTF-8 文本。
 */
function decodeFileValue(encoded: string, label: string): string {
  try {
    return Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    fail(`${label} 不是合法的 base64 文件内容`);
  }
}

/** base64url 解码后的字节数;非法返回 undefined。 */
function base64UrlBytes(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/") + "===".slice((value.length + 3) % 4);
  try {
    return Buffer.from(padded, "base64").byteLength;
  } catch {
    return undefined;
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${label} 必须是非负整数`);
}

export async function readRawLocalStorage(page: Page): Promise<RawEntry[]> {
  return page.evaluate(() => {
    const entries: Array<{ key: string; value: string }> = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key) entries.push({ key, value: window.localStorage.getItem(key) ?? "" });
    }
    return entries;
  });
}

/**
 * 身份相关文件的键值映射：设备记录、session、KeyHold 文件。
 *
 * 锁文件的时间戳、schema/盐等运行态文件会随心跳和装配变化，不在这里比较；
 * 这个映射用于判断一次失败操作是否改动了身份真值。
 */
export function identityFileMap(entries: readonly RawEntry[]): Record<string, string> {
  return Object.fromEntries(
    entries
      .filter((entry) => entry.key.startsWith("keymaster.device.")
        || entry.key === "keymaster.session"
        || entry.key.includes("/keys/"))
      .map((entry) => [entry.key, entry.value]),
  );
}

/**
 * 读取并校验一个 Local 桶的全部存储文件。
 *
 * 文件缺失、字段多余、格式/版本不符、密文封装形状不对都会直接失败；
 * 返回值给后续步骤继续断言（例如锁在锁定后应被删除）。
 */
export async function assertLocalBucketStorage(
  page: Page,
  expectation: LocalBucketStorageExpectation,
): Promise<LocalBucketStorageSnapshot> {
  const { bucketId, ownerPublicKeyHex, keyLabel } = expectation;
  const entries = await readRawLocalStorage(page);

  // 1) 设备桶记录:一桶一条,只保存连接信息。
  const device = entries.find((entry) => entry.key === `keymaster.device.${bucketId}`);
  if (!device) fail(`缺少设备桶记录 keymaster.device.${bucketId}`);
  const deviceRecord = parseJson(device.value, "设备桶记录");
  expectExactKeys(deviceRecord, ["format", "version", "displayName", "location"], "设备桶记录");
  if (deviceRecord.format !== "keymaster.device" || deviceRecord.version !== 1) fail("设备桶记录 format/version 必须是 keymaster.device/1");
  const location = deviceRecord.location as Record<string, unknown>;
  expectExactKeys(location, ["providerId"], "设备桶记录 location");
  if (location.providerId !== "local") fail("设备桶记录 location.providerId 必须是 local");
  for (const entry of entries) {
    if (entry.key.startsWith("keymaster.device.") && entry.key !== device.key) {
      fail(`同一轮初始化后不应存在第二个桶记录: ${entry.key}`);
    }
  }

  // 2) session:稳定身份 + active 桶 + active key。
  const sessionEntry = entries.find((entry) => entry.key === "keymaster.session");
  if (!sessionEntry) fail("缺少浏览器 session 记录 keymaster.session");
  const session = parseJson(sessionEntry.value, "session 记录");
  expectExactKeys(session, ["format", "version", "sessionId", "activeBucketId", "activeKey", "keyDerivation"], "session 记录");
  if (session.format !== "keymaster.session" || session.version !== 1) fail("session format/version 必须是 keymaster.session/1");
  if (typeof session.sessionId !== "string" || !SESSION_ID_PATTERN.test(session.sessionId)) fail("session.sessionId 必须是 32 位小写 hex");
  if (session.activeBucketId !== bucketId) fail("session.activeBucketId 必须等于当前桶 ID");
  if (session.activeKey !== ownerPublicKeyHex) fail("session.activeKey 必须等于首 Key 公钥");
  const sessionId = session.sessionId as string;

  // 3) KeyHold 文档:一 Key 一文件,文件名就是公钥。
  const keyHoldKey = `keymaster.bucket.${bucketId}.keys/${ownerPublicKeyHex}.keyhold`;
  const keyHoldEntry = entries.find((entry) => entry.key === keyHoldKey);
  if (!keyHoldEntry) fail(`缺少 KeyHold 文件 ${keyHoldKey}`);
  const keyFiles = entries.filter((entry) => entry.key.startsWith(`keymaster.bucket.${bucketId}.keys/`));
  if (keyFiles.length !== 1) fail(`keys/ 目录应只有 1 个 KeyHold 文件,实际 ${keyFiles.length}`);
  const keyHold = parseJson(decodeFileValue(keyHoldEntry.value, "KeyHold 文档"), "KeyHold 文档");
  expectExactKeys(keyHold, ["format", "version", "label", "publicKeyHex", "keyDerivation", "cipher"], "KeyHold 文档");
  if (keyHold.format !== "keyhold" || keyHold.version !== 1) fail("KeyHold format/version 必须是 keyhold/1");
  if (keyHold.label !== keyLabel) fail("KeyHold label 必须等于首 Key 标签");
  if (keyHold.publicKeyHex !== ownerPublicKeyHex) fail("KeyHold publicKeyHex 必须与文件名一致");
  const derivation = keyHold.keyDerivation as Record<string, unknown>;
  expectExactKeys(derivation, ["algorithm", "passwordEncoding", "iterations", "outputLengthBits", "saltB64Url"], "KeyHold keyDerivation");
  if (derivation.algorithm !== "pbkdf2-hmac-sha-256" || derivation.passwordEncoding !== "utf-8" || derivation.outputLengthBits !== 256) {
    fail("KeyHold keyDerivation 的算法/编码/长度不符合格式");
  }
  if (!Number.isSafeInteger(derivation.iterations) || (derivation.iterations as number) < 1 || (derivation.iterations as number) > 2_147_483_647) {
    fail("KeyHold keyDerivation.iterations 超出 1~2147483647");
  }
  if (base64UrlBytes(derivation.saltB64Url) !== 16) fail("KeyHold keyDerivation.saltB64Url 必须是 16 字节");
  const cipher = keyHold.cipher as Record<string, unknown>;
  expectExactKeys(cipher, ["algorithm", "keyLengthBits", "ivB64Url", "tagLengthBits", "ciphertextAndTagB64Url"], "KeyHold cipher");
  if (cipher.algorithm !== "aes-gcm" || cipher.keyLengthBits !== 256 || cipher.tagLengthBits !== 128) fail("KeyHold cipher 算法参数不符合格式");
  if (base64UrlBytes(cipher.ivB64Url) !== 12) fail("KeyHold cipher.ivB64Url 必须是 12 字节");
  const cipherBytes = base64UrlBytes(cipher.ciphertextAndTagB64Url);
  if (cipherBytes === undefined || cipherBytes < 16) fail("KeyHold cipher 密文（含 16 字节 tag）不合法");

  // 4) Key 应用锁:使用中的 Key 必须有未过期的锁,holder 就是 session。
  const lockKey = `keymaster.bucket.${bucketId}.${ownerPublicKeyHex}/lock.json`;
  const lockEntry = entries.find((entry) => entry.key === lockKey);
  let keyLock: Record<string, unknown> | undefined;
  if (lockEntry) {
    keyLock = parseJson(decodeFileValue(lockEntry.value, "Key 锁文件"), "Key 锁文件");
    expectExactKeys(keyLock, ["format", "version", "holder", "acquiredAt", "heartbeatAt", "expiresAt"], "Key 锁文件");
    if (keyLock.format !== "keymaster.key-lock" || keyLock.version !== 1) fail("Key 锁 format/version 必须是 keymaster.key-lock/1");
    if (keyLock.holder !== sessionId) fail("Key 锁 holder 必须等于 session.sessionId");
    assertNonNegativeInteger(keyLock.acquiredAt, "lock.acquiredAt");
    assertNonNegativeInteger(keyLock.heartbeatAt, "lock.heartbeatAt");
    assertNonNegativeInteger(keyLock.expiresAt, "lock.expiresAt");
    if ((keyLock.expiresAt as number) !== (keyLock.heartbeatAt as number) + 60_000) fail("Key 锁 expiresAt 必须等于 heartbeatAt + 60 秒");
    if ((keyLock.heartbeatAt as number) < (keyLock.acquiredAt as number)) fail("Key 锁 heartbeatAt 不能早于 acquiredAt");
  }

  // 5) 旧格式键必须彻底消失。
  for (const legacy of [
    "keymaster.device-bootstrap.v1",
    "keymaster.storage.catalog.v2",
    "keymaster.storage.catalog",
    "keymaster.storage.initial-setup.recovery.v1",
  ]) {
    if (entries.some((entry) => entry.key === legacy)) fail(`旧格式键仍然存在: ${legacy}`);
  }

  return { deviceRecord, session, sessionId, keyHold, ...(keyLock === undefined ? {} : { keyLock }) };
}

/** 用户主动锁定后,Key 应用锁必须被释放（文件删除）。 */
export async function assertLocalBucketLockReleased(
  page: Page,
  expectation: Pick<LocalBucketStorageExpectation, "bucketId" | "ownerPublicKeyHex">,
): Promise<void> {
  const entries = await readRawLocalStorage(page);
  const lockKey = `keymaster.bucket.${expectation.bucketId}.${expectation.ownerPublicKeyHex}/lock.json`;
  expect(entries.some((entry) => entry.key === lockKey), "锁定后 Key 应用锁必须被删除").toBe(false);
  // 锁定不改变私钥文件与设备记录,只释放锁。
  expect(entries.some((entry) => entry.key === `keymaster.bucket.${expectation.bucketId}.keys/${expectation.ownerPublicKeyHex}.keyhold`)).toBe(true);
  expect(entries.some((entry) => entry.key === `keymaster.device.${expectation.bucketId}`)).toBe(true);
}
