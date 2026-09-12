import type { SecretString } from "../../support/secretString.js";

/** E2E 专用 S3 配置；SecretString 内部值不能被普通 JSON 序列化展开。 */
export interface E2ES3Config {
  /** 必须明确这是 keymaster.cc 的专用测试桶。 */
  readonly purpose: "keymaster-e2e";
  /** 允许桶级清理的人工授权开关。缺失或 false 时绝不删除。 */
  readonly allowBucketWideCleanup: true;
  /** S3-compatible 服务的 HTTPS 端点。 */
  readonly endpoint: string;
  /** S3 签名区域。 */
  readonly region: string;
  /** 物理桶名称，不是 Keymaster 的逻辑桶名称。 */
  readonly bucket: string;
  /** S3 访问身份，不是用户的 Key。 */
  readonly accessKeyId: string;
  /** S3 Secret Access Key，只能由 Node Resource 短期读取。 */
  readonly secretAccessKey: SecretString;
  /** 可选的临时会话令牌，同样不能进入浏览器或报告。 */
  readonly sessionToken?: SecretString;
  /** 专用桶中人工放置的所有权文件 key。 */
  readonly ownershipKey: string;
  /** 排他运行 lease 文件 key。 */
  readonly leaseKey: string;
}

/** SatSubscription testnet 双入口配置；当前字段是公开连接信息但仍按配置文件保护。 */
export interface E2ESatSubscriptionConfig {
  /** WebSocket 服务地址，必须是 wss://。 */
  readonly websocket: string;
  /** WebRTC Direct 服务地址或 multiaddr，不能为空。 */
  readonly webrtcDirect: string;
  /** 可选的预期服务身份公钥，存在时必须是压缩公钥。 */
  readonly expectedServicePublicKeyHex?: string;
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
}

/** loader 的完整结果；不含原始 JSON，不提供 toJSON 展开路径。 */
export interface LoadedE2EConfig {
  readonly directory: string;
  readonly s3: E2ES3Config;
  readonly satsubscription: E2ESatSubscriptionConfig;
  readonly testnet: E2ETestnetSeed;
}
