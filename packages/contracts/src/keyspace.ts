// packages/contracts/src/keyspace.ts
import { defineCapability } from "webloom-framework";
// Keyspace 平台契约：唯一钱包 Key 的当前身份投影。
//
// 单 Key 本地存储（docs/存储.md）之后，keyspace 不再是 Key 容器，而是「当前
// 唯一 Key 是谁」这一平台级只读状态的投影：
//   - KeyIdentity 使用公钥身份（publicKeyHex），不使用私钥、地址或网络。
//   - 没有 listKeys / getKey / setActive / deleteKey：系统里只有一把 Key，
//     不存在列举、切换或删除第二把 Key 的入口。
//   - 替换身份的唯一路径是 vault.resetWallet 之后的重新创建或导入；那不是
//     keyspace 的职责，也不允许沿用旧业务数据。
//   - 业务插件的持久化通过统一存储接口（ctx.storage）进入已绑定模块目录，
//     keyspace 不再提供 openOwnerAppStore 之类的存储入口。
//   - 业务对象里的 ownerPublicKeyHex、收款身份等字段仍然存在，它们是证据与
//     身份核对字段，不是多 Key 目录前缀。

/**
 * 平台公开的唯一 Key 身份；不包含任何私钥材料。
 *
 * 短公钥属于 UI 显示格式，**不**作为字段持有：需要展示时由 UI 侧
 * `formatShortPublicKey(publicKeyHex)` 现算。
 */
export interface KeyIdentity {
  /** 平台公开身份根字段：压缩公钥 hex，lowercase、无 0x 前缀、长度 66。 */
  publicKeyHex: string;
  /** 用户标签。 */
  label: string;
  /** 私钥支持能力,例如 ["p2pkh"]。 */
  capabilities: string[];
  /** 创建时间 ISO 字符串。 */
  createdAt: string;
}

/**
 * 平台级当前身份状态。
 *
 * `activePublicKeyHex` 缺省 = 当前没有可用 Key（未初始化、锁定中，或解锁
 * 过渡态）。没有 "all keys" 模式，也没有第二把可选的 Key。
 */
export interface ActiveKeyState {
  /** 唯一钱包 Key 的 publicKeyHex；缺省 = 当前没有可用 Key。 */
  activePublicKeyHex?: string;
  /** 身份投影修订号；页面用它丢弃乱序或重复投影。 */
  generation?: number;
}

/** Keyspace 服务：只读的当前唯一 Key 投影。 */
export interface KeyspaceService {
  /** 取当前唯一 Key 的身份状态。 */
  active(): ActiveKeyState;
  /**
   * 强制要求当前有可用 Key：缺省时抛错。
   * 业务插件在签名 / 转账 / 显示当前收款地址前调用。
   */
  requireActiveKey(): KeyIdentity;
  /** 订阅身份投影变化,返回取消订阅函数。 */
  onActiveKeyChanged(handler: (state: ActiveKeyState) => void): () => void;
}

/** keyspace capability key。 */
export const KEYSPACE_SERVICE_CAPABILITY = defineCapability<KeyspaceService>({
  kind: "local",
  id: "keyspace.service",
  version: "1",
});

/** 事件：active key 投影变化。payload 是新的 ActiveKeyState。 */
export const EVENT_ACTIVE_KEY_CHANGED = "activeKey.changed";

/** keyspace 事件 payload 类型。 */
export type ActiveKeyChangedEvent = ActiveKeyState;
