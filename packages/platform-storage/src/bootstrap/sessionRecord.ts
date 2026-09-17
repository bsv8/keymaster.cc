// 浏览器 session 仓储（keymaster.session）。
//
// 记录浏览器身份、active 桶 / active key 和启动密码的公开 KDF 参数。
// 宽容读取：坏记录按"新浏览器"处理；写入必须通过严格校验。

import type { KeymasterSessionKeyDerivationV1, KeymasterSessionV1 } from "@keymaster/contracts";
import {
  createKeymasterSession,
  KEYMASTER_SESSION_ID_PATTERN,
  KEYMASTER_SESSION_KEY,
  parseKeymasterSession,
  validateKeymasterSession,
} from "@keymaster/contracts";
import { defaultDeviceStorage, type DeviceLocalStorage } from "./deviceStorage.js";

/** 生成新的 sessionId；随机源不可用时直接失败。 */
export function generateSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 读取 session；不存在、损坏或格式不符都返回 undefined。 */
export function readSession(storage: DeviceLocalStorage = defaultDeviceStorage()): KeymasterSessionV1 | undefined {
  const raw = storage.getItem(KEYMASTER_SESSION_KEY);
  if (raw === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  return parseKeymasterSession(value);
}

/** 写入一份严格合法的 session。 */
export function writeSession(session: KeymasterSessionV1, storage: DeviceLocalStorage = defaultDeviceStorage()): void {
  const checked = validateKeymasterSession(session);
  storage.setItem(KEYMASTER_SESSION_KEY, JSON.stringify(checked));
}

/** 读取现有 sessionId；缺失或损坏时创建一个并写入。 */
export function ensureSessionId(storage: DeviceLocalStorage = defaultDeviceStorage()): string {
  const existing = readSession(storage);
  if (existing) return existing.sessionId;
  const session = createKeymasterSession(generateSessionId());
  storage.setItem(KEYMASTER_SESSION_KEY, JSON.stringify(session));
  return session.sessionId;
}

/** 以读-改-写方式更新 session；变更为空时不写回。 */
export function updateSession(
  patch: (current: KeymasterSessionV1) => KeymasterSessionV1,
  storage: DeviceLocalStorage = defaultDeviceStorage(),
): KeymasterSessionV1 {
  const current = readSession(storage);
  if (!current) throw new TypeError("Session record is unavailable");
  const next = validateKeymasterSession(patch(current));
  storage.setItem(KEYMASTER_SESSION_KEY, JSON.stringify(next));
  return next;
}

/** 选中 / 切换 active 桶；变化时同时清除 activeKey。 */
export function setActiveBucket(activeBucketId: string | undefined, storage: DeviceLocalStorage = defaultDeviceStorage()): KeymasterSessionV1 {
  return updateSession((current) => {
    if (activeBucketId === undefined) {
      const { activeBucketId: _bucket, activeKey: _key, ...rest } = current;
      return { ...rest };
    }
    if (current.activeBucketId === activeBucketId) return current;
    const { activeKey: _key, ...rest } = current;
    return { ...rest, activeBucketId };
  }, storage);
}

/** 记录 active key；必须已经有 active 桶。 */
export function setActiveKey(activeKey: string | undefined, storage: DeviceLocalStorage = defaultDeviceStorage()): KeymasterSessionV1 {
  return updateSession((current) => {
    if (activeKey === undefined) {
      const { activeKey: _key, ...rest } = current;
      return { ...rest };
    }
    if (current.activeBucketId === undefined) throw new TypeError("Session active bucket is required before selecting a key");
    return { ...current, activeKey };
  }, storage);
}

/** 写入或清除启动密码的公开 KDF 参数。 */
export function setSessionKeyDerivation(
  keyDerivation: KeymasterSessionKeyDerivationV1 | undefined,
  storage: DeviceLocalStorage = defaultDeviceStorage(),
): KeymasterSessionV1 {
  return updateSession((current) => {
    if (keyDerivation === undefined) {
      const { keyDerivation: _derivation, ...rest } = current;
      return { ...rest };
    }
    return { ...current, keyDerivation };
  }, storage);
}

/** 清除整条 session；用于显式"新浏览器"重置。 */
export function clearSession(storage: DeviceLocalStorage = defaultDeviceStorage()): void {
  storage.removeItem(KEYMASTER_SESSION_KEY);
}

/** 校验 sessionId；供上层对页面桥传入的值做快速检查。 */
export function isValidSessionId(value: unknown): value is string {
  return typeof value === "string" && KEYMASTER_SESSION_ID_PATTERN.test(value);
}
