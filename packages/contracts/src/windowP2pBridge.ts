// Window P2P executor 的中性 bridge 契约。
//
// 这里不能依赖 MSFile 或 SatSubscription。业务插件只把自己的 lane
// operation 交给这个 bridge；具体业务校验和结果转换留在业务插件内。

/** 公共 executor 只接受 lane 操作，不接受 MSFile/Sat 顶层方法。 */
export interface WindowP2pExecutorOperation {
  type: "lane";
  /** lane 编号，例如 msfile 或 sat-subscription。 */
  laneId: string;
  /** 由对应 lane 自己校验的受限操作。 */
  operation: unknown;
}

/** Worker 下发给 Window 的集中资源配置；业务插件可扩展数值字段。 */
export interface WindowP2pExecutorConcurrencyConfig {
  /** 配置版本；旧版本配置不得覆盖新配置。 */
  version: number;
  /** 单个 Supplier 的读取 pending 上限。 */
  supplierPendingReadLimit: number;
  /** bridge 在途 attachment 的总字节预算。 */
  bridgeMaxInFlightBytes: number;
  /** bridge 在途 request/response/event 的总 item 预算。 */
  bridgeMaxPendingItems: number;
  [key: string]: number;
}

/** 校验跨 Window 边界收到的中性资源配置，不解释业务字段。 */
export function validateWindowP2pExecutorConcurrencyConfig(value: unknown): WindowP2pExecutorConcurrencyConfig {
  if (!value || typeof value !== "object") throw new Error("Window P2P concurrency config is invalid");
  const config = value as Partial<WindowP2pExecutorConcurrencyConfig>;
  const version = config.version;
  const supplierPendingReadLimit = config.supplierPendingReadLimit;
  const bridgeMaxInFlightBytes = config.bridgeMaxInFlightBytes;
  const bridgeMaxPendingItems = config.bridgeMaxPendingItems;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0
    || typeof supplierPendingReadLimit !== "number" || !Number.isSafeInteger(supplierPendingReadLimit) || supplierPendingReadLimit < 1
    || typeof bridgeMaxInFlightBytes !== "number" || !Number.isSafeInteger(bridgeMaxInFlightBytes) || bridgeMaxInFlightBytes < 1
    || typeof bridgeMaxPendingItems !== "number" || !Number.isSafeInteger(bridgeMaxPendingItems) || bridgeMaxPendingItems < 1) {
    throw new Error("Window P2P concurrency config has invalid limits");
  }
  return config as WindowP2pExecutorConcurrencyConfig;
}

/** Coordinator Worker 侧的 Window executor bridge。 */
export interface WindowP2pExecutorBridge {
  /** 当前 Window executor 是否已取得 lease 且 Host 已 ready。 */
  readonly available: boolean;
  /** 执行一个受限 lane operation。 */
  request(operation: WindowP2pExecutorOperation, signal?: AbortSignal): Promise<unknown>;
  /** 释放 bridge 侧资源；实现必须幂等。 */
  dispose?(): void;
}
