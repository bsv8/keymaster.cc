import type { BorrowedKeyValueStore } from "@keymaster/contracts";

/**
 * 业务配置的 K-V 持久化适配器。
 *
 * 配置读取接口保持同步，便于现有服务在热路径使用；真正的首次读取由
 * `ready()` 完成，写入通过串行队列提交到已经绑定权限的 K-V 句柄。
 * 写入只有在远端成功后才更新内存，调用者必须 await 返回的 Promise。
 * 这里不接收 owner、App ID、Provider 或物理路径，边界由 Host 负责。
 */
export interface KeyValueSettingsStore<T> {
  /** 当前内存真值。 */
  load(): T;
  /** 等待持久化值完成一次加载。 */
  ready(): Promise<void>;
  /** 远端持久化成功后更新内存真值。 */
  save(value: T): Promise<void>;
  /** 远端删除成功后重置当前配置。 */
  clear(): Promise<void>;
}

export function createKeyValueSettingsStore<T>(input: {
  /** Host 已绑定的 bucket/owner K-V 句柄；生产装配不得缺失。 */
  storage: BorrowedKeyValueStore;
  /** 配置在 K-V 中的相对键。 */
  key: string;
  /** K-V 原子分区。 */
  partition: string;
  /** 默认值工厂，避免共享可变对象。 */
  defaults: () => T;
  /** 从未知 K-V 值解析并归一化。 */
  normalize: (value: unknown) => T;
}): KeyValueSettingsStore<T> {
  let current = input.defaults();
  let writeQueue = Promise.resolve();

  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const result = writeQueue.then(operation);
    // 后续写入不能被前一次失败永久毒死，但当前调用仍必须收到原始错误。
    writeQueue = result.then(() => undefined, () => undefined);
    return result;
  };

  return {
    load: () => current,
    async ready() {
      const entry = await input.storage.get<unknown>(input.key, { partition: input.partition });
      if (entry) current = input.normalize(entry.value);
    },
    save(value) {
      const persisted = input.normalize(value);
      return enqueue(async () => {
        await input.storage.put(input.key, persisted, { partition: input.partition });
        current = persisted;
      });
    },
    clear() {
      const reset = input.defaults();
      return enqueue(async () => {
        await input.storage.delete(input.key, { partition: input.partition });
        current = reset;
      });
    }
  };
}
