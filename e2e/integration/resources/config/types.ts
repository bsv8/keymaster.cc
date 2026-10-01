import type { SecretString } from "../../support/secretString.js";

/**
 * 真实 SatSubscription 页面需要填写的公开供应商配置。
 *
 * 这里只保留页面表单对应的三个字段；链 API 地址和授权令牌属于
 * Node 侧 testnet 资金准备，不应进入页面 Journey 的配置投影。
 */
export interface E2ESatSubscriptionPageConfig {
  /** WebSocket 入口的 libp2p multiaddr，不是可直接传给 new WebSocket 的 URL。 */
  readonly websocket: string;
  /** WebRTC Direct 入口的完整 libp2p multiaddr，不能为空。 */
  readonly webrtcDirect: string;
  /** 远端供应商身份公钥；页面会把它映射为 supplierPublicKeyHex。 */
  readonly supplierPublicKeyHex: string;
}

/** SatSubscription testnet 双入口配置；字段来源是仓库外 satsubscription.json。 */
export interface E2ESatSubscriptionConfig extends E2ESatSubscriptionPageConfig {
  /**
   * testnet 链查询/广播 API 的根地址；默认是 WhatsOnChain 的 BSV API。
   * 它不是 SatSubscription 的身份证明，只是 Node 侧资金 Resource 的链入口。
   */
  readonly testnetApiBaseUrl: string;
  /** 可选的链 API 授权令牌，只能在 Node Resource 内短期读取。 */
  readonly testnetApiAuthorization?: SecretString;
}

/** Node 侧 testnet 资金种子；浏览器和 Playwright fixture 不接收这个字段。 */
export interface E2ETestnetSeed {
  /** 只允许 testnet 资金管理器显式 read() 一次性使用。 */
  readonly privateKeyHex: SecretString;
  /**
   * 固定的可追踪测试 Key（仓库外 key01.hex）。
   *
   * 它由页面正式导入入口成为 active Key，seed 打款和页面回款都落在同一
   * 地址上，便于跨轮追踪和失败回收；私钥仍只在 Node Resource 与页面 Vault
   * 内短期存在，不进入报告。
   */
  readonly trackingKeyPrivateKeyHex: SecretString;
}

/** loader 的完整结果；不含原始 JSON，不提供 toJSON 展开路径。 */
export interface LoadedE2EConfig {
  readonly directory: string;
  readonly satsubscription: E2ESatSubscriptionConfig;
  readonly testnet: E2ETestnetSeed;
}

export interface E2ETestnetKeysConfig {
  readonly directory: string;
  readonly seedPrivateKeyHex: SecretString;
  readonly key01PrivateKeyHex: SecretString;
  readonly key02PrivateKeyHex: SecretString;
}

export type LoadedE2ETestnetKeysConfig = E2ETestnetKeysConfig;

/** 只运行真实 SatSubscription 页面 Journey 时读取的公开配置投影。 */
export interface LoadedE2ESatSubscriptionConfig {
  readonly directory: string;
  readonly satsubscription: E2ESatSubscriptionPageConfig;
}
