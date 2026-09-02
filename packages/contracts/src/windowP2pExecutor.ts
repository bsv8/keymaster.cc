// Window P2P executor 的中性 capability 契约。
//
// P2P 网络基础插件拥有唯一的 Window libp2p Host 和 executor lease；MSFile、
// SatSubscription 等插件只能注册 lane，不能各自创建 Host。host 使用 unknown 是有意的：contracts
// 不依赖 libp2p，具体 lane 在自己的插件边界内把它收窄为正式 SDK 类型。

/** 唯一的 Window P2P executor capability。 */
export const WINDOW_P2P_EXECUTOR_CAPABILITY = "window-p2p.executor";

/** Window/Worker bridge 允许跨边界传递的错误领域。 */
export type WindowP2pExecutorErrorDomain = "window-p2p" | "sat-transport" | "msfile-transport";

/**
 * Window executor 的可序列化错误契约。
 * `message` 只用于诊断，业务控制流必须使用 `domain/code`。
 */
export interface WindowP2pExecutorError {
  /** 稳定错误所属领域。 */
  domain: WindowP2pExecutorErrorDomain;
  /** 稳定错误分类，不能依赖英文 message。 */
  code: string;
  /** 面向日志和界面的诊断文本。 */
  message: string;
  /** 是否能证明 Wire 尚未进入底层发送边界。 */
  sentBoundary?: "not-sent" | "unknown";
}

export interface WindowP2pExecutorLaneContext {
  /** 唯一 lease 对应的 libp2p Host；只存在于 Window。 */
  host: unknown;
  /**
   * lane 向 Coordinator 报告入站事件；事件不得携带私钥。
   * 返回 Promise 表示跨 Window bridge 已完成本次入站额度预占和 postMessage；
   * transfer 只用于传递可转移的非敏感二进制对象。
   */
  emit(event: unknown, transfer?: Transferable[]): Promise<void> | void;
  /**
   * Worker 完成、拒绝、超时或 lease revoke 后释放对应的入站 bridge 额度。
   * 实现必须幂等，未知 eventId 直接忽略。
   */
  releaseEvent?(eventId: string): void;
  /** 当前 owner/session epoch；lane 必须把它写入连接和事件 fence。 */
  ownerSessionEpoch?: string;
}

export interface WindowP2pExecutorLane {
  /** 稳定 lane 编号，用于 bridge RPC 路由。 */
  readonly laneId: string;
  /** Host ready 后启动 lane；可重复调用但必须幂等。 */
  start(context: WindowP2pExecutorLaneContext): Promise<void> | void;
  /** Host stop 或 lease revoke 时释放 lane 资源；必须幂等。 */
  stop(): Promise<void> | void;
  /** 在唯一 Host 上执行一项受限操作。 */
  handle(operation: unknown, signal: AbortSignal): Promise<unknown>;
  /** Worker 直接拒绝一个尚未完成的入站事件；用于资源/身份错误快速 fail closed。 */
  rejectEvent?(event: unknown, error: WindowP2pExecutorError): Promise<void> | void;
  /** 接收 Worker 下发的集中资源配置；实现可选择不使用。 */
  configure?(config: unknown): void;
}

export interface WindowP2pExecutorLaneRegistry {
  /** 注册 lane；返回注销函数。 */
  register(lane: WindowP2pExecutorLane): () => void;
  /** executor host ready 时挂载所有已注册 lane。 */
  attach(context: WindowP2pExecutorLaneContext): Promise<void>;
  /** executor stop 时卸载所有 lane。 */
  detach(): Promise<void>;
  /** Worker bridge 请求 lane 执行受限操作。 */
  dispatch(laneId: string, operation: unknown, signal: AbortSignal): Promise<unknown>;
  /** Worker bridge 拒绝一个入站事件，不经过业务 operation 队列。 */
  rejectEvent?(laneId: string, event: unknown, error: WindowP2pExecutorError): Promise<void> | void;
  /** 更新所有 lane 的集中资源配置。 */
  configure?(config: unknown): void;
}
