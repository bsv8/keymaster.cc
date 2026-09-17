// Key 应用锁契约（keymaster.key-lock）。
//
// 锁文件位于 `<owner 公钥>/lock.json`，同一把 Key 同一时间只允许一个浏览器
// 使用；不同 Key 的锁互不影响。原生文档见 KeymasterFormats《Key 应用锁》。

/** 锁文件名；锁路径固定为 `<owner 公钥>/lock.json`。 */
export const KEYMASTER_KEY_LOCK_FILE = "lock.json";
/** 固定格式标识。 */
export const KEYMASTER_KEY_LOCK_FORMAT = "keymaster.key-lock";
/** 固定格式版本。 */
export const KEYMASTER_KEY_LOCK_VERSION = 1;

/** 应用锁的时间参数。 */
export const KEYMASTER_KEY_LOCK_TIMING = Object.freeze({
  /** 锁租期：60 秒。 */
  ttlMs: 60_000,
  /** 自动续约间隔：45 秒。 */
  heartbeatIntervalMs: 45_000,
});

/** 桶内 Key 应用锁记录。 */
export interface KeymasterKeyLockV1 {
  /** 固定格式标识。 */
  format: "keymaster.key-lock";
  /** 固定格式版本。 */
  version: 1;
  /** 持有锁的浏览器 sessionId，32 位小写 hex。 */
  holder: string;
  /** 首次获取锁的时间戳（毫秒）。 */
  acquiredAt: number;
  /** 最近一次获取/续约的时间戳（毫秒）。 */
  heartbeatAt: number;
  /** 过期时间戳（毫秒），固定等于 heartbeatAt + 60 秒。 */
  expiresAt: number;
}

/** 校验 owner 公钥并返回锁文件路径。 */
export function keyLockPath(ownerPublicKeyHex: string): string {
  if (typeof ownerPublicKeyHex !== "string" || !/^(02|03)[0-9a-f]{64}$/u.test(ownerPublicKeyHex)) {
    throw new TypeError("Key lock owner publicKeyHex is invalid");
  }
  return `${ownerPublicKeyHex}/${KEYMASTER_KEY_LOCK_FILE}`;
}

/** 校验桶锁记录并返回脱离输入对象的副本。 */
export function validateKeymasterKeyLock(value: unknown): KeymasterKeyLockV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("key lock is invalid");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const allowed = ["acquiredAt", "expiresAt", "format", "heartbeatAt", "holder", "version"];
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) throw new TypeError("key lock fields are invalid");
  if (record.format !== KEYMASTER_KEY_LOCK_FORMAT || record.version !== KEYMASTER_KEY_LOCK_VERSION) throw new TypeError("key lock format is invalid");
  if (typeof record.holder !== "string" || !/^[0-9a-f]{32}$/u.test(record.holder)) throw new TypeError("key lock holder is invalid");
  const acquiredAt = record.acquiredAt;
  const heartbeatAt = record.heartbeatAt;
  const expiresAt = record.expiresAt;
  for (const [field, valueToCheck] of [["acquiredAt", acquiredAt], ["heartbeatAt", heartbeatAt], ["expiresAt", expiresAt]] as const) {
    if (typeof valueToCheck !== "number" || !Number.isSafeInteger(valueToCheck) || valueToCheck < 0) throw new TypeError(`key lock ${field} is invalid`);
  }
  const checkedAcquiredAt = acquiredAt as number;
  const checkedHeartbeatAt = heartbeatAt as number;
  const checkedExpiresAt = expiresAt as number;
  if (checkedHeartbeatAt < checkedAcquiredAt || checkedExpiresAt < checkedHeartbeatAt || checkedExpiresAt !== checkedHeartbeatAt + KEYMASTER_KEY_LOCK_TIMING.ttlMs) {
    throw new TypeError("key lock timestamps are invalid");
  }
  return {
    format: KEYMASTER_KEY_LOCK_FORMAT,
    version: KEYMASTER_KEY_LOCK_VERSION,
    holder: record.holder,
    acquiredAt: checkedAcquiredAt,
    heartbeatAt: checkedHeartbeatAt,
    expiresAt: checkedExpiresAt,
  };
}
