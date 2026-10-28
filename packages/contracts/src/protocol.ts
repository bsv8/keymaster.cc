import type { NetworkIdentity } from "./networkIdentity.js";
// packages/contracts/src/protocol.ts
// Keymaster 对外协议 V1 公共契约。
//
// 设计缘由（施工单 001 + 002 + 2026-06-27 002 硬切换 + 2026-06-28 002 硬切换 +
// Connect Storage 施工单）：
//   - 协议方法集：identity.get / intent.sign / cipher.encrypt / cipher.decrypt
//     （签名 + 加解密），p2pkh.transfer（受控转账），feepool.prepare /
//     feepool.commit（双端费用池两步方法族）。所有方法走同一套 transport +
//     同一套 BinaryField + 同一套 ready/request/result 状态机；任何一份契约都
//     要与"硬切换 001 / 002"中列出的核心不变量保持一致。
//   - 本文件**只**放类型与错误码字面量；具体 CBOR 编码、签名、加解密、claim
//     解析都收敛在 `packages/plugin-protocol` 内部，不在 contracts 暴露实现。
//     p2pkh / feepool 的链上交互通过 capability 注入到 plugin-protocol 的
//     service 中；plugin-protocol 不直接 import plugin-p2pkh。
//   - 二进制统一用 `BinaryField`，不允许 base64 / stringified ArrayBuffer 偷渡。
//   - `identityEnvelope` / `signedEnvelope` 是最终真值字节（Deterministic CBOR），
//     不是"待调用方重编码的对象"；调用方验签时**直接**对这些字节验签。
//   - `signature.bytes` 固定为 compact 64-byte secp256k1（r || s），不允许双格式。
//   - `event.origin` 在 cipher / 业务方法上**原样**参与站点密钥派生 / 费用池
//     归档，不做归一化；origin settings / fee pool 持久化也按 exact origin 归档。
//   - 所有错误信息走英文；UI 展示由调用方自己翻译。
//   - `p2pkh.transfer` / `feepool.*` 涉及本地敏感信息（余额 / 池状态 / 失败原因）；
//     真实原因只写本地历史；对外统一 `user_rejected`，**不**暴露真实原因。
//   - `feepool.commit` 的 `operationId` 只在 popup 会话内存中有效，
//     不持久化；popup 刷新 / 关闭后 operation 失效。

import { defineCapability } from "webloom-framework";
import type { ActiveKeyCrypto } from "./activeKeyCrypto.js";
import type { AppIdentityProofV1, AppIdentitySnapshot } from "./appIdentity.js";
import type {
  StorageDeleteParams,
  StorageDeleteResult,
  StorageDirectoryParams,
  StorageDirectoryResult,
  StorageGetParams,
  StorageGetResult,
  StorageListParams,
  StorageListResult,
  StoragePutParams,
  StoragePutResult
} from "./connectStorage.js";
import type {
  MsFileBlockReadParams,
  MsFileReadResult,
  MsFileSeedReadParams,
  MsFileStatParams,
  MsFileStatResult
} from "./msfile.js";
import type {
  ChannelMessageReceivedEventData,
  ChannelPublishParams,
  ChannelPublishResult,
  ChannelSubscriptionSetParams,
  ChannelSubscriptionSetResult
} from "./channel.js";
//   - **命令流展示投影**（施工单 2026-06-27 002 硬切换）：
//       `ProtocolCommandFeedState.commands` **不**再承诺
//       "全局按 updatedAt desc"，而是 service 派生的"活请求区 +
//       历史区"拼接投影：
//         - 活请求区：未终态 record，按 createdAt asc（recordId 次级稳定）；
//         - 历史区：  终态 record，按 updatedAt desc。
//       同类 request 在活请求区不复用卡位；UI 不应再按索引展开。
//       历史加载必须按 recordId 合并（内存活记录覆盖 K-V 旧记录），
//       批次隔离（origin + token）避免旧 origin 异步回写新 origin 视图。
//   - 施工单 2026-06-28 001 硬切换：connect session 作为持续登录 caller
//     的正式真值。
//       - 新增 connect.login / connect.resume / connect.logout 三个 method；
//       - cipher.encrypt / cipher.decrypt 强制要求 `walletPublicKeyHex`
//         输入字段；不再读取钱包全局 active key。
//       - connect session 持久化到 `protocol storage namespace` 的
//         `connectSessions` store（K-V version 升 4）。
//       - popup unlock runtime 仅存在于 popup 当前文档内存；popup
//         刷新 / 关闭后立即失效，caller 通过 `connect.resume` 补 unlock
//         即可，不需要重新登录。
//   - 施工单 2026-06-28 002 硬切换：所有外部业务方法都属于 walletPublicKeyHex：
//       - identity.get / intent.sign / cipher.encrypt / cipher.decrypt /
//         p2pkh.transfer / feepool.prepare / feepool.commit 全部强制要求
//         `walletPublicKeyHex` 入参；`connect.login` 是唯一不要求 sessionId
//         的入口方法。
//       - owner 唯一真值 = `ownerPublicKeyHex`；`ownerKeyId` **不**允许
//         出现在 contract / session record / request record / result payload /
//         fee pool key / pending operation key / service 分支判断里。
//       - `ConnectSessionRecord` / `ConnectLoginResult` / `ConnectResumeResult`
//         都已移除 `ownerKeyId` 字段。
//       - `ProtocolFeePoolRecord` 的持久化 key 维度补 `ownerPublicKeyHex`：
//         `${origin}::${ownerPublicKeyHex}::${counterpartyPublicKeyHex}`，
//         同 origin 不同 owner 不再串池。
//       - `ProtocolCommandRecord` 上的 owner snapshot 字段统一改为
//         `ownerPublicKeyHex` + 新增 `walletPublicKeyHex`（业务方法必填）。
//       - `connect.login` = 重新认证并新建 session；`connect.resume` =
//         恢复既有 session，只补 unlock。
//       - popup 任一时刻只允许一个 auth owner；`connect.resume` 有效时
//         优先于未提交 `connect.login`。
//       - 所有业务 request 在 accept 阶段即预校验 session 真值
//         （fail-fast：session 不存在 / 已 revoke / origin 不匹配 /
//         owner key 不 ready → 直接 phase=failed，对外回 user_rejected
//         / invalid_origin；不进 waiting_unlock / confirming UI）。
//       - 业务执行阶段再次校验 session 仍有效（logout 后同 session 下挂
//         的旧 request 后续执行必须失败；不允许"老 session 复用新 key"）。
//   - 双向 Connect 都由完整钱包的应用连接宿主管理，无独立协议页。
//     App 主动连接采用真实 opener；目录启动的 appView 采用已登记的 child。
//     connect.launch 一次性消费启动 token，不回退到登录。
//   - Connect Storage 施工单：`storage.*` 使用独立 `storage.service` capability
//     与 `keymaster.storage` K-V；旧 protocol K-V 中的 plaintext
//     `storageProviderConfig` 只在历史迁移中物理删除，绝不恢复或读取。
//   - 统一 owner execution runtime：`OwnerExecutionRuntime` 承载同一份
//     session capability；connect mode 下 runtime 允许两路来源——
//     `bootstrap_runtime`（launcher 一次性注入的 session capability）与
//     `vault_runtime`（Session Window 解锁后从本地 vault 重建）。两路对
//     外行为一致；appView mode 不允许在 bootstrap 缺失时回退到
//     `vault_runtime`，必须 fail closed。
//       - session 真值收口为 `sessionId + origin + ownerPublicKeyHex`，
//         **不**持久化 runtime 来源；执行时按当前窗口能解析到的 owner
//         runtime 立即决定能不能跑。
//       - `drainExecutionQueue()` 取消 `lockState === "unlocked"` 全局
//         卡死门：执行条件改成"按 record 自己能否解析到 owner runtime
//         来决定立即执行 / waiting unlock / fail-fast"。
//       - `AppBootstrapPayload.sessionRuntimeBootstrap` 承载
//         `SessionRuntimeBootstrap` capability；Session Window 只在当前内存
//         注册 owner runtime，**不**假装是"完整解锁钱包窗口"，**不**写
//         platform K-V repository / localStorage / URL。
//       - 所有业务方法（`identity.*` / `intent.sign` / `cipher.*` /
//         `p2pkh.transfer` / `feepool.*`）走同一个
//         `resolveOwnerRuntime(session)` 入口；runtime 解析顺序：
//         connect mode 下为 `bootstrap_runtime` → `vault_runtime` → 解析失败；
//         appView mode 下 bootstrap 缺失直接失败。

/**
 * 二进制字段。V1 协议里所有二进制内容（密文、签名、信封真值、文件本体、
 * 头像本体等）必须包成这种结构；不允许直接传 ArrayBuffer / base64 字符串。
 *
 * structured clone 允许 ArrayBuffer / Uint8Array 走 postMessage；本包装
 * 只是为了让"这是二进制内容"在对象层有显式标记，避免调用方误把
 * base64 / hex 字符串塞进协议层。
 */
import type { VaultService } from "./vault.js";
import { PROTOCOL_METHODS as CONNECT_PUBLIC_METHODS } from "keymaster-connect/protocol";
import type * as ConnectPublic from "keymaster-connect/protocol";
export { PROTOCOL_VERSION } from "keymaster-connect/protocol";
import { PROTOCOL_VERSION } from "keymaster-connect/protocol";

/** 对外二进制形状来自独立 Connect；内部执行 DTO 不重新定义 wire。 */
export type BinaryField = ConnectPublic.BinaryField;

/** 协议方法名常量集合。 */
// 费用池只保留钱包内部历史处理类型，不进入独立 Connect 的公开方法表。
export const PROTOCOL_METHODS = [
  ...CONNECT_PUBLIC_METHODS.filter((method): method is Exclude<typeof method, `price.${string}`> => !method.startsWith("price.")),
  "feepool.prepare", "feepool.commit",
] as const;

/** 协议方法名联合类型。 */
export type ProtocolMethod = (typeof PROTOCOL_METHODS)[number];

/**
 * 协议错误码。`error.message` 走英文；UI 展示由调用方决定。
 * 错误码集合是稳定可判定的：第三方接入方写 switch 时不会因为新加错误
 * 类型而误把"未识别"分支当作"成功"。
 *
 * 触发语义（施工单 001 收口）：
 *   - invalid_request         顶层 message 结构 / 字段类型 / aud-iat-exp
 *                             规则 / BinaryField 形状不合法；
 *                             第一条非法 request 直接被 popup 忽略，
 *                             不回 result（"情况 B"）。
 *   - invalid_origin          identity.get / intent.sign 的
 *                             `params.aud !== event.origin`。
 *   - user_rejected           用户在确认页或解锁页点"取消"。
 *   - active_key_unavailable  vault 已 unlocked，但 walletState 没有 ready
 *                             active key（"情况 D"）。
 *   - decrypt_failed          cipher.decrypt 失败；origin 不匹配 / nonce
 *                             错误 / 密文被篡改 / 内层结构不合法，V1
 *                             统一为这一种错误。
 *   - internal_error          兜底：用户可见但不属于以上分类的失败。
 *
 * 注意：V1 **不**对外暴露 `wallet_locked` 错误码。locked 态在 popup 内
 * 直接走解锁页（"情况 C"），用户取消解锁统一回 `user_rejected`。任何
 * "locked 时直接拒绝"的中间态都不属于 V1 公开语义。
 */
export type ProtocolErrorCode =
  /** Transport authority was revoked or belongs to another wallet/Worker generation. */
  | "connection_expired"
  | "invalid_request"
  | "invalid_origin"
  | "user_rejected"
  | "active_key_unavailable"
  | "decrypt_failed"
  /**
   * 请求资产与当前钱包身份绑定的网络不一致。
   * 例如 `p2pkh.transfer` / `feepool.*` 请求 testnet 资产而当前身份绑定 mainnet。
   * accept 阶段 fail-fast，不进确认流。
   */
  | "asset_not_enabled"
  /** Connect v1 明确排除的方法族（新费用池签名等）。 */
  | "unsupported_scope"
  /** 通用支付需要已验证 App 身份（publisher 是归属唯一基准）。 */
  | "identity_required"
  /** 当前硬件后端缺少 Connect 支付所需的受信展示/结构检查。 */
  | "hardware_connect_payment_unsupported"
  | "payment_not_found"
  /** Too many non-terminal Connect payment responsibilities. */
  | "payment_pending_limit"
  /** Same stable payment key with different frozen facts. */
  | "id_conflict"
  | "storage_not_configured"
  | "storage_unavailable"
  | "storage_invalid_path"
  | "storage_not_found"
  | "storage_conflict"
  | "storage_forbidden"
  | "storage_limit_exceeded"
  | "storage_provider_error"
  | "storage_identity_required"
  // MSFile 稳定公开错误码（施工单 §6）。supplier wire error code 保留为
  // 内部诊断，不把任意远端字符串直接变成公开 code。
  | "msfile_not_configured"
  | "msfile_unavailable"
  | "msfile_identity_required"
  | "msfile_supplier_not_found"
  | "msfile_supplier_disabled"
  | "msfile_invalid_hash"
  | "msfile_price_limit_exceeded"
  | "msfile_integrity_error"
  | "msfile_content_not_found"
  | "msfile_rate_limited"
  | "msfile_supplier_error"
  | "msfile_transport_error"
  | "msfile_protocol_error"
  | "internal_error";

/** 协议错误对象。 */
export interface ProtocolError {
  code: ProtocolErrorCode;
  message: string;
}

/** 顶层 ready 报文。 */
export interface ProtocolReadyMessage {
  v: typeof PROTOCOL_VERSION;
  type: "ready";
}

/**
 * 顶层 closing 报文。Popup 在进入结束流程时主动向 opener 发出，
 * 用以通告 popup 生命周期结束。报文**只**承载生命周期语义：
 *
 * - `closing` 是 popup 会话要结束的主动通知；
 * - `closing` **不**携带业务结果、不替代 `result`、不携带 `error`；
 * - client 收到 `closing` 后应立即收敛到 `disconnected`；
 * - `popup.closed === true` 是浏览器给的兜底真值，两者并联收敛。
 *
 * popup 最多发一次 `closing`；发送失败不重试，由 client 端
 * `popup.closed === true` 兜底。
 */
export interface ProtocolClosingMessage {
  v: typeof PROTOCOL_VERSION;
  type: "closing";
}

/* ============== 顶层 cancel 报文（施工单 003 硬切换） ============== */

/**
 * 顶层 `cancel` 报文。
 *
 * 设计缘由（施工单 003）：
 *   - cancel 是 transport 控制消息，**不是**业务 method；不允许把它做成
 *     `method: "cancel"` 的伪 request，也不允许给 cancel 单独配 result。
 *   - `cancel.id` 指向**已经发出**的 `request.id`；popup 只尝试取消
 *     当前会话中绑定的那条 request。被取消的是原 request，所以最终
 *     仍由原 request 回 `result(ok=false)`。
 *   - cancel 自己**不**回一条新 result；这条不变量是 cancel 与普通
 *     request 的关键边界。
 *   - 生效条件由 service 在 `handleMessage` 路径里做集中判定：
 *     当前已绑定 + source/origin 匹配 + id 匹配 + 当前 request 还没
 *     进入不可逆 executing 终态。
 */
export interface ProtocolCancelMessage {
  /** Present for cancellation of an already-bound business request. */
  bindingId?: string;
  v: typeof PROTOCOL_VERSION;
  type: "cancel";
  /** 要取消的原 `request.id`。 */
  id: string;
}

/* ============== 顶层 event 报文（施工单 2026-09-02 Channel） ============== */

/**
 * 协议对外 event 名常量集合（server-pushed 事件）。
 *
 * 设计缘由：
 *   - `channel.message_received` 是已验签的 Channel 公开消息，只发送给
 *     当前 session 已精确订阅的频道；
 */
export type ProtocolEventName = "channel.message_received";

/**
 * 顶层 `event` 报文（server-pushed）。
 *
 * 事件是单向推送，不回 result。
 */
export type ProtocolEventMessage =
  | {
      v: typeof PROTOCOL_VERSION;
      type: "event";
      event: "channel.message_received";
      /** 已验签的 Channel 事件数据。 */
      data: ChannelMessageReceivedEventData;
    };

/** 顶层 request 报文。 */
export interface ProtocolRequestMessage<M extends ProtocolMethod = ProtocolMethod> {
  /** Opaque transport binding returned by login/resume/launch; never a wallet selector. */
  bindingId?: string;
  v: typeof PROTOCOL_VERSION;
  type: "request";
  /** 请求唯一标识；同时承担 transport 关联 id 与业务操作 id 双重角色。 */
  id: string;
  method: M;
  params: ConnectWireParams<M>;
}

/** 顶层 result 报文。 */
export type ProtocolResultMessage =
  | {
      v: typeof PROTOCOL_VERSION;
      type: "result";
      networkIdentity: NetworkIdentity;
      id: string;
      ok: true;
      bindingId?: string;
      result: ConnectWireResult;
    }
  | {
      v: typeof PROTOCOL_VERSION;
      type: "result";
      networkIdentity?: NetworkIdentity;
      id: string;
      ok: false;
      error: ProtocolError;
    };

/**
 * 顶层报文 union。
 *
 * 报文按语义分两类：
 * - 连接状态报文：`ready`（连接建立）、`closing`（连接结束）。
 * - 业务报文：`request` / `result`。
 *
 * 连接状态与业务请求结果是两层语义：
 * - `ready` 是 transport-ready 信号，**不**表示用户已授权；
 * - `closing` 是 popup 生命周期结束信号，**不**替代 `result`；
 * - `result` 是 request 的业务结果，**不**代表连接已断开。
 *
 * 不允许在 `result` 中夹带"连接已断开"语义；不允许把 `closing`
 * 设计成"顺便夹带 result"。本协议 V1 **不**引入心跳、不引入
 * `MessageChannel`。
 */
export type ProtocolMessage =
  | ProtocolReadyMessage
  | ProtocolRequestMessage
  | ProtocolResultMessage
  | ProtocolClosingMessage
  | ProtocolCancelMessage
  | ProtocolEventMessage;

/* ============== identity.get ============== */

/**
 * identity.get 请求参数。
 *
 * 设计缘由（施工单 2026-06-28 002 硬切换）：
 *   - `walletPublicKeyHex` 是**强制**输入字段；所有外部业务方法都属于某个
 *     `walletPublicKeyHex`（仅 `connect.login` 例外）。缺该字段直接
 *     `invalid_request` 拒绝。
 *   - `identity.get` 不再是"推荐登录入口"；登录走 `connect.login`。
 *     `identity.get` 是"会话内身份断言能力"——`subject` 取自 session 绑
 *     定 owner，不是当前钱包 active key。
 */
export interface IdentityGetParams {
  /** 目标站点 origin；必须等于 `event.origin`，否则拒绝。 */
  aud: string;
  /** 签发时间（unix seconds）。 */
  iat: number;
  /** 过期时间（unix seconds）；必须严格大于 iat。 */
  exp: number;
  /** 人类可读确认文案。 */
  text: string;
  /**
   * 请求索要的 claim 名列表。
   * - Keymaster 只返回请求里明确列出且当前本地有真值来源的 claim；
   * - 不存在的 claim 直接省略，不报错。
   */
  claims?: string[];
  /**
   * 由 `connect.login` 返回的钱包公钥。**必填**。
   * service 通过公钥与来源 找到绑定 key，不允许 fallback 到 active key。
   */
  walletPublicKeyHex: string;
}

/** identity.get 解析后的 claim 真值。 */
export type ResolvedClaimValue =
  | string
  | number
  | boolean
  | null
  | BinaryField
  | ResolvedClaimValue[]
  | { [key: string]: ResolvedClaimValue };

/** identity.get 成功结果。 */
export interface IdentityGetResult {
  /** Identity 信封最终真值字节（Deterministic CBOR）。 */
  identityEnvelope: BinaryField;
  /** 签名（compact 64-byte secp256k1）。 */
  signature: BinaryField;
  /** 签名主体公钥（33-byte compressed）。 */
  subject: { publicKey: BinaryField };
  /** Keymaster 本次实际返回给调用方的 claim 真值。 */
  resolvedClaims: Record<string, ResolvedClaimValue>;
}

/* ============== intent.sign ============== */

/**
 * intent.sign 请求参数。
 *
 * 设计缘由（施工单 2026-06-28 002 硬切换）：
 *   - `walletPublicKeyHex` 是**强制**输入字段；签名主体公钥取自 session
 *     绑定的 owner，不再读取钱包全局 active key。
 *   - 旧叙事"登录场景推荐 identity.get"已废弃；登录走 `connect.login`。
 */
export interface IntentSignParams {
  /** 目标站点 origin；必须等于 `event.origin`，否则拒绝。 */
  aud: string;
  /** 签发时间（unix seconds）。 */
  iat: number;
  /** 过期时间（unix seconds）；必须严格大于 iat。 */
  exp: number;
  /** 人类可读确认文案。 */
  text: string;
  /** 调用方自定义的内容类型。 */
  contentType: string;
  /** 调用方准备好的最终二进制内容。允许为空字节。 */
  content: BinaryField;
  /**
   * 由 `connect.login` 返回的钱包公钥。**必填**。
   * service 通过公钥与来源 找到绑定 key，不允许 fallback 到 active key。
   */
  walletPublicKeyHex: string;
}

/** intent.sign 成功结果。 */
export interface IntentSignResult {
  /** 签名信封最终真值字节（Deterministic CBOR）。 */
  signedEnvelope: BinaryField;
  /** 签名（compact 64-byte secp256k1）。 */
  signature: BinaryField;
}

/* ============== cipher.encrypt ============== */

/**
 * cipher.encrypt 请求参数。
 *
 * 设计缘由（施工单 2026-06-28 001 硬切换）：
 *   - `walletPublicKeyHex` 是**强制**输入字段；cipher 不再读取钱包全局
 *     active key，按公钥与实际来源定位绑定 key。
 *   - 缺 `walletPublicKeyHex` 直接 `invalid_request` 拒绝；不允许 fallback
 *     到当前 active key。
 *   - cipher 仍**不**对外暴露签名真值 envelope；返回 nonce + cipherbytes。
 */
export interface CipherEncryptParams {
  /** 人类可读确认文案。 */
  text: string;
  /** 调用方自定义的内容类型；与 contentBytes 一起进入密文内层结构。 */
  contentType: string;
  /** 业务字节本体。 */
  content: BinaryField;
  /**
   * 由 `connect.login` 返回的钱包公钥。**必填**；service 通过公钥与来源
   * 找到绑定 key，不允许 fallback 到 active key。
   */
  walletPublicKeyHex: string;
}

/** cipher.encrypt 成功结果。 */
export interface CipherEncryptResult {
  /** 本次加密随机生成的 12 字节 nonce。 */
  nonce: BinaryField;
  /** AES-GCM 密文字节（含认证 tag）。 */
  cipherbytes: BinaryField;
}

/* ============== cipher.decrypt ============== */

/**
 * cipher.decrypt 请求参数。
 *
 * 设计缘由：与 `cipher.encrypt` 对称——`walletPublicKeyHex` 是强制输入
 * 字段；不允许 fallback 到 active key。
 */
export interface CipherDecryptParams {
  /** 人类可读确认文案。 */
  text: string;
  /** 加密时保存的 12 字节 nonce。 */
  nonce: BinaryField;
  /** 加密时保存的密文字节。 */
  cipherbytes: BinaryField;
  /**
   * 由 `connect.login` 返回的钱包公钥。**必填**；service 通过公钥与来源
   * 找到绑定 key，不允许 fallback 到 active key。
   */
  walletPublicKeyHex: string;
}

/** cipher.decrypt 成功结果。 */
export interface CipherDecryptResult {
  /** 密文内层结构里的 contentType。 */
  contentType: string;
  /** 还原后的业务字节。 */
  content: BinaryField;
}

/* ============== p2pkh.transfer ============== */

/** App 注册支付用途；owner 取已验证会话的 publisher，不能自报或用 channelName 分叉额度。 */
export interface PaymentChannelRegisterParams {
  walletPublicKeyHex: string;
  channelName: string;
  paymentType: "p2pkh" | "p2pk" | "feepool.connect";
  assetId?: P2pkhTransferAssetId;
}
export interface PaymentChannelRegisterResult { channelId: string; }

/**
 * Connect 公开的 P2PKH 资产标识。
 *
 * 设计缘由（施工单 2026-09-18 001 多资产硬切换）：
 *   - 公开命名固定 `bsv-mainnet` / `bsv-testnet`，不暴露 p2pkh 内部
 *     的 `bsv` / `bsvtest`；
 *   - `bsv-testnet` 只与绑定测试网的钱包身份匹配，
 *     否则 accept 阶段 fail-fast `asset_not_enabled`；
 *   - 不传 `assetId` 时使用绑定钱包身份对应的网络。
 */
export type P2pkhTransferAssetId = "bsv-mainnet" | "bsv-testnet";

/**
 * `p2pkh.transfer` 请求参数。
 *
 * 设计缘由（施工单 002 硬切换 + 施工单 2026-06-28 002 硬切换 +
 * 施工单 2026-09-18 001 多资产硬切换）：
 *   - 本次只支持 `bsv` 主网 / testnet P2PKH 转账。不引入多币种资产、
 *     多网络协商之外的链类型。
 *   - site 不允许传 `text` / `confirmMessage`：确认文案由 Keymaster 自己
 *     按方法语义生成；不允许 site 伪装转账为登录确认。
 *   - `aud` 不接受：connect popup 已天然拿到 `event.origin` 真值，origin
 *     等价检查由 service 自动执行。
 *   - `feeRateSatoshisPerKb` 可选；缺省时由 P2PKH service 按当前钱包网络的有效费率策略决定。
 *   - amountSatoshis 是整数 satoshis，不接受小数；feeSatoshis 在 result 里
 *     回。
 *   - `assetId` 可选；缺省使用当前钱包身份的网络。显式网络必须与该身份匹配。
 *   - `walletPublicKeyHex` 是**强制**输入字段（施工单 2026-06-28 002 硬切换）：
 *     资金 owner 取自 session 绑定 owner，**不**读取全局 active key。
 *     旧 session 失效时直接 fail-fast，不再静默 fallback 到 active key。
 */
export interface P2pkhTransferParams {
  /** 先注册取得的完整渠道编号；不允许宿主代填或省略。 */
  channelId: string;
  /** 主网或 testnet P2PKH 地址（base58check，version 0x00 / 0x6f）。 */
  recipientAddress: string;
  /** 正整数 satoshis。 */
  amountSatoshis: number;
  /** 可选 fee rate（sat/kB）。>= 1。 */
  feeRateSatoshisPerKb?: number;
  /**
   * 可选资产；缺省当前 NetworkIdentity 的网络资产。跨网络请求被拒绝。
   */
  assetId?: P2pkhTransferAssetId;
  /**
   * 由 `connect.login` 返回的钱包公钥。**必填**。
   * service 通过公钥与来源 找到绑定 key，不允许 fallback 到 active key。
   */
  walletPublicKeyHex: string;
}

/** `p2pkh.transfer` 成功结果。 */
export interface P2pkhTransferResult {
  /** 本次实际转账的资产；与 params.assetId 一致（缺省回 `bsv-mainnet`）。 */
  assetId: P2pkhTransferAssetId;
  /** 已广播交易的 canonical txid。 */
  txid: string;
  /** 已签名交易 raw hex。 */
  rawTxHex: string;
  /** 实际花费的 fee satoshis。 */
  feeSatoshis: number;
}

/* ============== payment.pay / payment.status ============== */

/** Connect v1 支付方案；业务种类（businessKind）是独立维度。 */
export type ConnectPaymentType = "p2pkh" | "p2pk";
export type ConnectPaymentRecipientOwnership = "app-publisher" | "third-party" | "unknown";
export type ConnectPaymentStatus =
  | "pending"
  | "not_signed"
  | "signed_not_dispatched"
  | "unknown"
  | "failed"
  | "accepted"
  | "already_known";

/** 收款材料：类型必须与 paymentType 一致。 */
export type ConnectPaymentRecipient =
  | { type: "p2pkh"; address: string }
  | { type: "p2pk"; publicKeyHex: string };

/**
 * 通用支付申请。App 只声明业务金额、业务种类、费率与收款材料；不得自报
 * publisher、归属、找零或任意脚本。钱包输入与找零固定为付款钱包 P2PKH。
 */
export interface PaymentPayParams {
  channelId: string;
  /** 稳定幂等身份，1–128 字符。 */
  clientRequestId: string;
  paymentType: ConnectPaymentType;
  /** App 声明的业务用途；展示时不是可信商业结论。 */
  businessKind: string;
  /** 业务金额（聪，不含矿工费）。 */
  amountSatoshis: number;
  /** 可选希望费率（sat/kB）。 */
  feeRateSatoshisPerKb?: number;
  recipient: ConnectPaymentRecipient;
  assetId?: P2pkhTransferAssetId;
  walletPublicKeyHex: string;
}

export interface PaymentReleaseSummary {
  /** Historical amount safely released, NOT the current wallet balance. */
  releasedSatoshis: string;
  releasedInputCount: number;
  spentInputCount: number;
  heldInputCount: number;
}

/** 对外支付结果：不返回 rawTxHex、签名或内部 exact。 */
export interface PaymentPayResult {
  paymentId: string;
  clientRequestId: string;
  status: ConnectPaymentStatus;
  assetId: P2pkhTransferAssetId;
  paymentType: ConnectPaymentType;
  recipientOwnership: ConnectPaymentRecipientOwnership;
  /** 只有 accepted/already_known 才有 canonical txid。 */
  txid?: string;
  feeSatoshis?: number;
  changeSatoshis?: number;
  approval?: "automatic" | "manual" | "unknown";
  /** 稳定原因码；不包含签名/交易原文。 */
  reason?: string;
  release?: PaymentReleaseSummary;
}

/** 状态查询使用同一稳定身份；不泄露其他调用者的请求存在性。 */
export interface PaymentStatusParams {
  clientRequestId: string;
  walletPublicKeyHex: string;
}
export type PaymentStatusResult = PaymentPayResult;

/** 持久去重/状态记录；内部字段不得下发给 App。 */
export interface ProtocolConnectPaymentRecord {
  key: string;
  paymentId: string;
  clientRequestId: string;
  origin: string;
  ownerPublicKeyHex: string;
  networkIdentity: NetworkIdentity;
  appId: string;
  publisherPublicKeyHex: string;
  requestDigest: string;
  params: PaymentPayParams;
  status: ConnectPaymentStatus;
  recipientOwnership: ConnectPaymentRecipientOwnership;
  reason?: string;
  txid?: string;
  feeSatoshis?: number;
  changeSatoshis?: number;
  approval?: "automatic" | "manual" | "unknown";
  allocationId?: string;
  previewId?: string;
  release?: PaymentReleaseSummary;
  createdAt: number;
  updatedAt: number;
}

/* ============== feepool.prepare / feepool.commit ============== */

/**
 * fee pool 三种 action。
 *
 * 含义（V4 真实模型："两笔 tx + 持续协商的 B-Tx 草稿"）：
 *   - `create`：当前没有该 (origin, counterpartyPublicKeyHex) 对应的池，
 *     建池 A-Tx（client P2PKH → 2-of-2 multisig）+ 生成初始 B-Tx 草稿，
 *     草稿 `serverAmount = amountSatoshis`。**不**广播 B-Tx。
 *   - `spend`：池已存在且 `prior.serverAmount + amountSatoshis <= prior.totalAmount`；
 *     在旧 B-Tx 草稿上 `serverAmount += amountSatoshis` 并 client 重签，
 *     **不**构造新独立 draftTx，**不**走 dust close 路径，**不**广播。
 *   - `close_and_recreate`：池存在但累计 transfer 会超 `totalAmount`；先把
 *     旧 B-Tx 草稿切到 `FINAL_LOCKTIME` 得到 close 草稿（双方后续广播；
 *     V1 简化下暂不广播），再建新池 A-Tx + 生成新池初始 B-Tx 草稿。
 */
export type ProtocolFeePoolAction = "create" | "spend" | "close_and_recreate";

/**
 * `feepool.prepare` 请求参数。
 *
 * 设计缘由（施工单 002 硬切换 + 收尾反馈 + 施工单 2026-06-28 002 硬切换）：
 *   - site **不**传 `action` / `lockHeight` 等策略字段；action（create /
 *     spend / close_and_recreate）和 lockHeight 由 Keymaster 单边决定。
 *   - site 只提交：
 *       - `counterpartyPublicKeyHex`：对端公钥。
 *       - `amountSatoshis`：**本次想转给对端的金额**（satoshis）。
 *       - `walletPublicKeyHex`：本次 transfer 所属钱包公钥；service
 *         通过 session 找到绑定 owner。**必填**。
 *   - `amountSatoshis` 在所有 action 下语义一致：本次 transfer 的金额。
 *     池大小由 `ProtocolOriginSettingsRecord.feePoolDefaultFundSatoshis`
 *     决定（per-origin 配置）。
 *   - 三种 action 都围绕"持续协商的 B-Tx 草稿"展开（**不**在 prepare 阶段
 *     广播任何 draftTx）：
 *       - `create`：建池 A-Tx + 生成初始 B-Tx 草稿，
 *         草稿 `serverAmount = amountSatoshis`。
 *       - `spend`：在旧 B-Tx 草稿上把 `serverAmount += amountSatoshis` 并
 *         client 重签，得到更新后的 B-Tx 草稿。
 *       - `close_and_recreate`：把旧 B-Tx 草稿切到 `FINAL_LOCKTIME` 得到
 *         close 草稿（待双方后续广播；V1 简化下暂不广播），再建新池 A-Tx +
 *         生成新池初始 B-Tx 草稿。
 */
export interface FeepoolPrepareParams {
  channelId: string;
  /** 33-byte compressed secp256k1 公钥 hex（66 个 hex 字符）。 */
  counterpartyPublicKeyHex: string;
  /** 正整数 satoshis；本次想转给对端的金额（三种 action 语义一致）。 */
  amountSatoshis: number;
  /**
   * 可选资产；缺省当前 NetworkIdentity 的网络资产。跨网络请求被拒绝。
   * 池按 (origin + ownerPublicKeyHex + counterpartyPublicKeyHex + assetId)
   * 归档；mainnet 与 testnet 不串池。
   */
  assetId?: P2pkhTransferAssetId;
  /**
   * 由 `connect.login` 返回的钱包公钥。**必填**。
   * feepool 是按 (origin + ownerPublicKeyHex + counterpartyPublicKeyHex +
   * assetId) 四个维度归档的；不同 owner / 不同资产不会串池。
   */
  walletPublicKeyHex: string;
}

/**
 * `feepool.prepare` 成功结果。
 *
 * 设计缘由（V4 收口）：feepool 真实模型是"两笔 tx + 持续协商的 B-Tx 草稿"。
 *   - `baseTxHex`：建池那笔 A-Tx（client P2PKH → 2-of-2 multisig），
 *     仅 client 签（funding 来自 client 自己的 UTXO），**不需要** server sig。
 *   - `draftSpendTxHex` / `draftClientSignBytes`：当前 B-Tx 草稿（multisig output
 *     → server + client change）。三种 action 都有。**不是**真广播的 tx，
 *     是 site / server 持续协商的草稿。
 *
 * 三种 action 返回的字段：
 *   - `create`：baseTxHex + baseTxOutputIndex + draftSpendTxHex + draftClientSignBytes
 *     （建池 + 初始 B-Tx 草稿；草稿 serverAmount = amountSatoshis）。
 *   - `spend`：draftSpendTxHex + draftClientSignBytes（更新后的 B-Tx 草稿；
 *     在旧草稿上累计 serverAmount 并 client 重签，**不**再单独发一笔
 *     draftTx，**不**走 dust close 路径，**不**广播）。
 *   - `close_and_recreate`：closeDraftTxHex + closeClientSignBytes（close 草稿：
 *     旧草稿切到 `FINAL_LOCKTIME` 最终版本） + baseTxHex + baseTxOutputIndex
 *     （新池 A-Tx） + draftSpendTxHex + draftClientSignBytes（新池初始 B-Tx 草稿）。
 *
 * 字段命名说明：`draftSpendTxHex` / `closeDraftTxHex` 中的 `draft` 强调
 * "是当前草稿、不是真广播的 tx"；`closeDraftTxHex` 同理（是 close 版本的
 * 草稿）。`operationId` 同步在 prepare 阶段产出，commit 阶段回带。
 */
export interface FeepoolPrepareResult {
  /** operationId 仅在当前 popup 会话内有效；popup 关闭后失效。 */
  operationId: string;
  action: ProtocolFeePoolAction;
  /** 本次操作所属资产；与 params.assetId 一致（缺省回 `bsv-mainnet`）。 */
  assetId: P2pkhTransferAssetId;
  counterpartyPublicKeyHex: string;
  /** 本次 transfer 的 delta（site 请求的 amountSatoshis）。 */
  amountSatoshis: number;
  /**
   * 建池 A-Tx（action === "create" 或 "close_and_recreate"）。
   * create：唯一的一笔；close_and_recreate：新建池那笔。
   * 仅 client 签；**不需要** server sig。
   */
  baseTxHex?: string;
  /** multisig output 在 base tx 里的 vout index。 */
  baseTxOutputIndex?: number;
  /**
   * 主 B-Tx 草稿（三种 action 都有）。
   * create / close_and_recreate 的新池分支：这是初始 B-Tx 草稿。
   * spend / close_and_recreate 的 close 之前的 spend 分支：这是更新后的草稿。
   *
   * 当前草稿，不是真广播的 tx；是 site 与 server 持续协商的对象。
   */
  draftSpendTxHex: string;
  /** 当前 draftSpendTxHex 上的 client 部分签名。 */
  draftClientSignBytes: BinaryField;
  /**
   * close_and_recreate 的 close 版本 B-Tx 草稿（仅 close_and_recreate）。
   * 由 SDK `loadTx` 把旧 draft 切到 FINAL_LOCKTIME 最终版本得到；
   * commit 落地后这个 close 草稿会被双方广播（V1 简化：暂时不广播）。
   */
  closeDraftTxHex?: string;
  /** closeDraftTxHex 上的 client 部分签名。 */
  closeClientSignBytes?: BinaryField;
  /** 决策时参考的旧池快照。 */
  priorPoolRecord?: {
    baseTxid: string;
    totalAmount: number;
    serverAmount: number;
    draftSpendTxHex?: string;
  } | null;
}

/** `feepool.commit` 请求参数。
 *
 * V4 收口：**移除 `baseCounterpartySignatures`**。base tx 仅由 client 用
 * 自己 P2PKH UTXO funding 并签名；server 不参与 base tx 的签名（multisig
 * output 是被创建的，不是被花费的）。所有 server sig 都在 B-Tx 上。
 *
 * 设计缘由（施工单 2026-06-28 002 硬切换）：
 *   - `walletPublicKeyHex` 是**强制**输入字段；`feepool.commit` 必须按
 *     `walletPublicKeyHex + origin + ownerPublicKeyHex` 校验 pending op，
 *     不允许跨 session / 跨 owner 复用 operationId。
 */
export interface FeepoolCommitParams {
  /** 必须与 prepare 使用的渠道一致。 */
  channelId: string;
  /** 由 `feepool.prepare` 返回的 operationId；只在本 popup 会话内有效。 */
  operationId: string;
  /** 33-byte compressed secp256k1 公钥 hex。 */
  counterpartyPublicKeyHex: string;
  /**
   * 可选资产；缺省 `bsv-mainnet`。必须与 prepare 阶段一致，
   * 否则 commit fail-closed。
   */
  assetId?: P2pkhTransferAssetId;
  /**
   * 由 `connect.login` 返回的钱包公钥。**必填**。
   * `feepool.commit` 校验 operation 与当前 session/owner/origin 一致。
   */
  walletPublicKeyHex: string;
  /**
   * 主 B-Tx 草稿的 server sig。
   * - create：initial spend sig（由 SDK `clientVerifyServerSpendSig` 验）。
   * - spend：update sig（由 SDK `clientVerifyServerUpdateSig` 验）。
   * - close_and_recreate 的新池部分：initial spend sig（同 create）。
   */
  counterpartySignatures: BinaryField[];
  /**
   * close_and_recreate 的 close 部分 B-Tx 草稿的 server sig（update sig）。
   * 仅 close_and_recreate 路径下传入；其它 action 不传。
   */
  closeCounterpartySignatures?: BinaryField[];
}

/** `feepool.commit` 成功结果。
 *
 * V4 收口：返回的 `draftTxid` / `draftTxHex` 是**当前 B-Tx 草稿**的
 * txid / hex，**不是**真广播的 tx。commit 阶段只把草稿持久化到 store，
 * 由 server 决定何时广播。V1 简化下不真广播。
 */
export interface FeepoolCommitResult {
  operationId: string;
  action: ProtocolFeePoolAction;
  /** 本次操作所属资产；与 prepare 阶段一致（缺省回 `bsv-mainnet`）。 */
  assetId: P2pkhTransferAssetId;
  /** 当前主 B-Tx 草稿的 txid。 */
  draftTxid: string;
  /** 当前主 B-Tx 草稿的 raw tx hex。 */
  draftTxHex: string;
  /** 落地后费用池记录（spend / close_and_recreate 的新池部分非空）。 */
  poolRecord: ProtocolFeePoolRecord | null;
  /** 仅 close_and_recreate：旧池被 close 时的最终 close 草稿 txid。 */
  closeDraftTxid?: string;
}

/* ============== 站点配置 ============== */

/** exact origin 的身份/密码学自动确认及人工确认超时。付款由钱包核心授权。 */
export interface ProtocolOriginSettings {
  /** exact event.origin（不做 host 归一化）。 */
  origin: string;
  /**
   * 是否对该 origin 自动批准 `identity.get`。
   *
   * 设计缘由（施工单 001 收口：per-origin 自动批准 + 钱包入口）：
   *   - exact origin 语义与 `origin` 字段保持一致，不做 host 归一化。
   *   - 自动批准 = "跳过 manual confirm 页" + "vault 锁定态下解锁后直接
   *     executing 内联执行，不再进入 confirming"。
   *   - K-V 不可用时按 false 处理（走 manual confirm）。
   *   - 旧记录缺字段时由 service 层 `normalizeOriginSettings` 补 false，
   *     **不**扫库迁移，**不**升 K-V version。
   */
  identityAutoApproveEnabled: boolean;
  /**
   * 是否对该 origin 自动批准 `cipher.encrypt` 与 `cipher.decrypt`。
   * 同一字段同时控制 encrypt 与 decrypt，语义对称。
   *
   * 设计缘由（施工单 001）：
   *   - 不扩展到签名或转账；
   *     付款的渠道/会话额度只由钱包核心处理。
   *   - aud / origin 校验仍由对应 execute 方法内部 throw，自动批准
   *     路径不绕过校验。
   */
  cipherAutoApproveEnabled: boolean;
  /**
   * 确认超时秒数（施工单 003 硬切换：per-origin 确认超时）。
   *
   * 设计缘由：
   *   - exact origin 级别的策略字段；不放在全局 localStorage / 不放在
   *     系统级 /settings/protocol。
   *   - 缺省值 `30`（正整数秒）；空串 / 非整数 / `<= 0` 在 UI 提交路径
   *     上规范化为 `30`。
   *   - 起点：请求进入 `unlocking` 或 `confirming`。终点：用户确认 /
   *     取消 / client 发来 cancel / 进入 executing / 倒计时到点。
   *   - 改动只影响下一条新 request；当前正在倒计时的请求保留它开始
   *     计时时快照下来的 timeout 值，**不**做热更新。
   *   - 旧 origin 记录缺这个字段时，由 service 层 `normalizeOriginSettings`
   *     补 `30`，不扫库迁移，不升 K-V version。
   */
  confirmTimeoutSeconds: number;
  updatedAt: number;
}

/** 钱包私有的持久化站点记录。 */
export interface ProtocolOriginSettingsRecord extends ProtocolOriginSettings {
  feePoolDefaultFundSatoshis?: number;
}

/**
 * 费用池持久化记录。
 *
 * 设计缘由（V4 收口 + 施工单 2026-06-28 002 硬切换）：feepool 真实模型是两笔 tx：
 *   - **A-Tx（base tx，建池时定）**：client P2PKH UTXO → 2-of-2 multisig output，
 *     池大小 = multisig output 总额 = `feePoolDefaultFundSatoshis`。
 *   - **B-Tx（draft 草稿，持续协商）**：multisig output → server + client change。
 *     每次 transfer 不再独立发一笔新 draftTx，而是在同一个 B-Tx 草稿上
 *     更新 `serverAmount` 字段；只有 close 时把草稿切到 FINAL_LOCKTIME
 *     最终版本，broadcast 后真正生效。
 *
 * `totalAmount` vs `serverAmount` 语义（V4 明确）：
 *   - `totalAmount` = 池大小 = base tx multisig output 总额。
 *   - `serverAmount` = 当前已累计分配给 server 的金额
 *     （`prior.serverAmount + amountSatoshis` 的累加结果）；永远 `<= totalAmount`。
 *   - 决策：若 `prior.serverAmount + amountSatoshis <= prior.totalAmount`
 *     → spend（在旧 B-Tx 草稿上 update）；否则 close_and_recreate。
 *   - key 必须包含 ownerPublicKeyHex + counterpartyPublicKeyHex：
 *       同一 origin 不同 owner 不能串池（不同 connect session 是不同 owner）；
 *       同一 origin 同一 owner 但对端公钥切换 → 新池。
 *   - key 格式（施工单 2026-09-18 001 多资产硬切换）：
 *       mainnet：`${origin}::${ownerPublicKeyHex}::${counterpartyPublicKeyHex}`
 *         （保持旧 key 形状，不迁移历史池）；
 *       testnet：上面追加 `::bsv-testnet`。
 *       `::` 不可能出现在 origin / publicKeyHex 字符串里，碰撞风险极低。
 */
export interface ProtocolFeePoolRecord {
  /**
   * 复合 key。施工单 2026-06-28 002 硬切换：补 `ownerPublicKeyHex` 维度；
   * 施工单 2026-09-18 001：testnet 再追加 `::bsv-testnet`。
   * mainnet 格式：`${origin}::${ownerPublicKeyHex}::${counterpartyPublicKeyHex}`。
   */
  poolKey: string;
  origin: string;
  /** 绑定该池的 connect session owner 的公钥 hex。 */
  ownerPublicKeyHex: string;
  counterpartyPublicKeyHex: string;
  /** 池所属资产；旧记录缺失时按 `bsv-mainnet` 归一化。 */
  assetId: P2pkhTransferAssetId;
  /** base tx txid（2-of-2 multisig output 在这里）。 */
  baseTxid: string;
  /** base tx raw hex。 */
  baseTxHex: string;
  /** 池大小（satoshis）= base tx multisig output 总额 = `feePoolDefaultFundSatoshis`。 */
  totalAmount: number;
  /**
   * 累计已分配给 server 的金额（satoshis）。
   * - create：第一次 transfer 后 = `amountSatoshis`。
   * - spend：每次在 prior 基础上累加（`prior.serverAmount + amountSatoshis`）。
   * - close_and_recreate：旧池被关时 = `prior.serverAmount + amountSatoshis`；
   *   新池被建时 = `amountSatoshis`（新池重新从 0 开始累计）。
   */
  serverAmount: number;
  /** 当前 B-Tx 草稿 hex（site 与 server 持续协商的对象；当前草稿，不是真广播）。 */
  draftSpendTxHex: string;
  /** 当前 B-Tx 草稿上的 client 部分签名。 */
  draftClientSignBytes: BinaryField;
  /** 产生这条记录的最后一次 operation id。 */
  lastOperationId: string;
  updatedAt: number;
}

/**
 * 对外交付签名责任的持久记录（E01）。
 *
 * 签名字节离开钱包前必须落盘：wallet provider 未派发不能证明站点没广播，
 * 站点承诺 / 404 / session 结束都不是证据。记录与 popup 会话无关：
 * `operationId` 失效不消灭资金责任。
 */
export interface ProtocolFeePoolDeliveryRecord {
  /** 稳定责任 ID；同一 operation 的同一 kind 只写一次。 */
  id: string;
  operationId: string;
  origin: string;
  ownerPublicKeyHex: string;
  counterpartyPublicKeyHex: string;
  assetId: P2pkhTransferAssetId;
  channelId: string;
  sessionId: string;
  action: ProtocolFeePoolAction;
  /**
   * `base-transaction` = 完整签名的 A-Tx（可被站点自行广播）；
   * `state-signature` = 对方还能补齐并花费的部分签名草稿。
   */
  kind: "base-transaction" | "state-signature";
  /** 交付的 exact 原文（A-Tx 或草稿）。 */
  rawTxHex: string;
  /** `state-signature` 的钱包签名原文。 */
  signatureHex?: string;
  /** 相关真实输入与金额。 */
  inputs: Array<{ txid: string; vout: number; value: number }>;
  totalInSatoshis: number;
  reason: string;
  createdAt: number;
  /**
   * UTXO Manager 的占用 ID（稳定身份）。
   *
   * 中文说明：ledger 记录与 manager 占用指向同一笔责任；恢复时据此对账，
   * 不重建交易、不重复释放。
   */
  managerAllocationId?: string;
  /** 可信观察结算后的 txid（未结算时缺省）。 */
  settledTxid?: string;
  settledAt?: number;
}

/**
 * 本地终态原因（仅写本地历史；对外统一 `user_rejected`）。
 *
 * 设计缘由：余额不足 / 池缺失 / K-V 不可用等敏感失败，以及用户本地取消 /
 * client 主动 cancel 等内部终态，都不应暴露给站点；站点**不**应通过
 * `error.message` 反推。V1 把这些本地原因收口在一个固定 union 里；
 * service 层映射到 `ProtocolErrorCode = "user_rejected"`。
 */
export type ProtocolFailureReason =
  | "user_canceled"
  | "client_canceled"
  | "superseded_by_resume"
  | "insufficient_balance"
  | "invalid_address"
  | "invalid_amount"
  | "fee_pool_not_found"
  | "fee_pool_db_unavailable"
  | "unknown_operation"
  | "cross_origin_operation"
  | "request_timeout"
  /**
   * 请求资产与当前钱包身份绑定的网络不一致。
   *
   * 触发：p2pkh.transfer / feepool.* 请求 testnet 资产但当前身份绑定 mainnet。
   * 对外稳定 code = `asset_not_enabled`。
   */
  | "asset_not_enabled"
  /**
   * 当前 Session Window 拿不到 owner execution runtime（施工单
   * 2026-06-30 002 硬切换）。
   *
   * 触发：bootstrap runtime 丢失（刷新 / 关闭），且本窗口用户
   * 还未在本窗口 unlock；当前窗口既无法用 bootstrap runtime 也
   * 无法从本地 vault 重建。
   *
   * 处置：fail-closed，要求用户重新从 Keymaster 启动 app。
   * 对外统一 `user_rejected`；本地 reason = `runtime_missing`。
   */
  | "runtime_missing"
  /**
   * Connect session 的 owner 不等于当前 active key（硬切换 002 收尾）。
   *
   * 触发：protocol 层 `assertSessionOwnerIsActive` 在调用
   * `p2pkh.transfer` / `feepool.prepare`（任何走 P2PKH value 的
   * 入口）前显式校验 session owner == active key；不等时主动
   * fail-closed，**不**让硬门禁在底层冒泡「Key storage is not
   * ready」这种偶发错误作为协议失败语义。
   *
   * 处置：对外 `user_rejected`；本地 reason = `session_owner_mismatch`。
   */
  | "session_owner_mismatch"
  | "storage_error"
  | "internal_error";

/**
 * 站点配置与费用池状态（施工单 002 硬切换）
 *
 * fee pool 缺省 fund **已收回到 per-origin 配置**
 * （`ProtocolOriginSettingsRecord.feePoolDefaultFundSatoshis`）。
 * 不再有系统级常量 / 不再有 `/settings/protocol` 入口；同一站点不同 origin
 * 之间彼此独立。
 */

/* ============== connect.login / connect.resume / connect.logout（施工单 2026-06-28 001 硬切换） ============== */

/**
 * connect 方法族：把 connect session 提升为持续登录 caller 的正式真值。
 *
 * 设计缘由（施工单 2026-06-28 001）：
 *   - 三层语义必须分开：
 *       popup transport session
 *         = popup 窗口级 postMessage 收发会话
 *       connect auth session
 *         = caller 对当前 origin 已获得授权的持久会话
 *       popup unlock runtime
 *         = 当前 popup 文档内可直接执行私钥操作的短期运行时材料
 *   - 登录时显式选择 key；后续 connect session 绑定该 key 的 publicKeyHex。
 *   - cipher.* 不再读取钱包全局 active key；通过 `walletPublicKeyHex` 找到
 *     绑定 key。
 *   - popup 刷新 / 关闭 → 当前 popup unlock runtime 失效；auth session
 *     持久化记录仍保留，caller 通过 `connect.resume` 补 unlock 即可。
 *   - `connect.logout` 是 auth 失效的唯一正常路径。
 *
 * 不删除 `identity.get` / `intent.sign` / `cipher.encrypt` / `cipher.decrypt`：
 *   - `identity.get` 仍保留，但**不**再作为 note 这类持续登录 caller
 *     的推荐入口；走 `connect.login` 获取钱包公钥。
 *   - `cipher.*` 的稳定调用路径改为 session 绑定版本；继续保留旧 method
 *     名但**强制**要求 `walletPublicKeyHex` 字段。
 */

/**
 * 持久化的 connect session 记录。
 *
 * 设计缘由（施工单 2026-06-28 002 硬切换 + 施工单 2026-06-30 002 硬切换）：
 *   - 这是 auth session 真值；**不**是 unlock runtime。
 *   - 允许持久化（platform K-V repository `connectSessions` store）。
 *   - **不**混入 pending request / 中间密文 / 解锁材料。
 *   - `revokedAt` 是被 `connect.logout` 主动吊销的时间戳；非空记录
 *     不允许 `connect.resume` 复活。
 *   - **owner 唯一真值 = `ownerPublicKeyHex`**。`ownerKeyId` **不允许**
 *     出现在 session record / request record / result payload / fee pool
 *     key / service 分支判断里——它会制造第二套 owner 身份。Vault 内部
 *     借用句柄按需从 walletState 解析，**不**落 session 持久化。
 *   - **不**持久化执行 runtime 来源：`runtimeBinding` 已从 session
 *     真值里删掉。同一 session 在窗口生命周期内可以从
 *     `bootstrap_runtime` 切到 `vault_runtime`——这是允许的；
 *     持久化来源会阻止这条切换路径。runtime 来源是窗口内运行时状态，
 *     不是业务真值。
 *
 * 关键不变量：
 *   - `ownerPublicKeyHex` 在创建后**不**可变（resume 不重新选 key）。
 *   - origin / sessionId / ownerPublicKeyHex 三元组是 session 的稳定真值。
 *   - 执行 owner 解析时按 `sessionId -> ownerPublicKeyHex` 走
 *     `resolveOwnerRuntime(session)`，统一在
 *     `bootstrap_runtime | vault_runtime` 两条来源里挑当前可用的那条。
 */
export interface ConnectSessionRecord {
  networkIdentity: import("./networkIdentity.js").NetworkIdentity;
  /** 内部缓存与付款核算键：由网络、公钥、来源确定性压缩，不作为公开授权编号。 */
  sessionId: string;
  /** exact event.origin；connect.resume / 业务方法必须严格匹配。 */
  origin: string;
  /** 绑定 key 的压缩公钥 hex；session 创建后不变。owner 唯一真值。 */
  ownerPublicKeyHex: string;
  /** 绑定 key 的 label 快照（仅展示用，不参与身份判定）。 */
  ownerLabel: string;
  /**
   * identity.get 解析时返回的 claims 真值快照（本次 connect.login / 启动
   * bootstrap 时取一次）。site 后续 `connect.resume` 拿同一份快照，不必
   * 再发一次 `identity.get`。
   */
  claimsSnapshot: Record<string, ResolvedClaimValue>;
  /**
   * 创建时间，unix milliseconds。
   */
  createdAt: number;
  /** 最近一次使用时间（resume / 业务方法命中都会刷新）。 */
  lastUsedAt: number;
  /** 吊销时间；null = 未吊销。 */
  revokedAt: number | null;
  /** Keymaster 本地 catalog metadata 信任快照；digest 是稳定指纹而非签名证明。 */
  appIdentity?: AppIdentitySnapshot;
}

/**
 * `connect.login` 请求参数。
 *
 * 设计缘由（施工单 2026-06-28 001 硬切换 5.1.1）：
 *   - **不**在 params 里携带 ownerPublicKeyHex：owner 是用户**在 popup
 *     UI 上**选定的，service 不能代替 caller 决定。
 *   - caller 发起 `connect.login` 时只需要传 `text` + 可选 `claims`；
 *     popup 解锁后展示 ready key 列表给用户选；用户点"用此 key 登录"
 *     后由 UI 调 `service.confirmConnectLogin(recordId, ownerPublicKeyHex, password)`
 *     写入 service 内部 record。
 *   - `origin` 仍按 `event.origin` 由 service 在执行时填，params 里
 *     不允许覆盖。
 *   - `text` 与 `claims` 与 `identity.get` 语义一致；本次 connect.login
 *     实际上跑了一次 `identity.get` 取真值快照，存进 session 持久化。
 */
export interface ConnectLoginParams {
  /** 人类可读确认文案。 */
  text: string;
  /**
   * 请求索要的 claim 名列表（与 `identity.get` 同语义）。
   * 缺省 = `[]`，不返回任何 claim；通常 caller 想获取 profile.* 时必须显式列出。
   */
  claims?: string[];
  /** 发布者签名的 caller identity proof；缺省时建立无 storage 的普通 session。 */
  appIdentity?: AppIdentityProofV1;
}

/**
 * `connect.login` 成功结果。
 *
 * 返回公钥与 claims 快照；后续请求复用公钥、网络及浏览器实际来源定位身份。
 *
 * 关键（施工单 2026-06-28 002 硬切换 + 硬切换 002 收尾）：**不**再返回
 * `ownerKeyId`。owner 唯一真值 = `ownerPublicKeyHex`；vault 不再保留
 * 任何 key 域 surrogate id（硬切换 002 后连内部借用句柄也按 hex 走）。
 */
export interface ConnectLoginResult {
  networkIdentity: import("./networkIdentity.js").NetworkIdentity;
  /** 钱包压缩公钥；后续请求用它定位身份。 */
  walletPublicKeyHex: string;
  /** 绑定 key 的压缩公钥 hex；与 session 记录内字段一致。 */
  ownerPublicKeyHex: string;
  /** 本次 login 时一次解析的 claims 真值快照。 */
  resolvedClaims: Record<string, ResolvedClaimValue>;
  /** 本次解析时间（unix milliseconds）。 */
  resolvedAt: number;
  appIdentity?: AppIdentitySnapshot;
}

/**
 * `connect.resume` 请求参数。
 *
 * resume 显式传入钱包公钥；本地记录为空时按当前 Key 重建缺省连接。
 * 可重新验证外部 App proof，不恢复已被重置的本地设置。
 */
export interface ConnectResumeParams {
  /** 本地数据重置后重新验证已有发行人签名 proof。 */
  appIdentity?: AppIdentityProofV1;
  /**
   * 由 `connect.login` 返回的钱包公钥。
   * caller 持公钥，popup 的运行句柄独立受会话世代约束。
   */
  walletPublicKeyHex: string;
}

/**
 * `connect.resume` 成功结果。
 *
 * 返回钱包公钥与当前 claims 快照；新建缺省连接的 claims 为空。
 *
 * 关键（施工单 2026-06-28 002 硬切换）：**不**再返回 `ownerKeyId`。
 */
export interface ConnectResumeResult {
  networkIdentity: import("./networkIdentity.js").NetworkIdentity;
  walletPublicKeyHex: string;
  ownerPublicKeyHex: string;
  resolvedClaims: Record<string, ResolvedClaimValue>;
  /**
   * 解析时间——本次 resume 时间戳，**不**是 connect.login 时的快照时间。
   * 给 caller 用来做"是否要重新登录"的客户端超时策略。
   */
  resolvedAt: number;
  appIdentity?: AppIdentitySnapshot;
}

/**
 * `connect.logout` 请求参数。
 *
 * logout 按钱包公钥和实际来源撤销本地连接。
 */
export interface ConnectLogoutParams {
  walletPublicKeyHex: string;
}

/**
 * `connect.logout` 成功结果。
 *
 * 设计缘由：返回 ok=true 即表示 session 已被吊销；不需要返回 claims。
 */
export interface ConnectLogoutResult {
  walletPublicKeyHex: string;
  /** 吊销时间（unix milliseconds）。 */
  revokedAt: number;
}

/**
 * connect method 在 popup 当前文档处于 `waiting_unlock_*` 时进入的"选 key"
 * UI 行为约束。
 *
 * 设计缘由：login / resume 现在由统一 auth owner 快照仲裁；login 是
 * 重新认证并新建 session，resume 是恢复既有 session。
 */
export type ConnectRequestKind = "login" | "resume" | "logout" | "launch";

/**
 * connect auth owner 的只读快照。
 *
 * 设计缘由：
 *   - popup 任一时刻只允许一个 auth owner 控制全屏 auth 页；
 *   - login / resume 的仲裁真值由 service 决定，UI 只读这个快照渲染；
 *   - `canSubmit` 反映 service 侧是否已具备提交条件（login: 候选 key
 *     是否存在；resume: 只读会话是否有效）。
 */
export interface ProtocolConnectAuthSnapshot {
  /** 钱包已提交后端；硬件认证不展示或传输 PIN。 */
  backend?: "software" | "hardware";
  /** 当前 auth owner 类型；`null` 表示没有 auth owner。 */
  ownerType: "login" | "resume" | null;
  /** 当前 auth owner 对应的 recordId；无 owner 时为 null。 */
  recordId: string | null;
  /** service 侧当前是否已具备提交条件。 */
  canSubmit: boolean;
  /** 当前 auth 请求是否已经提交过；用于 UI 呈现 busy / 禁用态。 */
  submitted: boolean;
  /** Current single wallet; no wallet selection. */
  login: {
    recordId: string;
    wallet?: { publicKeyHex: string; label: string };
  } | null;
  /** resume auth owner 的只读会话信息；无 resume owner 时为 null。 */
  resume: {
    recordId: string;
    ownerPublicKeyHex: string;
    ownerLabel: string;
  } | null;
}

/* ============== connect.launch（施工单 2026-06-29 001 硬切换） ============== */

/**
 * `connect.launch` 请求参数。
 *
 * 设计缘由（施工单 2026-06-29 001 硬切换）：
 *   - `connect.launch` 是 `appView` mode 下 client app 的**唯一**首登
 *     入口；消费 launcher 交给 client app 的 `launchToken`。
 *   - 不传 aud / iat / exp —— login 时机由 launcher 一次性 bootstrap 阶段
 *     决定；launch 自身只验 token + 走 sessionRecord 落库；不重新选 key，
 *     不重新认证。
 *   - 失败时按 fail-closed：launchToken 缺失 / 已消费 / 当前 Session Window
 *     不在 `appView` mode / caller origin 与 bootstrap 期记录不一致 → 拒掉；
 *     不允许 fallback 到 `connect.login`。
 *   - 成功结果形状与 `connect.login` 对齐，便于 caller 走同一套"持久化
 *     walletPublicKeyHex、完整网络身份 + 后续 connect.resume / cipher.*"路径。
 */
export interface ConnectLaunchParams {
  /** 由 launcher 写入 client app 启动 URL 的 launchToken。一次性消费。 */
  launchToken: string;
  /** 与 launcher 预建 session 绑定的完整签名 proof。 */
  appIdentity: AppIdentityProofV1;
}

/** `connect.launch` 成功结果（与 `connect.login` 对齐）。 */
export interface ConnectLaunchResult {
  networkIdentity: import("./networkIdentity.js").NetworkIdentity;
  walletPublicKeyHex: string;
  ownerPublicKeyHex: string;
  resolvedClaims: Record<string, ResolvedClaimValue>;
  resolvedAt: number;
  appIdentity?: AppIdentitySnapshot;
}

/* ============== channel.*（施工单 2026-09-02） ============== */

/** 发布到任意精确 SSP channel。owner、签名、消息编号和时间由系统生成。 */
export type ChannelPublishParamsV1 = ChannelPublishParams;
export type ChannelPublishResultV1 = ChannelPublishResult;

/** 替换当前 Connect caller 的精确频道订阅集合。 */
export type ChannelSubscriptionSetParamsV1 = ChannelSubscriptionSetParams;
export type ChannelSubscriptionSetResultV1 = ChannelSubscriptionSetResult;


/* ============== plugin-apps launcher 启动入口（施工单 2026-06-29 002 硬切换） ============== */

/**
 * `protocol.service.launchAppView(...)` 的入参。
 *
 * 设计缘由（施工单 2026-06-29 002 硬切换）：
 *   - 这是 `plugin-apps` **唯一**允许调用的 appView 启动入口；plugin-apps
 *     自己不操作协议存储、运行句柄或开窗；主钱包宿主接管外部应用连接。
 *   - `appOrigin` 必须是 exact origin；`new URL(appUrl).origin` 必须
 *     === `appOrigin`，否则视为配置错误、整次启动 fail-closed。
 *   - `claims` 是 launcher 期望在 `connect.login` 时一次解析的 claim
 *     列表；与 `identity.get.claims` 同语义。V1 不传时取空数组。
 */
export interface LaunchAppViewInput {
  /** app 注册 id，例如 "justnote"。 */
  appId: string;
  /** app 的 exact origin（必须等于 `new URL(appUrl).origin`）。 */
  appOrigin: string;
  /** client app 真正打开的 URL（appView bootstrap 后会带上 `?launchToken=`）。 */
  appUrl: string;
  /** 解锁 appView 专属 session 所需的 Vault 密码。 */
  password: string;
  /**
   * 期望在 connect.login 快照的 claim 列表；与 `connect.login.claims`
   * 同语义。V1 不传时取空数组。
   */
  claims?: string[];
  /** launcher 从本地 catalog 绑定的签名 proof；调用方不能自报覆盖。 */
  appIdentity: AppIdentityProofV1;
}

/**
 * `protocol.service.launchAppView(...)` 的成功结果。
 *
 * 设计缘由（施工单 2026-06-29 002 硬切换）：
 *   - 成功意味着 launcher 已完成整套：vault 已解锁校验 + owner key 已 ready
 *     校验 + app 配置合法 + 预建 connect session + 创建 App 专属 crypto capability +
 *     生成 launchToken + 注册主钱包连接宿主 + 打开外部 App 窗口。
 *   - 启动失败（任何一道闸）一律 throw，不返回 `appWindowOpened=false`
 *     的"半成功"语义——避免业务插件"先显示成功，再去查"等隐式兼容路径。
 *   - 返回的 `appUrl` 是已拼上 `?launchToken=<id>` 的真实打开 URL；
 *     `plugin-apps` 仅作展示用，**不**自己再去 `window.open(appUrl)`。
 */
export interface LaunchAppViewResult {
  networkIdentity: NetworkIdentity;
  /** 外部 App 窗口已打开；不创建中间 Session Window。 */
  appWindowOpened: boolean;
  /** launcher 已确认的钱包公钥；与 networkIdentity 一起定位身份。 */
  walletPublicKeyHex: string;
  /** 本次为该 app 生成的 launchToken；client app 首条 `connect.launch` 消费。 */
  launchToken: string;
  /** 已拼上 `?launchToken=<id>` 的 client app URL。 */
  appUrl: string;
}

/**
 * `protocol.service.launchAppView(...)` 失败时抛出的 typed error。
 *
 * 设计缘由（施工单 2026-06-29 002 硬切换 + 用户反馈）：
 *   - 内部异常文案（`"launchAppView: vault not unlocked"` 等）属于实现
 *     细节，**不**应该直接展示给用户。
 *   - UI 按 `code` 字段映射到对应 i18n 文案，并给出"先解锁 / 允许弹窗 /
 *     配置错误"等明确指引。
 *   - 收口在 `protocol.service` 内部，**不**让业务插件自己解析 error
 *     message 字符串。
 *   - 失败一律 fail-closed：service **不**补偿、不回退、不半启动；UI 仅
 *     按 code 渲染错误态。
 */
export type LaunchAppViewErrorCode =
  /** vault 当前已锁定；提示用户先解锁 Keymaster。 */
  | "vault_locked"
  /** 当前没有可用的 active key / owner key 不 ready。 */
  | "no_active_key"
  /** app 配置非法（appUrl 非法 / appOrigin 与 appUrl 不一致）。 */
  | "invalid_app_config"
  /** catalog metadata requirement 未满足（例如 Storage 尚未 ready）。 */
  | "requirement_unavailable"
  /** 当前运行环境不支持 window / window 不可用。 */
  | "window_unavailable"
  /** connect session 存储不可用。 */
  | "session_storage_unavailable"
  /**
   * 借 owner 私钥 / 准备 owner runtime bootstrap 失败（施工单
   * 2026-06-30 002）。
   *
   * 设计缘由：launcher 通过受控 owner capability 准备 owner runtime
   * bootstrap。拿不到 capability / owner 状态不匹配时回这个 code。
   */
  | "export_owner_runtime_failed"
  /** `window.open` 抛出异常。 */
  | "open_session_window_failed"
  /** `window.open` 返回 null（被浏览器拦截 / 被禁用）。 */
  | "open_session_window_blocked"
  /** 内部未知错误兜底。 */
  | "internal_error";

export class LaunchAppViewError extends Error {
  readonly code: LaunchAppViewErrorCode;
  constructor(code: LaunchAppViewErrorCode, message: string) {
    super(message);
    this.name = "LaunchAppViewError";
    this.code = code;
  }
}

/* ============== Session Window 的 appView 当前上下文（仅 UI / 启动用） ============== */

/**
 * Session Window 的 appView 当前上下文（仅 UI / 启动用）。
 *
 * 设计缘由（施工单 2026-06-29 001 硬切换）：
 *   - 这是 Session Window 当前服务的 app 上下文；用来渲染 UI、决定打开
 *     client app 的 URL、校验 `connect.launch` 的 caller origin。
 *   - 仅在 Session Window 处于 `appView` mode 且 bootstrap 成功后非空；
 *     `connect` mode 下恒为 null。
 */
export interface AppViewContext {
  appId: string;
  appOrigin: string;
  /** 启动 client app 用的 URL（含 launchToken）。 */
  appUrl: string;
  /** bootstrap 时 launcher 已建的 walletPublicKeyHex。 */
  walletPublicKeyHex: string;
  /** bootstrap 时锁定的 owner public key hex。 */
  ownerPublicKeyHex: string;
  /** bootstrap 时一次解析的 claims 快照。 */
  resolvedClaims: Record<string, ResolvedClaimValue>;
  /** bootstrap 时间（unix milliseconds）。 */
  resolvedAt: number;
  appIdentity?: AppIdentitySnapshot;
}

/** 主钱包为目录启动的单个 App 创建的受控 crypto 句柄，仅保留在当前钱包内存。
 * 句柄自动绑定原钱包/运行代际；不交接 raw 私钥，不写 URL 或持久历史。
 */
export interface SessionRuntimeBootstrap {
  networkIdentity: import("./networkIdentity.js").NetworkIdentity;
  /** 绑定 key 的压缩公钥 hex；与 payload.ownerPublicKeyHex 必须一致。 */
  ownerPublicKeyHex: string;
  /** 绑定 key 的 label（仅展示用）。 */
  ownerLabel: string;
  /** 该 runtime 拥有的能力列表（例如 `["p2pkh"]`）；与 vault KeyRef capabilities 对齐。 */
  capabilities: string[];
  /** runtime 创建时间，unix milliseconds。 */
  createdAt: number;
  /** 受控 active-key capability；不暴露 raw 私钥材料。 */
  crypto: ActiveKeyCrypto;
}

/** 主钱包内部的 App 启动材料；不经 registry、postMessage 或另一个钱包页面传递。
 * 只有一次性 launchToken 与钱包精确 origin 注入外部 App URL。
 */
export interface AppBootstrapPayload {
  networkIdentity: import("./networkIdentity.js").NetworkIdentity;
  /** 当前 app 信息（仅 UI / 启动用）。 */
  app: {
    appId: string;
    appOrigin: string;
    appUrl: string;
  };
  /** launcher 已确认的钱包公钥。 */
  walletPublicKeyHex: string;
  ownerPublicKeyHex: string;
  resolvedClaims: Record<string, ResolvedClaimValue>;
  resolvedAt: number;
  appIdentity?: AppIdentitySnapshot;
  /** 主钱包内缓存的一次性 token；外部 App 用 connect.launch 消费。 */
  launchToken: string;
  /**
   * 本次 session 绑定 owner 的 owner runtime bootstrap（施工单
   * 2026-06-30 002 硬切换）。
   *
   * 主钱包连接宿主只在当前内存注册该受控句柄，不写长期存储，不导入 unlock runtime。
   */
  sessionRuntimeBootstrap: SessionRuntimeBootstrap;
}

/**
 * Owner execution runtime 当前来源（施工单 2026-06-30 002 硬切换）。
 *
 * 设计缘由：
 *   - `runtimeBinding` 已从 `ConnectSessionRecord` 删除；
 *     runtime 来源不再落库，不再作执行路径二分。
 *   - connect mode 的同一 session 在 Session Window 生命周期内可以从
 *     `bootstrap_runtime` 切到 `vault_runtime`：
 *       - 启动早期 `bootstrap_runtime`：launcher 一次性注入的 owner
 *         capability，足够跑 `identity.*` / `intent.sign` / `cipher.*` /
 *         `p2pkh.transfer` / `feepool.*`。
 *       - 本窗口用户后续 unlock + vault owner 可读 → `vault_runtime`：
 *         从本地 vault 按 `ownerPublicKeyHex` 重建 owner runtime，
 *         覆盖 `bootstrap_runtime` 的同一把 owner；服务外部行为一致。
 *   - appView mode 不允许把 `bootstrap_runtime` 缺失当成可恢复态；
 *     bootstrap 失败必须 fail-closed，不能回退到 `vault_runtime`。
 *   - 这是窗口内运行时状态 + 调试信息；**不**是 session 业务真值，
 *     **不**影响 cipher.* / p2pkh.transfer 的对外语义。
 */
export type OwnerRuntimeSource = "bootstrap_runtime" | "vault_runtime";

/**
 * 统一 owner execution runtime 接口。
 *
 * 设计缘由：
 *   - 业务方法（`identity.*` / `intent.sign` / `cipher.*` /
 *     `p2pkh.transfer` / `feepool.*`）只通过受控 capability 持有 owner 真值；
 *     业务方法**不**知道也不依赖 `source` 是哪一条。
 *   - `bootstrap_runtime` 来源：launcher 在 Session Window 启动早期注入；
 *     `vault_runtime` 来源：仅 connect mode 下，本窗口用户后续 unlock 后
 *     从 vault 重建。两条路径对外行为一致，但 appView mode 不允许
 *     在 bootstrap 缺失时回退到 `vault_runtime`。
 *   - 解析入口 `resolveOwnerRuntime(session)`：
 *     `bootstrap_runtime` → connect mode 的 `vault_runtime` → 解析失败。
 *     解析失败时业务方走 fail-fast（不再 fallback 到 vault 或活动
 *     active key）。
 *   - `ownerPublicKeyHex` 是返回值上的唯一标识；执行时与
 *     `session.ownerPublicKeyHex` 严格比对。
 */
export interface OwnerExecutionRuntime {
  /** 会话绑定 owner 的压缩公钥 hex；与 session.ownerPublicKeyHex 一致。 */
  ownerPublicKeyHex: string;
  /** 当前 owner runtime 来源（仅调试 / 日志用，业务方不依赖）。 */
  source: OwnerRuntimeSource;
  /** 受控 capability；不暴露 raw 私钥材料。 */
  crypto: ActiveKeyCrypto;
}

/* ============== Method dispatch ============== */

/**
 * 方法 -> 请求参数类型 的映射。`MethodParams<M>` 是计算出的参数类型。
 * 业务代码里直接 `MethodParams<"identity.get">` 等价于 `IdentityGetParams`。
 */
export interface MethodParamsMap {
  "payment.channel.register": PaymentChannelRegisterParams;
  "identity.get": IdentityGetParams;
  "intent.sign": IntentSignParams;
  "cipher.encrypt": CipherEncryptParams;
  "cipher.decrypt": CipherDecryptParams;
  "p2pkh.transfer": P2pkhTransferParams;
  "payment.pay": PaymentPayParams;
  "payment.status": PaymentStatusParams;
  "feepool.prepare": FeepoolPrepareParams;
  "feepool.commit": FeepoolCommitParams;
  "connect.login": ConnectLoginParams;
  "connect.resume": ConnectResumeParams;
  "connect.logout": ConnectLogoutParams;
  "connect.launch": ConnectLaunchParams;
  "channel.publish": ChannelPublishParams;
  "channel.subscription_set": ChannelSubscriptionSetParams;
  "storage.list": StorageListParams;
  "storage.directory.create": StorageDirectoryParams;
  "storage.directory.delete": StorageDirectoryParams;
  "storage.put": StoragePutParams;
  "storage.get": StorageGetParams;
  "storage.delete": StorageDeleteParams;
  "msfile.stat": MsFileStatParams;
  "msfile.seed.read": MsFileSeedReadParams;
  "msfile.block.read": MsFileBlockReadParams;
}

export type MethodParams<M extends ProtocolMethod> = M extends keyof MethodParamsMap
  ? MethodParamsMap[M]
  : never;

export interface MethodResultMap {
  "payment.channel.register": PaymentChannelRegisterResult;
  "identity.get": IdentityGetResult;
  "intent.sign": IntentSignResult;
  "cipher.encrypt": CipherEncryptResult;
  "cipher.decrypt": CipherDecryptResult;
  "p2pkh.transfer": P2pkhTransferResult;
  "payment.pay": PaymentPayResult;
  "payment.status": PaymentStatusResult;
  "feepool.prepare": FeepoolPrepareResult;
  "feepool.commit": FeepoolCommitResult;
  "connect.login": ConnectLoginResult;
  "connect.resume": ConnectResumeResult;
  "connect.logout": ConnectLogoutResult;
  "connect.launch": ConnectLaunchResult;
  "channel.publish": ChannelPublishResult;
  "channel.subscription_set": ChannelSubscriptionSetResult;
  "storage.list": StorageListResult;
  "storage.directory.create": StorageDirectoryResult;
  "storage.directory.delete": StorageDirectoryResult;
  "storage.put": StoragePutResult;
  "storage.get": StorageGetResult;
  "storage.delete": StorageDeleteResult;
  "msfile.stat": MsFileStatResult;
  "msfile.seed.read": MsFileReadResult;
  "msfile.block.read": MsFileReadResult;
}

export type MethodResult<M extends ProtocolMethod = ProtocolMethod> = M extends keyof MethodResultMap
  ? MethodResultMap[M]
  : never;

/** Wire parameters never select a wallet or its network. Internal execution parameters
 * above carry receiver-derived authorization context, not caller-supplied identity. */
type PublicBusinessParams<T> = Omit<T, "walletPublicKeyHex" | "assetId">;
export type ConnectWireParams<M extends ProtocolMethod = ProtocolMethod> = M extends ConnectPublic.ProtocolMethod
  ? ConnectPublic.MethodParams<M> : M extends ProtocolMethod ? PublicBusinessParams<MethodParamsMap[M]> : never;
/** Receiver-generated wire event context; internal event producers do not choose it. */
export type ConnectWireEvent = ConnectPublic.ProtocolEventMessage;
export type ConnectWireResult<M extends ProtocolMethod = ProtocolMethod> = M extends ConnectPublic.ProtocolMethod
  ? ConnectPublic.MethodResult<M> : M extends ProtocolMethod ? MethodResultMap[M] : never;

/* ============== popup 命令流（施工单 002：popup 复用与命令流） ============== */

/**
 * popup 命令卡状态。**不**与"会话生命周期"耦合——一条命令从收到
 * 合法 request 走到最终决定（approved / rejected / failed），状态
 * 由 service 在状态推进时同步更新。
 *
 * 历史 K-V 持久化的是 `ProtocolCommandRecord.phase` / `status` /
 * `decision` 三个收敛点；中间态只在内存里走，不一定都落库。
 *
 * 设计缘由（施工单 2026-06-27 001 硬切换：锁屏 + 多 request 并存 +
 * 串行执行）：
 *   - request 状态独立于"会话锁状态"（`ProtocolPopupLockState`），不再
 *     共享一个中心 phase；这样 manual / auto 在锁屏时分别落到不同的
 *     `waiting_unlock_*` 状态，互不干扰。
 *   - 引入 `waiting_unlock_manual` / `waiting_unlock_auto` 两种"等待
 *     解锁"状态：manual 等解锁后继续走 manual confirm 路径；
 *     `waiting_unlock_auto` 等解锁后跳过 confirming 直接进入 queued。
 *   - 引入 `queued`：用户已确认、待执行；`executing` 是当前唯一正在
 *     执行的一条。queued 是 FIFO 等待。
 *   - `timed_out` 是"超时"专用终态，与 `failed` 平级但 `status` 字段
 *     单独区分。
 *   - 兼容旧 `waiting_unlock` / `waiting_confirm`：保留作为 alias，
 *     让 K-V 旧记录仍能被新逻辑识别。
 */
export type ProtocolCommandPhase =
  | "waiting_unlock"
  | "waiting_unlock_manual"
  | "waiting_unlock_auto"
  | "waiting_confirm"
  | "confirming"
  | "queued"
  | "executing"
  | "approved"
  | "rejected"
  | "failed"
  | "timed_out";

/** 命令终态判定。中间态：waiting_unlock / waiting_confirm / executing。 */
export type ProtocolCommandDecision = "pending" | "approved" | "rejected" | "failed";

/**
 * popup 内"按 origin 归档"的一条命令记录。
 *
 * 设计缘由（施工单 002 硬切换 + 施工单 2026-06-28 002 硬切换）：
 *   - 一条 request = 一条 `ProtocolCommandRecord`；
 *   - 不做 event-sourcing：状态推进直接更新同一条记录；
 *   - 历史只按 `origin`（exact origin，**不**做 host 归一化）归档；
 *   - K-V 真值 = Keymaster platform K-V repository；UI 文案可显示"站点 / 域名"，
 *     但 K-V 落盘必须是 `event.origin` 原样字符串。
 *   - 不持久化私钥 / 大体积密文 / 完整签名结果 / 解密明文 / 完整 rawTx。
 *   - **owner 唯一真值 = `ownerPublicKeyHex`**：所有业务方法在 record
 *     创建时即快照 `walletPublicKeyHex` + `ownerPublicKeyHex`；执行时不再
 *     改写归属。`ownerKeyId` 不再出现。
 *
 * 字段语义扩展（p2pkh + feepool + connect）：
 *   - `recipientAddress` / `amountSatoshis` 摘要显示用；不要把整笔交易存进来。
 *   - `action` 只在 feepool.prepare/commit 上填写。
 *   - `operationId` 只在 feepool.commit 上填写（指向 prepare 阶段产的 op）。
 *   - `counterpartyPublicKeyHex` 只在 feepool.prepare/commit 上填写。
 *   - `walletPublicKeyHex` 业务方法（除 `connect.login`）必填；记录创建时
 *     绑定一次，执行时再次校验。`connect.login` record 上该字段为空。
 *   - `failureReason` 是本地终态原因（写本地）；对外 `errorCode` 永远是 `user_rejected`。
 *   - `autoApproved` 在 p2pkh.transfer / feepool.* / identity.get / cipher.*
 *     auto 命中时为 true；UI 据此隐藏 confirm 页。
 */
export interface ProtocolCommandRecord {
  /** 内部稳定主键；与 transport `requestId` 同源但不一定相等。 */
  id: string;
  /** exact origin（popup 接收到的 `event.origin` 原样）。 */
  origin: string;
  /** 当前绑定的 transport request id（如果还在 request 上下文里）。 */
  requestId: string;
  /** 协议方法名。 */
  method: ProtocolMethod;
  /** 当前命令阶段。中间态不持久化；只在终态落库。 */
  phase: ProtocolCommandPhase;
  /** 终态决策；中间态为 `pending`。 */
  decision: ProtocolCommandDecision;
  /** 与 `decision` 类似的稳定字符串，给 UI 直接展示用。
   *
   * 合法值（施工单 003 收口：timeout 在终态里单独区分）：
   *   - 中间态：`"waiting_unlock"` / `"waiting_confirm"` / `"executing"`
   *   - 终态：`"approved"` / `"rejected"` / `"failed"`
   *   - 终态超时（施工单 003）：`"timed_out"`
   *     ——`phase = "failed"` + `decision = "failed"` + `status = "timed_out"`
   *     + `failureReason = "request_timeout"`。`status` 走 `"timed_out"`
   *     单独区分而不是套用 `"failed"`，让 UI 能直接把它翻成"超时"
   *     文案而不必再开新 phase 枚举。
   */
  status: string;
  /** 人类可读确认文案。 */
  textSummary: string;
  /** identity.get / connect.login 的请求 claims 列表（其它方法为空数组）。 */
  claimsSummary: string[];
  /** intent.sign / cipher.encrypt / cipher.decrypt 的内容类型。 */
  contentType: string;
  /** 请求正文字节数（cipher.decrypt 时是 `cipherbytes.bytes.byteLength`）。 */
  payloadSize: number;
  /**
   * 该 record 所属钱包公钥（业务方法必填；`connect.login` 确认前为空）。
   *
   * 关键不变量（施工单 2026-06-28 002 硬切换）：record 创建时立即绑定，
   * record 生命周期内**不**可漂移——不允许"旧请求漂进新 session"。
   */
  walletPublicKeyHex: string;
  /**
   * 该 record 在创建时快照的 owner public key hex。
   *
   * 关键不变量（施工单 2026-06-28 002 硬切换）：
   *   - 取自 `connectSession.ownerPublicKeyHex`（业务方法）或
   *     `connectLoginSelected`（connect.login）；
   *   - record 生命周期内**不**可变；
   *   - **不**再读取当前 active key；后续写卡**不**再读 walletState.snapshot()。
   *   - 这是 `ProtocolCommandRecord` 上的 owner 唯一真值；`ownerKeyId`
   *     **不**出现在 record / result payload 里。
   */
  ownerPublicKeyHex: string;
  /** 创建时间，unix milliseconds。 */
  createdAt: number;
  /** 最近一次状态更新时间，unix milliseconds。 */
  updatedAt: number;
  /** 终态时间，unix milliseconds；中间态为 0。 */
  finishedAt: number;
  /** 错误码（failed 时填写；隐私敏感场景统一填 `user_rejected`）。 */
  errorCode: string;
  /** 错误 message（failed 时填写，英文；隐私敏感场景统一填 `User rejected`）。 */
  errorMessage: string;
  /** p2pkh.transfer 收款地址（p2pkh.transfer 填写）。 */
  recipientAddress?: string;
  /** p2pkh.transfer / feepool.* 转账或池金额（satoshis）。 */
  amountSatoshis?: number;
  /** p2pkh.transfer / feepool.* 所属资产；UI 用于显示 BSV 或 BSV Testnet。 */
  assetId?: P2pkhTransferAssetId;
  /** feepool.prepare / feepool.commit 的 action。 */
  action?: ProtocolFeePoolAction;
  /** feepool.commit 的 operationId（指向 prepare 阶段产的 op）。 */
  operationId?: string;
  /** feepool.prepare / feepool.commit 的对端公钥 hex。 */
  counterpartyPublicKeyHex?: string;
  /** 本地终态原因；隐私敏感场景下与对外 `errorCode` 解耦。 */
  failureReason?: ProtocolFailureReason;
  /** p2pkh.transfer / feepool.* / identity.get / cipher.* auto-approve 命中时为 true。 */
  autoApproved?: boolean;
  /** 应用稳定归属；仅脱敏本地审计，不是协议授权凭据。 */
  applicationKey?: string;
  /** 人工批准时间，与业务执行成功/失败分开。 */
  manualApprovedAt?: number;
  /** 外部付款审批的真实冻结预览。 */
  paymentPreview?: import("./p2pkhConnectPayment.js").P2pkhConnectPaymentPreview;
  /** 付款执行结果与授权决定分开。 */
  paymentStatus?: ConnectPaymentStatus;
}

/**
 * popup 内"按当前 origin 归档"的命令流 feed 状态。
 *
 * service 维护的内部状态：每条合法 request 进入时按 `event.origin`
 * 重新载入历史；feed 列表是 service 派生的**展示投影**，**不**承诺
 * "全局按 `updatedAt desc`"。
 *
 * 设计缘由（施工单 2026-06-27 001 硬切换 + 施工单 2026-06-27 002 硬切换）：
 *   - 加 `lockSummary` 字段给锁屏页提供聚合视图；该字段是从
 *     `commands` 派生出来的，**不**是另一份可变状态。
 *   - `lockSummary` 字段在 unlocked 时是 null；锁屏页不读 commands 走
 *     自己摘要，命令流仍以 commands 为真相源。
 *   - **002 硬切换**：`commands` 的展示顺序固定为
 *       `活请求区（按 createdAt asc，recordId 次级稳定）
 *        + 历史区（按 updatedAt desc）`
 *     拼接后的投影。
 *   - **002 硬切换**：UI 不应再发明第二套排序规则；UI 仍可按
 *     `isTerminal` 在两端内部分组渲染，但顺序真值在 service 里。
 *   - **002 硬切换**：同类 request 在活请求区不复用卡位；
 *     第一条活卡进入终态后从活请求区离开，第二条活卡成为新的
 *     活请求区第一格——这是"前一条事务结束"的正常释放。
 */
export interface ProtocolCommandFeedState {
  /** 当前 popup 服务的 exact origin；未收到第一条 request 时为 null。 */
  currentOrigin: string | null;
  /**
   * 当前 feed 列表的**展示投影**（施工单 2026-06-27 002 硬切换）：
   *   - 未终态 record 在前：按 `createdAt asc` 稳定排序，
   *     `createdAt` 相同时按内部稳定 `recordId` 作次级稳定排序；
   *   - 终态 record 在后：按 `updatedAt desc` 排序。
   *
   * 不再承诺"全局最新在前"；UI 拿 `commands` 直接渲染，但 UI
   * **不**应再按索引决定唯一展开卡。
   */
  commands: ProtocolCommandRecord[];
  /** K-V 读 / 写是否可用；false 时 UI 顶部显示"历史不可用"。 */
  historyAvailable: boolean;
  /** 锁屏页用的待处理摘要；从 commands 派生；unlocked 时为 null。 */
  lockSummary: ProtocolLockSummary | null;
}

/**
 * 锁屏页用的待处理摘要（施工单 2026-06-27 001 硬切换）。
 *
 * 设计缘由：
 *   - 不维护第二份可变状态；它由 service 从 `ProtocolCommandFeedState.commands`
 *     在 `feedSnapshot()` / `lockSummarySnapshot()` 调用时刻聚合。
 *   - `byMethod` 用 method 名做 key，value 是该方法在当前未终态记录里
 *     出现的次数；与历史终态记录无关。
 *   - `counts` 给出按"分类"聚合的数字（manual / auto / queued / executing），
 *     锁屏页可按需展示。
 */
export interface ProtocolLockSummary {
  /** 当前未终态（`waiting_unlock_*` / `confirming` / `queued` / `executing`）总数。 */
  pendingTotal: number;
  /** 待解锁后人工确认的 request 数。 */
  waitingUnlockManual: number;
  /** 解锁后自动执行的 request 数。 */
  waitingUnlockAuto: number;
  /** 已确认待执行的 request 数。 */
  queued: number;
  /** 当前正在执行的 request 数（同一时刻最多 1）。 */
  executing: number;
  /** 按 method 聚合的待处理数。 */
  byMethod: Array<{ method: ProtocolMethod; count: number }>;
}

/**
 * 锁屏摘要对外只读查询接口（施工单 2026-06-27 001 硬切换）。
 *
 * 与 `feedSnapshot()` 的关系：
 *   - `feedSnapshot().lockSummary` 在 locked 时是该摘要，unlocked 时为 null；
 *     这是 UI 锁屏页首选入口。
 *   - `lockSummarySnapshot()` 是 service 暴露的独立只读 getter，行为与
 *     `feedSnapshot().lockSummary` 一致；调用方择一即可。
 */

/**
 * Session Window 会话级锁状态（施工单 2026-06-27 001 硬切换 + 2026-06-30 003 硬切换）。
 *
 * 设计缘由（施工单 2026-06-30 003 硬切换 4.5）：
 *   - 公开语义从"本地 vault 是否已解锁"收口为
 *     "当前 Session Window 是否拥有可执行 owner runtime"。
 *   - `locked`
 *     = 当前 Session Window 没有可执行 owner runtime
 *   - `unlocked`
 *     = 当前 Session Window 已有可执行 owner runtime
 *   - 可执行 owner runtime 来源有两种：
 *       1. `bootstrap_runtime`：launcher / bootstrap 继承过来的 owner runtime
 *          （appView mode 下 `applyLauncherBootstrap` 注册到
 *          `ownerRuntimesBySessionId` 后即对当前窗口持续有效）；
 *       2. `vault_runtime`：仅 connect mode 下，本窗口用户后续通过本地 vault
 *          解锁得到的 owner runtime。
 *   - connect mode 下 UI / accept 阶段据此决定渲染锁屏页还是主 popup；
 *     appView mode 只依赖 bootstrap runtime，bootstrap 缺失必须 fail-closed。
 *   - accept 阶段据此决定 request
 *     推进到 `confirming` / `queued` 还是 `waiting_unlock_*`。
 */
export type ProtocolPopupLockState = "locked" | "unlocked";

/**
 * 命令流 K-V capability key。manifest 在 setup 阶段 provide；
 * ProtocolService 通过 ctx 注入，**不**直接 import K-V 模块。
 */
export const PROTOCOL_COMMAND_REPOSITORY_CAPABILITY = defineCapability<Record<string, unknown>>({
  kind: "local",
  id: "protocol.commandRepository",
  version: "1",
});

/**
 * 协议存储 K-V capability key。
 *
 * 设计缘由（施工单 002 硬切换）：原 command repository capability 只承载
 * commands store；本次把 K-V 升级到 3 store（commands / origins / feePools），
 * capability 同步改名。manifest 在 setup 阶段 provide，service 通过 deps
 * 注入，**不**直接 import K-V 模块。
 */
export const PROTOCOL_STORAGE_REPOSITORY_CAPABILITY = defineCapability<ProtocolStorageRepository>({
  kind: "local",
  id: "protocol.storageRepository",
  version: "1",
});

/**
 * 协议存储 K-V 抽象。实现走 platform K-V repository；测试用 `fake-indexeddb`。
 *
 * 关键不变量：
 *   - K-V 名固定 `protocol storage namespace`。施工单 2026-07-01 001 硬切换：
 *     物理删除 `storageProviderConfig` store；K-V version 升 9。
 *   - 五 store 各司其职：
 *       - `commands`：命令流历史（一条 request = 一条 record）；
 *       - `origins`：按 exact origin 存站点级配置；
 *       - `feePools`：按
 *         `${origin}::${ownerPublicKeyHex}::${counterpartyPublicKeyHex}`
 *         复合 key 存费用池状态（v5 补 ownerPublicKeyHex 维度）；
 *       - `connectSessions`：auth session 真值（按 sessionId 主键）；
 *       - `launchTokens`：launcher 给 client app 的一次性凭证缓存。
 *   - commands store 索引按 `origin + updatedAt desc`；
 *   - feePools store 索引 `origin`，便于按 origin 列出该站点的所有池；
 *   - connectSessions store 索引 `origin`，便于按 origin 列出该站点的
 *     所有 session（包括已 revoked）；
 *   - `putCommand` / `putOrigin` / `putFeePool` / `putConnectSession`
 *     写同 key 覆盖；
 *   - K-V 异常一律 `console.error + rethrow`；调用方决定怎么降级（p2pkh
 *     走 manual confirm、feepool fail-closed、connect session 不可用
 *     时 caller 被要求重新登录）。
 */
export interface ProtocolStorageRepository {
  listApplicationEvents?(): Promise<import("./applicationConnections.js").ApplicationConnectionEvent[]>;
  putApplicationEvent?(event: import("./applicationConnections.js").ApplicationConnectionEvent): Promise<void>;
  listApplications?(): Promise<import("./applicationConnections.js").ConnectedApplication[]>;
  putApplication?(application: import("./applicationConnections.js").ConnectedApplication): Promise<void>;
  /** Connect 外部应用许可；独立于钱包内部审批和会话。 */
  getApplicationPermissions?(key: string): Promise<{ key: string; methods: ProtocolMethod[]; updatedAt: number } | null>;
  setApplicationPermission?(key: string, method: ProtocolMethod, enabled: boolean): Promise<void>;
  /** 全量脱敏历史，用于应用中心跨重启索引。 */
  listCommands?(): Promise<ProtocolCommandRecord[]>;
  /* ----- commands ----- */
  putCommand(record: ProtocolCommandRecord): Promise<void>;
  getCommand(id: string): Promise<ProtocolCommandRecord | null>;
  /** 按 exact origin 拉历史；按 `updatedAt desc` 排序。 */
  listCommandsByOrigin(origin: string): Promise<ProtocolCommandRecord[]>;

  /* ----- origins ----- */
  getOrigin(origin: string): Promise<ProtocolOriginSettingsRecord | null>;
  putOrigin(record: ProtocolOriginSettingsRecord): Promise<void>;
  /** 列出所有 origin 配置。 */
  listOrigins(): Promise<ProtocolOriginSettingsRecord[]>;

  /* ----- feePools ----- */
  getFeePool(poolKey: string): Promise<ProtocolFeePoolRecord | null>;
  putFeePool(record: ProtocolFeePoolRecord): Promise<void>;
  deleteFeePool(poolKey: string): Promise<void>;
  /** 按 origin 列出该站点下所有费用池。 */
  listFeePoolsByOrigin(origin: string): Promise<ProtocolFeePoolRecord[]>;

  /* ----- feePoolDeliveries (E01) ----- */
  /**
   * 持久记录一次对外交付的签名责任。必须在把签名字节交给站点之前写入；
   * 写失败时调用方必须拒绝交付。
   */
  putFeePoolDelivery(record: ProtocolFeePoolDeliveryRecord): Promise<void>;
  getFeePoolDelivery(id: string): Promise<ProtocolFeePoolDeliveryRecord | null>;
  /** 按 origin 列出该站点的全部未结算交付责任。 */
  listFeePoolDeliveriesByOrigin(origin: string): Promise<ProtocolFeePoolDeliveryRecord[]>;
  /** 标记一条交付责任已被可信观察结算。 */
  settleFeePoolDelivery(id: string, settledTxid: string, settledAt: number): Promise<void>;

  /* ----- connectSessions ----- */
  /**
   * 写一条 connect session 记录；同 sessionId 覆盖。
   *
   * **不**写密码 / 解锁运行时材料；只写 public 字段
   * （sessionId / origin / ownerPublicKeyHex / claimsSnapshot / 时间戳 /
   * revokedAt）。`connectSessions` store 不允许出现私钥材料或密码字段。
   */
  putConnectSession(record: ConnectSessionRecord): Promise<void>;
  /** 按完整网络身份和实际来源读取连接记录。 */
  getConnectSession(identity: import("./networkIdentity.js").NetworkIdentity, origin: string): Promise<ConnectSessionRecord | null>;
  /** 按 origin 列出该站点下所有 connect session（含 revoked）。 */
  listConnectSessionsByOrigin(origin: string): Promise<ConnectSessionRecord[]>;
  /**
   * 写一条新 connect session，并原子吊销同 origin 下其它仍有效 session。
   *
   * 设计缘由：connect.login 成功后要先落新 session，再把同 origin 旧
   * session 收口；这两个写入必须绑在同一条存储事务里，避免半成功。
   */
  putConnectSessionAndRevokeOriginPeers(record: ConnectSessionRecord): Promise<void>;

  /* ----- launchTokens（施工单 2026-06-29 001 硬切换） ----- */
  /**
   * 写一条 launchToken 记录；同 token 覆盖。
   *
   * 设计缘由：launchToken 是 launcher 给 client app 的一次性凭证；
   * Session Window 在 bootstrap 阶段把它连同 unlock runtime 一起接进
   * 当前内存上下文。**不**写 platform K-V repository——V1 显式要求 launchToken 只
   * 存在 Session Window 当前内存，刷新 / 关闭即失效。本接口保留
   * 为可选（实现可走内存 Map），便于将来如果需要"重启 launcher 后仍
   * 能恢复 launchToken"再开启持久化路径。
   */
  /* ----- Connect payment idempotency (CV1) ----- */
  getConnectPayment?(key: string): Promise<ProtocolConnectPaymentRecord | null>;
  /** CAS read: the value plus the partition revision needed for an atomic update. */
  getConnectPaymentEntry?(key: string): Promise<{ record: ProtocolConnectPaymentRecord; revision: number } | null>;
  /** 选币前原子认领；created=false 时返回既有记录，调用方不得重复执行。 */
  claimConnectPayment?(record: ProtocolConnectPaymentRecord, options?: { maxPending?: number }): Promise<{ created: boolean; record: ProtocolConnectPaymentRecord }>;
  putConnectPayment?(record: ProtocolConnectPaymentRecord): Promise<void>;
  /** CAS write used for monotonic payment status/fact updates. */
  putConnectPaymentIfRevision?(record: ProtocolConnectPaymentRecord, revision: number): Promise<void>;
  listConnectPaymentsByOrigin?(origin: string): Promise<ProtocolConnectPaymentRecord[]>;

  putLaunchToken?(record: LaunchTokenRecord): Promise<void>;
  /** 按 token 读一条记录；未消费时返回，未命中返回 null。 */
  getLaunchToken?(token: string): Promise<LaunchTokenRecord | null>;
  /** 标记 token 已消费（保留记录但 `consumed = true`）。幂等。 */
  consumeLaunchToken?(token: string): Promise<void>;
  /** 删除一条 token 记录。 */
  deleteLaunchToken?(token: string): Promise<void>;
}

/**
 * Launcher 给 client app 的一次性 launchToken 记录。
 *
 * 设计缘由（施工单 2026-06-29 001 硬切换）：
 *   - V1 **不**走持久化；service 内部以 `Map<token, record>` 持有。
 *   - 字段语义：
 *       * `token`：唯一 id；
 *       * `appId` / `appOrigin` / `appUrl`：UI / 启动决策用，与
 *         `AppViewContext` 同源；
 *       * `walletPublicKeyHex`：bootstrap 期 launcher 已建的 session；
 *       * `ownerPublicKeyHex`：bootstrap 期锁定的 owner；
 *       * `resolvedClaims` / `resolvedAt`：bootstrap 期快照；
 *       * `consumed`：true 表示该 token 已被 `connect.launch` 消费；
 *       * `expiresAt`：当前 Session Window 关闭即作废；V1 不写盘，因此
 *         实际不做 wall-clock 校验，仅供未来扩展时使用。
 */
export interface LaunchTokenRecord {
  token: string;
  appId: string;
  appOrigin: string;
  appUrl: string;
  walletPublicKeyHex: string;
  ownerPublicKeyHex: string;
  resolvedClaims: Record<string, ResolvedClaimValue>;
  resolvedAt: number;
  consumed: boolean;
  expiresAt: number;
}

/* ============== popup 会话状态 ============== */

/**
 * popup 内的会话状态机。一次只处理一个 request；由 service 自己维护。
 * - `waiting`   : 监听已挂载，但还没收到合法 request。
 * - `unlocking` : 已绑定 request，但 Vault 处于 locked，正在等待解锁。
 * - `confirming`: 已绑定 request，已解锁，等待用户确认。
 * - `executing` : 用户已确认，正在执行方法。
 * - `closing`   : 已发出 result，正在关 popup。
 * - `error`     : 终态：协议层面发生不可恢复错误（opener 缺失、解析失败等）。
 *
 * UI 不允许自己再发明"中间态"。任何 UI 上的等待展示都映射回这六态之一。
 *
 * 设计缘由（施工单 2026-06-27 001 硬切换）：
 *   - `phase` 与 `lockState` **不**再一一对应：`phase === "unlocking"`
 *     现在表示"已绑定 request 且 vault 处于 locked"，但在多 request
 *     模型下，没有"当前绑定 request"概念（多条 request 各自状态），
 *     所以 `phase` 主要是为了**兼容旧 UI 路径**，新代码应优先用
 *     `lockState` + 每条 command 的 `phase` 字段。
 *   - `unlocking` 之后多个 request 各自处于 `waiting_unlock_*`；
 *     解锁后才批量推进到 `confirming` / `queued`。
 */
export type ProtocolSessionPhase =
  | "waiting"
  | "unlocking"
  | "confirming"
  | "executing"
  | "closing"
  | "error";

/** popup 会话的可序列化快照（仅供调试 / 未来日志扩展使用）。 */
export interface ProtocolSessionSnapshot {
  phase: ProtocolSessionPhase;
  /** 当前绑定的 source window（仅做引用，不做结构化克隆）。 */
  boundSource: Window | null;
  /** 当前绑定的 origin。origin 是浏览器事件原样字符串，**不**做归一化。 */
  boundOrigin: string | null;
  /** 已绑定 request 的 method（绑定前为 null）。 */
  method: ProtocolMethod | null;
  /** 已绑定 request 的 id（绑定前为 null）。 */
  requestId: string | null;
  /**
   * 当前会话级锁状态（施工单 2026-06-27 001 硬切换 + 2026-06-30 003 硬切换 4.5）。
   * - `unlocked` → 当前 Session Window 拥有可执行 owner runtime；进入
   *   主 popup 页面（顶栏 + 命令流 + 站点配置）；
   * - `locked`   → 当前 Session Window 没有可执行 owner runtime；全页
   *   锁屏页（解锁表单 + 待处理摘要）。
   *
   * 真值来源：
 *   - `bootstrap_runtime`：appView mode 下 launcher 一次性注入的
 *     owner runtime，bootstrap 成功后即对当前窗口持续有效。
 *   - `vault_runtime`：仅 connect mode 下，本窗口用户后续通过本地 vault 解锁。
 *   - connect mode 下任一可用即 `unlocked`；二者皆不可用才是 `locked`。
 *   - appView mode 只认 bootstrap runtime，bootstrap 缺失必须 fail-closed。
   *
   * 注意：`phase` 与 `lockState` 是两层语义；不允许把 phase 改写
   * 成 lockState，也不允许把 lockState 合并进 phase。
   */
  lockState: ProtocolPopupLockState;
}

/* ============== capability ============== */

/** ProtocolService capability key。 */
export const PROTOCOL_SERVICE_CAPABILITY = defineCapability<ProtocolService>({
  kind: "local",
  id: "protocol.service",
  version: "1",
});

/**
 * 协议 service 对外契约。`主应用` / `ProtocolPopupPage` 通过
 * `useCapability<ProtocolService>(PROTOCOL_SERVICE_CAPABILITY)` 拿到实例。
 *
 * 设计缘由：service 负责 transport + 校验 + 解锁 + 确认流调度 + 调用
 * vault / walletState + 构造 envelope + 签名 / 加解密；UI 只负责渲染态。
 * service 完全不依赖 React，单元测试可直接调它。
 */
/**
 * plugin-protocol 通过 capability 注入 p2pkh 业务能力的"瘦身"接口。
 *
 * 设计缘由（施工单 2026-06-28 002 硬切换）：
 *   - plugin-protocol 不直接 import plugin-p2pkh（边界检查禁止插件间
 *     互相 import）。这里在 contracts 层定义一个最小子集；plugin-p2pkh
 *     的现有 `P2pkhService` 已经覆盖该子集，manifest setup 时做一次
 *     适配即可。
 *   - 业务请求不选择 owner/network；P2PKH 实例自动绑定权威钱包身份。
 *     Protocol 在调用前后核对 Connect session、来源、App 与钱包代际；
 *     预览和持久记录中的身份是责任证据，不是调用者自报的授权。
 */
export interface P2pkhProtocolAdapter {
  /** 完整前序证据的链上读接口；缺失时费用池不能退回盲签摘要。 */
  getRawTransaction?(txid: string): Promise<string>;
  /** Local manager lookup only; never implicitly starts conclusion queries. */
  getPaymentStatus?(input: Pick<import("./p2pkhConclusion.js").P2pkhPaymentLookupInput, "paymentId">): Promise<import("./p2pkhConclusion.js").P2pkhPaymentLookupResult>;
  /** 只消费当前钱包结果的坐标；hasResult=false 时没有 UTXO 材料。 */
  getAvailableUtxos(): Promise<
    | { hasResult: false; utxos: null }
    | { hasResult: true; utxos: Array<{ txid: string; vout: number; value: number }> }
  >;
  /** 当前钱包的业务转账预览；原样保留返回身份供提交时核对。 */
  prepareTransfer(input: import("./workerTransfer.js").P2pkhTransferRequest): Promise<{
    ownerPublicKeyHex: string;
    assetId: string;
    network: "main" | "test";
    recipientAddress?: string;
    amountSatoshis: number;
    feeRateSatoshisPerKb: number;
    allocation: unknown;
    changeAddress: string;
    outputs: Array<{ address?: string; scriptHex?: string; value: number; role?: "business" | "change" }>;
    estimatedFeeSatoshis: number;
    serializedSizeBytes: number;
    txid: string;
    rawTxHex: string;
    payment?: import("./p2pkhConnectPayment.js").P2pkhConnectPaymentPreview;
  }>;
  /**
   * 外露 artifact 的占用：Connect/费用池把**已签名**的 artifact 交给站点
   * 之前，先让 UTXO Manager 占住它花费的钱包输入。
   *
   * 中文说明：没有这一步，被交付 artifact 花掉的输入仍会被 manager 当作可花
   * 余额——同一枚输入可能被再花一次。返回的 allocation id 是稳定身份：
   * ledger 与 manager 两侧指向同一笔占用。
   */
  occupyDeliveredArtifact?(input: import("./bsvP2pkhProviders.js").P2pkhArtifactRequest): Promise<import("./bsvP2pkhProviders.js").P2pkhArtifactOccupyResult>;
  /**
   * 广播已签名 transfer preview。
   *
   * `ownerPublicKeyHex` 必填：plugin-p2pkh 在 submit 阶段会校验 resource
   * / 签名 key 与该 ownerPublicKeyHex 一致——owner 变了就拒绝广播。
   */
  submitTransfer(preview: {
    assetId: string;
    network: "main" | "test";
    ownerPublicKeyHex: string;
    recipientAddress?: string;
    amountSatoshis: number;
    feeRateSatoshisPerKb: number;
    allocation: unknown;
    changeAddress: string;
    outputs: Array<{ address?: string; scriptHex?: string; value: number; role?: "business" | "change" }>;
    estimatedFeeSatoshis: number;
    serializedSizeBytes: number;
    txid: string;
    rawTxHex: string;
    payment?: import("./p2pkhConnectPayment.js").P2pkhConnectPaymentPreview;
  }): Promise<{
    status: string;
    delivery?: "accepted" | "already-known";
    reason?: string;
    txid?: string;
    rawTxHex: string;
    error?: string;
    submissionId: string;
    localInputClaimIds: string[];
  }>;
}

export interface ProtocolService {
  /**
   * 启动一个 popup 会话。同一 service 实例允许多次启动会话（每次都重置
   * 内部状态）。调用方在 popup 加载时调用一次；之后由 service 自己维护
   * ready / bind / state。
   *
   * 设计缘由（施工单 2026-06-27 001 硬切换）：现在 service 内部用
   * "request store + execution queue" 模型，**不**再有"全局单 active
   * request"概念。`startSession()` 不再绑定任何 request，只重置 lockState
   * 与内存数据结构。
   */
  startSession(): void;
  /**
   * 关闭当前会话并清理内部状态。UI 在用户关闭 popup / 主动取消时调用。
   * 同时清空 feepool pendingOps（operationId 立即失效），并把所有未终态
   * request 强制收尾为 rejected（best-effort，不回 result 给 opener）。
   */
  endSession(): void;
  /**
   * 接收来自 `window.message` 的事件。UI 监听 message 事件后转发给
   * service。
   *
   * 行为（施工单 2026-06-27 001 硬切换）：
   *   - 收到 `cancel` 时按 `source + origin + cancel.id` 命中具体 request；
   *     命中后该 request 立即收尾（对外仍回原 request 的 user_rejected）。
   *   - 收到 `request` 时按 `source + origin + requestId` 去重：同 key 已
   *     有未终态记录则直接拒绝（不覆盖、不入队、不回 result）。否则建
   *     立新 request 记录，并按 lockState + auto-approve 决定初始 phase。
   */
  handleMessage(event: MessageEvent): void | Promise<void>;
  /**
   * 用户在确认页点击"确认"。service 收到后把对应 request 从 `confirming`
   * 推进到 `queued`，再触发全局串行执行。
   *
   * 兼容旧 UI：未传 recordId 时取"当前最新一张 confirming 卡片"。新 UI
   * 应**始终**传 recordId。
   */
  confirmByUser(recordId?: string, rememberApplicationPermission?: boolean): Promise<void>;
  /**
   * 用户在确认页或解锁页点击"取消"。service 立即向 opener 回
   * `user_rejected`；request 进入 `rejected` 终态。
   *
   * 兼容旧 UI：未传 recordId 时取"当前最新一张可取消的卡片"。
   */
  rejectByUser(recordId?: string): Promise<void>;
  /**
   * 通知 service 钱包已解锁，service 把所有 `waiting_unlock_*` request
   * 批量推进到 `confirming` 或 `queued`，并尝试启动全局串行执行。
   *
   * 兼容旧 UI：未传 recordId 时使用 service 内部判断（所有等待中的
   * request）。
   */
  resumeAfterUnlock(recordId?: string): void | Promise<void>;
  /**
   * 页面卸载 / 手工关闭路径上的 best-effort `closing` 触发入口。
   * ProtocolPopupPage 在 `pagehide` / `beforeunload` 调它。idempotent：
   * service 内部已经发过 `closing` 时直接忽略。**不**抛、**不**重试，
   * 失败由 client 端 `popup.closed === true` 兜底。
   */
  pageUnloading?(): void;
  /**
   * 当前已绑定 request 的拷贝（不绑定时返回 null）。
   *
   * 兼容旧 UI：保留接口；新逻辑下**不**再有"全局当前绑定 request"。
   * 新 UI 应直接读 `feedSnapshot().commands` + 每条 command 的 `phase`。
   * 本接口在多 request 模型下返回首张非终态记录（用于 debug / 兼容）。
   */
  currentRequest():
    | {
        id: string;
        method: ProtocolMethod;
        params: MethodParams<ProtocolMethod>;
      }
    | null;
  /**
   * 当前已绑定 request 是否走了 auto-approve（p2pkh.transfer）。
   * 兼容旧 UI；新逻辑下读 command.autoApproved。
   */
  currentRequestAutoApproved(): boolean;
  /**
   * 订阅会话状态变化，UI 用来驱动页面。
   */
  subscribe(handler: (snapshot: ProtocolSessionSnapshot) => void): () => void;
  /** 同步取当前会话快照。 */
  snapshot(): ProtocolSessionSnapshot;
  /**
   * 当前 popup 服务的 exact origin。未收到第一条 request 时返回 null。
   * UI 顶部"当前站点"展示用。**不**做 host 归一化。
   */
  currentOrigin(): string | null;
  /**
   * 同步取当前命令流 feed 状态。`commands` 是 service 派生的**展示
   * 投影**（施工单 2026-06-27 002 硬切换）：
   *   - 未终态 record 在前：按 `createdAt asc` 稳定排序（同类 request
   *     不复用卡位；第一条活卡进入终态离开后第二条上移）；
   *   - 终态 record 在后：按 `updatedAt desc` 排序。
   *
   * UI 不应再发明第二套排序规则；UI 可按 `isTerminal` 在两端内部分组
   * 渲染，但顺序真值在 service 里。活卡默认按 `recordId` 全部展开，
   * 不允许用 `i === 0` 决定唯一展开卡。
   *
   * 设计缘由（施工单 2026-06-27 001 硬切换）：
   *   - 增加 `lockSummary` 字段，锁屏页用其渲染待处理概览。
   */
  feedSnapshot(): ProtocolCommandFeedState;
  /**
   * 订阅命令流变化。`feed.phase !== 'waiting' && feed.commands` 推
   * 变；UI 用来驱动 feed 面板的更新。
   */
  subscribeFeed(handler: (state: ProtocolCommandFeedState) => void): () => void;
  /**
   * 读 origin 配置；K-V 不可用或该 origin 尚未配置时返回 null。
   * UI 用此填默认 + 弹 modal 编辑当前 origin。
   */
  getOriginSettings(origin: string): Promise<ProtocolOriginSettings | null>;
  /**
   * 写 origin 配置；K-V 不可用时 throw（由调用方决定怎么降级）。
   */
  setOriginSettings(record: ProtocolOriginSettings): Promise<void>;
  /**
   * 当前确认超时截止时间（epoch ms）。
   *
   * 设计缘由（施工单 2026-06-27 001 硬切换）：
   *   - 改为按 `recordId` 查询；任何 `confirming` request 都可以独立查询。
   *   - 旧 UI 不传 recordId 时，返回"任意一张 confirming request"的 deadline
   *     用于兼容；新 UI 应**始终**传 recordId。
   *   - waiting_unlock_* / queued / executing 都返回 null（这些状态没有 timeout）。
   *   - 修改站点 timeout **不**热更新当前正在倒计时的 request。
   */
  confirmDeadlineMs(recordId?: string): number | null;
  /**
   * 当前会话级锁状态（施工单 2026-06-27 001 硬切换 + 2026-06-30 003 硬切换 4.5）。
   *
   * 同步读：UI / accept 阶段据此决定渲染锁屏页还是主 popup 页面。
   *
   * 设计缘由（施工单 2026-06-30 003）：
   *   - 真值已收口为"当前 Session Window 是否拥有可执行 owner runtime"
 *     ——connect mode 下任一来源（`bootstrap_runtime` / `vault_runtime`）可用即
 *     `unlocked`，二者皆不可用才是 `locked`。
 *   - appView bootstrap 完成后 Session Window 即视为 unlocked；
 *     但 appView 只认 bootstrap runtime，不允许后续回退到 vault。
   */
  lockState(): ProtocolPopupLockState;
  /**
   * 当前 connect auth owner 只读快照。
   *
   * 设计缘由：popup 任一时刻只允许一个 auth owner 控制全屏 auth 页；
   * login / resume 的仲裁真值由 service 决定，UI 只读这个快照渲染。
   * 当没有 auth owner 时返回 `null`。
   */
  connectAuthSnapshot(): ProtocolConnectAuthSnapshot | null;
  /**
   * 锁屏页用的待处理摘要（施工单 2026-06-27 001 硬切换）。
   *
   * 数据由 service 从 request store 派生；调用方也可以读
   * `feedSnapshot().lockSummary`，两者行为一致。
   */
  lockSummarySnapshot(): ProtocolLockSummary | null;
  /** 从当前 Vault 与有效授权 runtime 同步执行状态；页面不传锁屏值。状态变化时撤销 Channel 会话或推进等待请求。 */
  syncWalletState(): void;

  /* ============== plugin-apps launcher 启动入口（施工单 2026-06-29 002 硬切换） ============== */

  /** 钱包目录启动外部 App：创建受控上下文，交给主钱包连接宿主并打开 App 窗口。 */
  launchAppView(input: LaunchAppViewInput): Promise<LaunchAppViewResult>;

  /* ============== connect.*（施工单 2026-06-28 001 硬切换） ============== */

  /**
   * 当前 popup 是否存在"等待用户处理"的 connect login 流程。
   * 兼容旧 UI；新 UI 应优先读 `connectAuthSnapshot()`。
   */
  connectLoginRecord(recordId?: string): {
    recordId: string;
    method: "connect.login";
    wallet?: { publicKeyHex: string; label: string };
  } | null;
  /**
   * 当前 popup 是否存在"等待用户恢复"的 connect resume 流程。
   * 兼容旧 UI；新 UI 应优先读 `connectAuthSnapshot()`。
   */
  connectResumeRecord(recordId?: string): {
    recordId: string;
    method: "connect.resume";
    ownerPublicKeyHex: string;
    ownerLabel: string;
  } | null;
  /**
   * 用户在 connect login 视图选定 key 并提交密码。service 先重新验密；
   * 若 vault 当前已锁定，则会先解锁再建立新 session，成功后原子吊销
   * 同 origin 旧 session。
   */
  confirmConnectLogin(recordId: string, password: string): Promise<void>;
  /**
   * 用户在 connect resume 视图提交密码。service 先验密；若 vault 当前
   * 已锁定，则会先解锁再恢复既有 session。
   */
  confirmConnectResume(recordId: string, password: string): Promise<void>;
  /**
   * 用户在 connect login / resume / cipher confirm / 任何视图点击"取消"，
   * service 把 request 收尾为 `rejected`，对外回 `user_rejected`。
   */
  rejectConnectRequest(recordId: string): Promise<void>;
}
