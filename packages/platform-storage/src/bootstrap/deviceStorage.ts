// 设备本地存储句柄。
//
// `keymaster.device.<ID>` 记录和 `keymaster.session` 必须放在同一介质里；
// 两者一起被清除时密文不会变成孤儿。本模块是唯一解析 `localStorage` 的
// 设备层入口（桶数据仍走 Provider）。

/** 只暴露设备记录需要的浏览器存储 API。 */
export interface DeviceLocalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  length: number;
  key(index: number): string | null;
}

/** 返回全局 localStorage；不可用时抛错。 */
export function defaultDeviceStorage(): DeviceLocalStorage {
  const storage = (globalThis as typeof globalThis & { localStorage?: DeviceLocalStorage }).localStorage;
  if (!storage) throw new TypeError("Device local storage is unavailable");
  return storage;
}

/** 列出当前存储里所有键；顺序不保证。 */
export function listStorageKeys(storage: DeviceLocalStorage): string[] {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null) keys.push(key);
  }
  return keys;
}
