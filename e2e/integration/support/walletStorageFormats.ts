// 按 KeymasterFormats 校验本地钱包在浏览器里的实际存储文件。
//
// 物理介质只有 IndexedDB（库 `keymaster.wallet`、对象仓库 `objects`，主键就是
// 相对 path 本身）；钱包只有一把 Key，固定两个平台保留路径：
//   - `key.json`           唯一的 KeyHold 文档
//   - `.keymaster/meta`    钱包元数据与 walletGeneration
//
// 没有桶目录、没有 owner 公钥前缀、没有 Key 列表，localStorage 也不承载任何
// 钱包数据。这里不读私钥明文；只验证公开结构和密文封装形状。

import { expect, type Page } from "@playwright/test";

/** IndexedDB 数据库名；与生产实现 `WALLET_DATABASE_NAME` 一致。 */
export const WALLET_DATABASE_NAME = "keymaster.wallet";
/** IndexedDB 对象仓库名；与生产实现 `WALLET_OBJECT_STORE` 一致。 */
export const WALLET_OBJECT_STORE = "objects";
/** 固定 schema 版本；与生产实现 `WALLET_SCHEMA_VERSION` 一致。 */
export const WALLET_SCHEMA_VERSION = 1;
/** 唯一的 KeyHold 路径。 */
export const WALLET_KEYHOLD_PATH = "key.json";
/** 钱包元数据路径。 */
export const WALLET_META_PATH = ".keymaster/meta";

export interface WalletStorageExpectation {
  readonly ownerPublicKeyHex: string;
  readonly keyLabel: string;
}

export interface WalletStorageSnapshot {
  readonly meta: Record<string, unknown>;
  readonly walletGeneration: string;
  readonly keyHold: Record<string, unknown>;
}

export interface RawEntry {
  readonly key: string;
  readonly value: string;
}

/** IndexedDB 钱包对象：路径 + UTF-8 文本（KeyHold 与 meta 都是 JSON）。 */
export interface RawWalletObjectEntry {
  readonly path: string;
  readonly text: string;
}

export const PUBLIC_KEY_PATTERN = /^(02|03)[0-9a-f]{64}$/u;

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
 * 读取 IndexedDB `keymaster.wallet/objects` 里的全部钱包对象。
 *
 * 这是本地钱包的正式物理真值。主键就是 path 本身，因此没有桶或 owner
 * 分组；对象值按 UTF-8 文本返回，调用方只校验公开结构。
 */
export async function readRawWalletObjects(page: Page, pathPattern?: string): Promise<RawWalletObjectEntry[]> {
  return page.evaluate(({ databaseName, storeName, schemaVersion, pattern }) => new Promise<Array<{ path: string; text: string }>>((resolve, reject) => {
    const pathFilter = pattern ? new RegExp(pattern, "u") : undefined;
    const request = indexedDB.open(databaseName, schemaVersion);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(storeName)) database.createObjectStore(storeName);
    };
    request.onerror = () => reject(new Error("无法打开 IndexedDB keymaster.wallet"));
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(storeName)) {
        database.close();
        resolve([]);
        return;
      }
      const transaction = database.transaction(storeName, "readonly");
      const cursor = transaction.objectStore(storeName).openCursor();
      const entries: Array<{ path: string; text: string }> = [];
      cursor.onerror = () => { database.close(); reject(new Error("读取 IndexedDB 钱包对象失败")); };
      cursor.onsuccess = () => {
        const position = cursor.result;
        if (!position) {
          database.close();
          resolve(entries);
          return;
        }
        const objectPath = position.key as string;
        if (pathFilter && !pathFilter.test(objectPath)) {
          position.continue();
          return;
        }
        const record = position.value as { bytes?: Uint8Array };
        entries.push({ path: objectPath, text: new TextDecoder("utf-8", { fatal: false }).decode(record.bytes ?? new Uint8Array()) });
        position.continue();
      };
    };
  }), { databaseName: WALLET_DATABASE_NAME, storeName: WALLET_OBJECT_STORE, schemaVersion: WALLET_SCHEMA_VERSION, pattern: pathPattern ?? null });
}

/** 删除钱包里的单个对象；只用于验证"raw 缺失"这类失败展示。 */
export async function deleteRawWalletObject(page: Page, path: string): Promise<void> {
  await page.evaluate(({ databaseName, storeName, schemaVersion, targetPath }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(databaseName, schemaVersion);
    request.onerror = () => reject(new Error("无法打开 IndexedDB keymaster.wallet"));
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(storeName)) {
        database.close();
        resolve();
        return;
      }
      const transaction = database.transaction(storeName, "readwrite");
      transaction.onerror = () => { database.close(); reject(new Error("删除 IndexedDB 钱包对象失败")); };
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.objectStore(storeName).delete(targetPath);
    };
  }), { databaseName: WALLET_DATABASE_NAME, storeName: WALLET_OBJECT_STORE, schemaVersion: WALLET_SCHEMA_VERSION, targetPath: path });
}

/** 按 KeyHold v1 校验唯一的 KeyHold 文档；字段/密文封装不符直接失败。 */
export function assertKeyHoldDocument(value: Record<string, unknown>, expectation: WalletStorageExpectation): Record<string, unknown> {
  expectExactKeys(value, ["format", "version", "label", "publicKeyHex", "keyDerivation", "cipher"], "KeyHold 文档");
  if (value.format !== "keyhold" || value.version !== 1) fail("KeyHold format/version 必须是 keyhold/1");
  if (value.label !== expectation.keyLabel) fail("KeyHold label 必须等于 Key 标签");
  if (value.publicKeyHex !== expectation.ownerPublicKeyHex) fail("KeyHold publicKeyHex 必须等于唯一钱包 Key 的公钥");
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
  // 32 字节 secp256k1 私钥 + 16 字节 GCM 标签。
  if (base64UrlBytes(cipher.ciphertextAndTagB64Url) !== 48) fail("KeyHold cipher 密文（含 16 字节 tag）必须是 48 字节");
  return value;
}

/**
 * 身份真值映射：唯一的 KeyHold 与钱包元数据。
 *
 * meta 里的 walletGeneration 会随重置变化，因此只比较 KeyHold；这个映射用于
 * 判断一次失败操作是否改动了钱包身份。
 */
export function identityFileMap(
  entries: readonly RawEntry[],
  walletObjects: readonly RawWalletObjectEntry[] = [],
): Record<string, string> {
  return Object.fromEntries([
    ...walletObjects
      .filter((entry) => entry.path === WALLET_KEYHOLD_PATH)
      .map((entry) => [WALLET_KEYHOLD_PATH, entry.text] as const),
    ...entries.map((entry) => [entry.key, entry.value] as const),
  ]);
}

/**
 * 读取并校验本地钱包的全部存储文件。
 *
 * 缺少固定路径、字段多余、格式/版本不符、密文封装形状不对，以及任何旧
 * 桶目录键或第二把 KeyHold 残留，都会直接失败。
 */
export async function assertWalletStorage(
  page: Page,
  expectation: WalletStorageExpectation,
): Promise<WalletStorageSnapshot> {
  const entries = await readRawLocalStorage(page);
  const walletObjects = await readRawWalletObjects(page);

  // 1) 钱包元数据：initialized 与 walletGeneration 是会话与存储作用域的真值。
  const metaEntry = walletObjects.find((entry) => entry.path === WALLET_META_PATH);
  if (!metaEntry) fail(`缺少钱包元数据 ${WALLET_META_PATH}`);
  const meta = parseJson(metaEntry.text, "钱包元数据");
  expectExactKeys(meta, ["format", "version", "schemaVersion", "initialized", "walletGeneration", "createdAt"], "钱包元数据");
  if (meta.format !== "keymaster.wallet-meta" || meta.version !== 1) fail("钱包元数据 format/version 必须是 keymaster.wallet-meta/1");
  if (meta.initialized !== true) fail("初始化完成后 wallet meta.initialized 必须为 true");
  if (!Number.isSafeInteger(meta.schemaVersion) || (meta.schemaVersion as number) < 1) fail("钱包元数据 schemaVersion 必须是正整数");
  const walletGeneration = meta.walletGeneration;
  if (typeof walletGeneration !== "string" || !/^[0-9a-f-]{36}$/iu.test(walletGeneration)) fail("钱包元数据 walletGeneration 必须是 UUID 形态");
  if (typeof meta.createdAt !== "string" || Number.isNaN(Date.parse(meta.createdAt))) fail("钱包元数据 createdAt 必须是 ISO-8601 时间");

  // 2) 唯一的 KeyHold：固定路径 `key.json`，没有 Key 列表也没有文件名公钥。
  const keyHoldEntry = walletObjects.find((entry) => entry.path === WALLET_KEYHOLD_PATH);
  if (!keyHoldEntry) fail(`缺少唯一 KeyHold 文件 ${WALLET_KEYHOLD_PATH}`);
  const keyHold = assertKeyHoldDocument(parseJson(keyHoldEntry.text, "KeyHold 文档"), expectation);
  const keyHoldCopies = walletObjects.filter((entry) => entry.path.endsWith(".keyhold") || /^keys\//u.test(entry.path));
  if (keyHoldCopies.length > 0) fail(`不得存在第二把 Key 的 KeyHold 文件: ${keyHoldCopies.map((entry) => entry.path).join(", ")}`);

  // 3) 旧模型残留：桶目录、Key 目录、应用锁与冷启动恢复指针都必须消失。
  for (const legacyPath of ["keys/", "lock.json"]) {
    if (walletObjects.some((entry) => entry.path.includes(legacyPath))) fail(`旧多 Key 路径仍然存在: ${legacyPath}`);
  }
  for (const legacy of [
    "keymaster.device-bootstrap.v1",
    "keymaster.storage.catalog.v2",
    "keymaster.storage.catalog",
    "keymaster.storage.initial-setup.recovery.v1",
  ]) {
    if (entries.some((entry) => entry.key === legacy)) fail(`旧格式键仍然存在: ${legacy}`);
  }
  const bucketKeys = entries.filter((entry) => entry.key.startsWith("keymaster.bucket.") || entry.key.startsWith("keymaster.device.") || entry.key === "keymaster.session");
  if (bucketKeys.length > 0) {
    fail(`localStorage 不得再保存桶目录或 session 指针: ${bucketKeys.map((entry) => entry.key).join(", ")}`);
  }

  return { meta, walletGeneration, keyHold };
}
