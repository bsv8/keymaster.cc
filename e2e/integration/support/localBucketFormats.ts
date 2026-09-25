// 按 KeymasterFormats 校验 Local 桶在浏览器里的实际存储文件。
//
// Local 桶的物理介质是 IndexedDB（库 `keymaster.local`、对象仓库
// `objects`，键为 `[bucketId, path]`）；设备引导记录仍在 localStorage：
//   - `keymaster.device.<ID>` 设备桶记录(keymaster.device.v1)
//   - `keymaster.session`      浏览器 session(keymaster.session.v1)
//   - IndexedDB `keys/<公钥>.keyhold`  KeyHold 文档
//   - IndexedDB `<公钥>/lock.json`     Key 应用锁
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

/** IndexedDB 里的桶对象：路径 + UTF-8 文本（KeyHold/锁文件都是 JSON）。 */
export interface RawBucketObjectEntry {
  readonly bucketId: string;
  readonly path: string;
  readonly text: string;
}

export const PUBLIC_KEY_PATTERN = /^(02|03)[0-9a-f]{64}$/u;
const SESSION_ID_PATTERN = /^[0-9a-f]{32}$/u;

function fail(message: string): never {
  throw new Error(message);
}

export function parseJson(raw: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail(`${label} 必须是 JSON 对象`);
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    fail(`${label} 不是合法 JSON`);
  }
}

export function expectExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) fail(`${label} 含未定义字段: ${extra.join(", ")}`);
}

/** base64url 解码后的字节数;非法返回 undefined。 */
export function base64UrlBytes(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/") + "===".slice((value.length + 3) % 4);
  try {
    return Buffer.from(padded, "base64").byteLength;
  } catch {
    return undefined;
  }
}

export function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
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
 * 读取 IndexedDB `keymaster.local/objects` 里的全部 Local 桶对象。
 *
 * 这是 Local 桶的正式物理真值；设备记录与 session 不在这里。对象值按
 * UTF-8 文本返回，KeyHold 与锁文件都是 JSON，调用方只校验公开结构。
 */
export async function readRawLocalBucketObjects(page: Page, pathPattern?: string): Promise<RawBucketObjectEntry[]> {
  return page.evaluate((pattern) => new Promise<Array<{ bucketId: string; path: string; text: string }>>((resolve, reject) => {
    const pathFilter = pattern ? new RegExp(pattern, "u") : undefined;
    const request = indexedDB.open("keymaster.local", 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("objects")) database.createObjectStore("objects");
    };
    request.onerror = () => reject(new Error("无法打开 IndexedDB keymaster.local"));
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("objects")) {
        database.close();
        resolve([]);
        return;
      }
      const transaction = database.transaction("objects", "readonly");
      const cursor = transaction.objectStore("objects").openCursor();
      const entries: Array<{ bucketId: string; path: string; text: string }> = [];
      cursor.onerror = () => { database.close(); reject(new Error("读取 IndexedDB 桶对象失败")); };
      cursor.onsuccess = () => {
        const position = cursor.result;
        if (!position) {
          database.close();
          resolve(entries);
          return;
        }
        const [bucketId, path] = position.key as [string, string];
        if (pathFilter && !pathFilter.test(path)) {
          position.continue();
          return;
        }
        const record = position.value as { bytes?: Uint8Array };
        entries.push({ bucketId, path, text: new TextDecoder("utf-8", { fatal: false }).decode(record.bytes ?? new Uint8Array()) });
        position.continue();
      };
    };
  }), pathPattern);
}

/** 删除 Local 桶里的单个对象；只用于验证"raw 缺失"这类失败展示。 */
export async function deleteRawLocalBucketObject(page: Page, bucketId: string, path: string): Promise<void> {
  await page.evaluate(({ bucketId: targetBucketId, path: targetPath }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("keymaster.local", 1);
    request.onerror = () => reject(new Error("无法打开 IndexedDB keymaster.local"));
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("objects")) {
        database.close();
        resolve();
        return;
      }
      const transaction = database.transaction("objects", "readwrite");
      transaction.onerror = () => { database.close(); reject(new Error("删除 IndexedDB 桶对象失败")); };
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.objectStore("objects").delete([targetBucketId, targetPath]);
    };
  }), { bucketId, path });
}

/** 按 KeyHold v1 校验一份 KeyHold 文档；字段/密文封装不符直接失败。 */
export function assertKeyHoldDocument(value: Record<string, unknown>, expectation: { publicKeyHex: string; label: string }): Record<string, unknown> {
  expectExactKeys(value, ["format", "version", "label", "publicKeyHex", "keyDerivation", "cipher"], "KeyHold 文档");
  if (value.format !== "keyhold" || value.version !== 1) fail("KeyHold format/version 必须是 keyhold/1");
  if (value.label !== expectation.label) fail("KeyHold label 必须等于 Key 标签");
  if (value.publicKeyHex !== expectation.publicKeyHex) fail("KeyHold publicKeyHex 必须与文件名一致");
  const derivation = value.keyDerivation as Record<string, unknown>;
  expectExactKeys(derivation, ["algorithm", "passwordEncoding", "iterations", "outputLengthBits", "saltB64Url"], "KeyHold keyDerivation");
  if (derivation.algorithm !== "pbkdf2-hmac-sha-256" || derivation.passwordEncoding !== "utf-8" || derivation.outputLengthBits !== 256) {
    fail("KeyHold keyDerivation 的算法/编码/长度不符合格式");
  }
  if (!Number.isSafeInteger(derivation.iterations) || (derivation.iterations as number) < 1 || (derivation.iterations as number) > 2_147_483_647) {
    fail("KeyHold keyDerivation.iterations 超出 1~2147483647");
  }
  if (base64UrlBytes(derivation.saltB64Url) !== 16) fail("KeyHold keyDerivation.saltB64Url 必须是 16 字节");
  const cipher = value.cipher as Record<string, unknown>;
  expectExactKeys(cipher, ["algorithm", "keyLengthBits", "ivB64Url", "tagLengthBits", "ciphertextAndTagB64Url"], "KeyHold cipher");
  if (cipher.algorithm !== "aes-gcm" || cipher.keyLengthBits !== 256 || cipher.tagLengthBits !== 128) fail("KeyHold cipher 算法参数不符合格式");
  if (base64UrlBytes(cipher.ivB64Url) !== 12) fail("KeyHold cipher.ivB64Url 必须是 12 字节");
  const cipherBytes = base64UrlBytes(cipher.ciphertextAndTagB64Url);
  if (cipherBytes === undefined || cipherBytes < 16) fail("KeyHold cipher 密文（含 16 字节 tag）不合法");
  return value;
}

/** 按 keymaster.key-lock v1 校验 Key 应用锁文件。 */
export function assertKeyLockDocument(value: Record<string, unknown>, expectation: { sessionId: string }): Record<string, unknown> {
  expectExactKeys(value, ["format", "version", "holder", "acquiredAt", "heartbeatAt", "expiresAt"], "Key 锁文件");
  if (value.format !== "keymaster.key-lock" || value.version !== 1) fail("Key 锁 format/version 必须是 keymaster.key-lock/1");
  if (value.holder !== expectation.sessionId) fail("Key 锁 holder 必须等于 session.sessionId");
  assertNonNegativeInteger(value.acquiredAt, "lock.acquiredAt");
  assertNonNegativeInteger(value.heartbeatAt, "lock.heartbeatAt");
  assertNonNegativeInteger(value.expiresAt, "lock.expiresAt");
  if ((value.expiresAt as number) !== (value.heartbeatAt as number) + 60_000) fail("Key 锁 expiresAt 必须等于 heartbeatAt + 60 秒");
  if ((value.heartbeatAt as number) < (value.acquiredAt as number)) fail("Key 锁 heartbeatAt 不能早于 acquiredAt");
  return value;
}

/**
 * 身份相关文件的键值映射：设备记录、session（localStorage）与 KeyHold
 * 文件（IndexedDB）。
 *
 * 锁文件的时间戳、schema/盐等运行态文件会随心跳和装配变化，不在这里比较；
 * 这个映射用于判断一次失败操作是否改动了身份真值。
 */
export function identityFileMap(
  entries: readonly RawEntry[],
  bucketObjects: readonly RawBucketObjectEntry[] = [],
): Record<string, string> {
  return Object.fromEntries([
    ...entries
      .filter((entry) => entry.key.startsWith("keymaster.device.") || entry.key === "keymaster.session")
      .map((entry) => [entry.key, entry.value] as const),
    ...bucketObjects
      .filter((entry) => entry.path.includes("/keys/"))
      .map((entry) => [`keymaster.bucket.${entry.bucketId}.${entry.path}`, entry.text] as const),
  ]);
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

  // 3) KeyHold 文档:一 Key 一文件,文件名就是公钥;物理真值是 IndexedDB。
  const bucketObjects = await readRawLocalBucketObjects(page);
  const bucketEntries = bucketObjects.filter((entry) => entry.bucketId === bucketId);
  const keyHoldPath = `keys/${ownerPublicKeyHex}.keyhold`;
  const keyHoldEntry = bucketEntries.find((entry) => entry.path === keyHoldPath);
  if (!keyHoldEntry) fail(`缺少 KeyHold 文件 ${keyHoldPath}`);
  const keyFiles = bucketEntries.filter((entry) => entry.path.startsWith("keys/"));
  if (keyFiles.length !== 1) fail(`keys/ 目录应只有 1 个 KeyHold 文件,实际 ${keyFiles.length}`);
  const keyHold = assertKeyHoldDocument(parseJson(keyHoldEntry.text, "KeyHold 文档"), {
    publicKeyHex: ownerPublicKeyHex,
    label: keyLabel,
  });

  // 4) Key 应用锁:使用中的 Key 必须有未过期的锁,holder 就是 session。
  const lockPath = `${ownerPublicKeyHex}/lock.json`;
  const lockEntry = bucketEntries.find((entry) => entry.path === lockPath);
  let keyLock: Record<string, unknown> | undefined;
  if (lockEntry) {
    keyLock = assertKeyLockDocument(parseJson(lockEntry.text, "Key 锁文件"), { sessionId });
  }

  // 5) 旧格式键必须彻底消失,Local 桶对象也不能再写回 localStorage。
  for (const legacy of [
    "keymaster.device-bootstrap.v1",
    "keymaster.storage.catalog.v2",
    "keymaster.storage.catalog",
    "keymaster.storage.initial-setup.recovery.v1",
  ]) {
    if (entries.some((entry) => entry.key === legacy)) fail(`旧格式键仍然存在: ${legacy}`);
  }
  const localStorageBucketKeys = entries.filter((entry) => entry.key.startsWith("keymaster.bucket."));
  if (localStorageBucketKeys.length > 0) {
    fail(`Local 桶对象不得再写入 localStorage: ${localStorageBucketKeys.map((entry) => entry.key).join(", ")}`);
  }

  return { deviceRecord, session, sessionId, keyHold, ...(keyLock === undefined ? {} : { keyLock }) };
}

/** 用户主动锁定后,Key 应用锁必须被释放（IndexedDB 文件删除）。 */
export async function assertLocalBucketLockReleased(
  page: Page,
  expectation: Pick<LocalBucketStorageExpectation, "bucketId" | "ownerPublicKeyHex">,
): Promise<void> {
  const entries = await readRawLocalStorage(page);
  const bucketEntries = (await readRawLocalBucketObjects(page)).filter((entry) => entry.bucketId === expectation.bucketId);
  const lockPath = `${expectation.ownerPublicKeyHex}/lock.json`;
  expect(bucketEntries.some((entry) => entry.path === lockPath), "锁定后 Key 应用锁必须被删除").toBe(false);
  // 锁定不改变私钥文件与设备记录,只释放锁。
  expect(bucketEntries.some((entry) => entry.path === `keys/${expectation.ownerPublicKeyHex}.keyhold`)).toBe(true);
  expect(entries.some((entry) => entry.key === `keymaster.device.${expectation.bucketId}`)).toBe(true);
}
