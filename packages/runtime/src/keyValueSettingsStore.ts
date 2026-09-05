import type { KeyValueStore } from "@keymaster/contracts";

/**
 * 业务配置的 K-V 持久化适配器。
 *
 * 配置读取接口保持同步，便于现有服务在热路径使用；真正的首次读取由
 * `ready()` 完成，写入通过串行队列提交到已经绑定权限的 K-V 句柄。
 * 这里不接收 owner、App ID、Provider 或物理路径，边界由 Host 负责。
 */
export interface KeyValueSettingsStore<T> {
  /** 当前内存真值。 */
  load(): T;
  /** 等待持久化值完成一次加载。 */
  ready(): Promise<void>;
  /** 更新内存真值并排队持久化。 */
  save(value: T): void;
  /** 删除当前配置并排队持久化删除。 */
  clear(): void;
}

export function createKeyValueSettingsStore<T>(input: {
  /** Host 已绑定的 owner/App K-V 句柄；缺失时只允许内存态。 */
  storage?: KeyValueStore;
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

  const enqueue = (operation: () => Promise<void>): void => {
    writeQueue = writeQueue.then(operation).catch(() => {
      // K-V 错误由业务请求或全局 Storage 状态上报；配置写队列不能产生
      // 未处理 Promise，同时不能把失败值伪装成已持久化值。
    });
  };

  return {
    load: () => current,
    async ready() {
      if (!input.storage) return;
      const entry = await input.storage.get<unknown>(input.key, { partition: input.partition });
      if (entry) current = input.normalize(entry.value);
    },
    save(value) {
      current = input.normalize(value);
      if (!input.storage) return;
      const persisted = current;
      enqueue(async () => {
        await input.storage!.put(input.key, persisted, { partition: input.partition });
      });
    },
    clear() {
      current = input.defaults();
      if (!input.storage) return;
      enqueue(() => input.storage!.delete(input.key, { partition: input.partition }));
    }
  };
}
