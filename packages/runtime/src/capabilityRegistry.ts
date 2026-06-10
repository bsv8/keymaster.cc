// packages/runtime/src/capabilityRegistry.ts
// 能力注册表：所有 plugin 服务都通过 capability 提供和消费。
// 关键不变量：
//  - provide 重复必须抛错（防止后注册覆盖先注册）。
//  - require 缺失必须抛错（让插件依赖问题在启动时暴露）。
// 设计缘由：把"插件间互相不知道"这件事落到机制上。

export interface CapabilityRegistry {
  provide<T>(key: string, value: T): void;
  get<T>(key: string): T;
  has(key: string): boolean;
  require(key: string): void;
  /** 仅用于调试。 */
  keys(): string[];
}

export function createCapabilityRegistry(): CapabilityRegistry {
  const map = new Map<string, unknown>();

  return {
    provide(key, value) {
      if (map.has(key)) {
        throw new Error(`Capability "${key}" is already provided`);
      }
      map.set(key, value);
    },
    get(key) {
      if (!map.has(key)) {
        throw new Error(`Capability "${key}" is not available`);
      }
      return map.get(key) as never;
    },
    has(key) {
      return map.has(key);
    },
    require(key) {
      if (!map.has(key)) {
        throw new Error(`Required capability "${key}" is missing`);
      }
    },
    keys() {
      return [...map.keys()];
    }
  };
}
