// packages/contracts/src/protocol.ts
// Keymaster 对外协议 V1 公共契约。
//
// 设计缘由（施工单 001 + 002 + 2026-06-27 002 硬切换 + 2026-06-28 002 硬切换 +
// 2026-07-01 001 硬切换：移除 S3 / storage.*）：
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
//   - **命令流展示投影**（施工单 2026-06-27 002 硬切换）：
//       `ProtocolCommandFeedState.commands` **不**再承诺
//       "全局按 updatedAt desc"，而是 service 派生的"活请求区 +
//       历史区"拼接投影：
//         - 活请求区：未终态 record，按 createdAt asc（recordId 次级稳定）；
//         - 历史区：  终态 record，按 updatedAt desc。
//       同类 request 在活请求区不复用卡位；UI 不应再按索引展开。
//       历史加载必须按 recordId 合并（内存活记录覆盖 DB 旧记录），
//       批次隔离（origin + token）避免旧 origin 异步回写新 origin 视图。
//   - 施工单 2026-06-28 001 硬切换：connect session 作为持续登录 caller
//     的正式真值。
//       - 新增 connect.login / connect.resume / connect.logout 三个 method；
//       - cipher.encrypt / cipher.decrypt 强制要求 `connectSessionId`
//         输入字段；不再读取钱包全局 active key。
//       - connect session 持久化到 `keymaster.protocol` 的
//         `connectSessions` store（DB version 升 4）。
//       - popup unlock runtime 仅存在于 popup 当前文档内存；popup
//         刷新 / 关闭后立即失效，caller 通过 `connect.resume` 补 unlock
//         即可，不需要重新登录。
//   - 施工单 2026-06-28 002 硬切换：所有外部业务方法都属于 connectSessionId：
//       - identity.get / intent.sign / cipher.encrypt / cipher.decrypt /
//         p2pkh.transfer / feepool.prepare / feepool.commit 全部强制要求
//         `connectSessionId` 入参；`connect.login` 是唯一不要求 sessionId
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
//         `ownerPublicKeyHex` + 新增 `connectSessionId`（业务方法必填）。
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
//   - 施工单 2026-06-29 001 硬切换：Session Window 统一 + appView 启动 +
//     `connect.launch`：
//       - 唯一窗口入口仍是 `/protocol/v1/popup`，无第二套路由；语义上称
//         Session Window（"popup"只是窗口形态称谓，不再承载权限模型）。
//       - Session Window 只允许两种 boot mode：`connect`（默认）与
//         `appView`（由 launcher 一次性 bootstrap 启动）；同一套
//         `protocolService` / `ProtocolPopupPage` 同时承载两种 mode，
//         启动后执行路径不再区分 mode。
//       - 新增 `connect.launch`：appView mode 下 client app 首登入口；
//         入参 `{ launchToken }`，成功结果形状与 `connect.login` 对齐；
//         launchToken 一次性消费；不允许 fallback 到 `connect.login`。
//   - 施工单 2026-07-01 001 硬切换：彻底移除 storage.* / S3 provider：
//       - 协议方法集里**不再**存在 `storage.put` / `storage.get` /
//         `storage.list` / `storage.listAll` / `storage.delete`；
//       - `StorageProviderConfig` / storage params/result 类型
//         全部从 contracts 抹去；
//       - `ProtocolStorageDb` 不再提供 storage provider config CRUD；
//       - `ProtocolService` 不再持有 storage config 读写接口；
//       - DB schema 中 `storageProviderConfig` store 在升级时
//         物理删除，旧配置随升级消失。
//   - 统一 owner execution runtime：`OwnerExecutionRuntime` 承载同一份
//     owner 私钥闭包；runtime 只允许两路来源——`bootstrap_owner`
//     （launcher 一次性注入的 owner 私钥材料，本窗口当前主要来源）与
//     `vault_unlock`（Session Window 解锁后从本地 vault 重建）。两路对
//     外行为一致；执行路径**不**依据"runtimeBinding"二分（已删除）。
//       - session 真值收口为 `sessionId + origin + ownerPublicKeyHex`，
//         **不**持久化 runtime 来源；执行时按当前窗口能解析到的 owner
//         runtime 立即决定能不能跑。
//       - `drainExecutionQueue()` 取消 `lockState === "unlocked"` 全局
//         卡死门：执行条件改成"按 record 自己能否解析到 owner runtime
//         来决定立即执行 / waiting unlock / fail-fast"。
//       - `AppBootstrapPayload.ownerRuntimeBootstrap` 承载
//         `OwnerRuntimeBootstrap` 材料；Session Window 只在当前内存注册
//         owner runtime，**不**假装是"完整解锁钱包窗口"，**不**写
//         IndexedDB / localStorage / URL。
//       - 所有业务方法（`identity.*` / `intent.sign` / `cipher.*` /
//         `p2pkh.transfer` / `feepool.*`）走同一个
//         `resolveOwnerRuntime(session)` 入口；runtime 解析顺序：
//         `bootstrap_owner` → `vault_unlock` → 解析失败。

/**
 * 二进制字段。V1 协议里所有二进制内容（密文、签名、信封真值、文件本体、
 * 头像本体等）必须包成这种结构；不允许直接传 ArrayBuffer / base64 字符串。
 *
 * structured clone 允许 ArrayBuffer / Uint8Array 走 postMessage；本包装
 * 只是为了让"这是二进制内容"在对象层有显式标记，避免调用方误把
 * base64 / hex 字符串塞进协议层。
 */
import type { VaultService } from "./vault.js";

export interface BinaryField {
  /** 固定 "binary"。缺省 / 其它值一律拒绝。 */
  $type: "binary";
  /** 真实字节；`structured clone` 会原样传过去。 */
  bytes: ArrayBuffer;
  /** 可选的内容类型；密文 / 图片 / 文件等有明确类型时填写。 */
  mime?: string;
}

/** 协议版本号；当前固定为 1。 */
export const PROTOCOL_VERSION = 1;

/** 协议方法名常量集合。 */
export const PROTOCOL_METHODS = [
  "identity.get",
  "intent.sign",
  "cipher.encrypt",
  "cipher.decrypt",
  "p2pkh.transfer",
  "feepool.prepare",
  "feepool.commit",
  "connect.login",
  "connect.resume",
  "connect.logout",
  "connect.launch"
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
 *   - active_key_unavailable  vault 已 unlocked，但 keyspace 没有 ready
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
  | "invalid_request"
  | "invalid_origin"
  | "user_rejected"
  | "active_key_unavailable"
  | "decrypt_failed"
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
  v: typeof PROTOCOL_VERSION;
  type: "cancel";
  /** 要取消的原 `request.id`。 */
  id: string;
}

/** 顶层 request 报文。 */
export interface ProtocolRequestMessage<M extends ProtocolMethod = ProtocolMethod> {
  v: typeof PROTOCOL_VERSION;
  type: "request";
  /** 请求唯一标识；同时承担 transport 关联 id 与业务操作 id 双重角色。 */
  id: string;
  method: M;
  params: MethodParams<M>;
}

/** 顶层 result 报文。 */
export type ProtocolResultMessage =
  | {
      v: typeof PROTOCOL_VERSION;
      type: "result";
      id: string;
      ok: true;
      result: MethodResult;
    }
  | {
      v: typeof PROTOCOL_VERSION;
      type: "result";
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
  | ProtocolCancelMessage;

/* ============== identity.get ============== */

/**
 * identity.get 请求参数。
 *
 * 设计缘由（施工单 2026-06-28 002 硬切换）：
 *   - `connectSessionId` 是**强制**输入字段；所有外部业务方法都属于某个
 *     `connectSessionId`（仅 `connect.login` 例外）。缺该字段直接
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
   * 由 `connect.login` 返回的 sessionId。**必填**。
   * service 通过此 id 找到绑定 key，不允许 fallback 到 active key。
   */
  connectSessionId: string;
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
 *   - `connectSessionId` 是**强制**输入字段；签名主体公钥取自 session
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
   * 由 `connect.login` 返回的 sessionId。**必填**。
   * service 通过此 id 找到绑定 key，不允许 fallback 到 active key。
   */
  connectSessionId: string;
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
 *   - `connectSessionId` 是**强制**输入字段；cipher 不再读取钱包全局
 *     active key，必须通过 sessionId 找到绑定 key。
 *   - 缺 `connectSessionId` 直接 `invalid_request` 拒绝；不允许 fallback
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
   * 由 `connect.login` 返回的 sessionId。**必填**；service 通过此 id
   * 找到绑定 key，不允许 fallback 到 active key。
   */
  connectSessionId: string;
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
 * 设计缘由：与 `cipher.encrypt` 对称——`connectSessionId` 是强制输入
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
   * 由 `connect.login` 返回的 sessionId。**必填**；service 通过此 id
   * 找到绑定 key，不允许 fallback 到 active key。
   */
  connectSessionId: string;
}

/** cipher.decrypt 成功结果。 */
export interface CipherDecryptResult {
  /** 密文内层结构里的 contentType。 */
  contentType: string;
  /** 还原后的业务字节。 */
  content: BinaryField;
}

/* ============== p2pkh.transfer ============== */

/**
 * `p2pkh.transfer` 请求参数。
 *
 * 设计缘由（施工单 002 硬切换 + 施工单 2026-06-28 002 硬切换）：
 *   - 本次只支持 `bsv` 主网 P2PKH 转账。不引入 assetId / network / 多币种
 *     / 多网络协商。
 *   - site 不允许传 `text` / `confirmMessage`：确认文案由 Keymaster 自己
 *     按方法语义生成；不允许 site 伪装转账为登录确认。
 *   - `aud` 不接受：connect popup 已天然拿到 `event.origin` 真值，origin
 *     等价检查由 service 自动执行。
 *   - `feeRateSatoshisPerKb` 可选；缺省时由 service 走一个保守默认值。
 *   - amountSatoshis 是整数 satoshis，不接受小数；feeSatoshis 在 result 里
 *     回。
 *   - `connectSessionId` 是**强制**输入字段（施工单 2026-06-28 002 硬切换）：
 *     资金 owner 取自 session 绑定 owner，**不**读取全局 active key。
 *     旧 session 失效时直接 fail-fast，不再静默 fallback 到 active key。
 */
export interface P2pkhTransferParams {
  /** 主网 P2PKH 地址（base58check，version 0x00）；testnet 直接 invalid_request。 */
  recipientAddress: string;
  /** 正整数 satoshis。 */
  amountSatoshis: number;
  /** 可选 fee rate（sat/kB）。>= 1。 */
  feeRateSatoshisPerKb?: number;
  /**
   * 由 `connect.login` 返回的 sessionId。**必填**。
   * service 通过此 id 找到绑定 key，不允许 fallback 到 active key。
   */
  connectSessionId: string;
}

/** `p2pkh.transfer` 成功结果。 */
export interface P2pkhTransferResult {
  /** 已广播交易的 canonical txid。 */
  txid: string;
  /** 已签名交易 raw hex。 */
  rawTxHex: string;
  /** 实际花费的 fee satoshis。 */
  feeSatoshis: number;
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
 *       - `connectSessionId`：本次 transfer 所属 connect sessionId；service
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
  /** 33-byte compressed secp256k1 公钥 hex（66 个 hex 字符）。 */
  counterpartyPublicKeyHex: string;
  /** 正整数 satoshis；本次想转给对端的金额（三种 action 语义一致）。 */
  amountSatoshis: number;
  /**
   * 由 `connect.login` 返回的 sessionId。**必填**。
   * feepool 是按 (origin + ownerPublicKeyHex + counterpartyPublicKeyHex)
   * 三个维度归档的；不同 owner 不会串池。
   */
  connectSessionId: string;
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
 *   - `connectSessionId` 是**强制**输入字段；`feepool.commit` 必须按
 *     `connectSessionId + origin + ownerPublicKeyHex` 校验 pending op，
 *     不允许跨 session / 跨 owner 复用 operationId。
 */
export interface FeepoolCommitParams {
  /** 由 `feepool.prepare` 返回的 operationId；只在本 popup 会话内有效。 */
  operationId: string;
  /** 33-byte compressed secp256k1 公钥 hex。 */
  counterpartyPublicKeyHex: string;
  /**
   * 由 `connect.login` 返回的 sessionId。**必填**。
   * `feepool.commit` 校验 operation 与当前 session/owner/origin 一致。
   */
  connectSessionId: string;
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
  /** 当前主 B-Tx 草稿的 txid。 */
  draftTxid: string;
  /** 当前主 B-Tx 草稿的 raw tx hex。 */
  draftTxHex: string;
  /** 落地后费用池记录（spend / close_and_recreate 的新池部分非空）。 */
  poolRecord: ProtocolFeePoolRecord | null;
  /** 仅 close_and_recreate：旧池被 close 时的最终 close 草稿 txid。 */
  closeDraftTxid?: string;
}

/* ============== 站点配置与费用池状态（施工单 002 硬切换） ============== */

/**
 * 站点级配置。
 *
 * 字段固定；默认值在 service 层给出：
 *   - p2pkhAutoApproveEnabled 默认 false；
 *   - p2pkhAutoApproveMaxSatoshis 默认 0；
 *   - feePoolDefaultFundSatoshis 默认 0（首次配置必须由用户填）；
 *   - feePoolAutoSignMaxSatoshis 默认 0（即"默认关闭 auto-sign"）。
 *
 * 设计缘由（施工单 002 收尾反馈）：
 *   - 关键：**fee pool 缺省 fund 是 per-origin 设置**，不是系统级设置；
 *     同一站点不同 origin 之间彼此独立。
 *   - 首次 `feepool.prepare` 命中 create action 且该 origin 没配置时，
 *     popup 必须要求用户先填 `feePoolDefaultFundSatoshis`（走 settings modal
 *     或站点配置入口；详见协议文档）。
 */
export interface ProtocolOriginSettingsRecord {
  /** exact event.origin（不做 host 归一化）。 */
  origin: string;
  /** 是否对该 origin 自动通过 p2pkh.transfer。 */
  p2pkhAutoApproveEnabled: boolean;
  /** 自动通过上限（amount <= max 才放行）。0 = 关闭。 */
  p2pkhAutoApproveMaxSatoshis: number;
  /**
   * 是否对该 origin 自动批准 `identity.get`。
   *
   * 设计缘由（施工单 001 收口：per-origin 自动批准 + 钱包入口）：
   *   - exact origin 语义与 `origin` 字段保持一致，不做 host 归一化。
   *   - 自动批准 = "跳过 manual confirm 页" + "vault 锁定态下解锁后直接
   *     executing 内联执行，不再进入 confirming"。
   *   - DB 不可用时按 false 处理（走 manual confirm）。
   *   - 旧记录缺字段时由 service 层 `normalizeOriginSettings` 补 false，
   *     **不**扫库迁移，**不**升 DB version。
   */
  identityAutoApproveEnabled: boolean;
  /**
   * 是否对该 origin 自动批准 `cipher.encrypt` 与 `cipher.decrypt`。
   * 同一字段同时控制 encrypt 与 decrypt，语义对称。
   *
   * 设计缘由（施工单 001）：
   *   - **不**扩展到 `intent.sign` / `p2pkh.transfer` / `feepool.*`；
   *     这些 method 的 auto-approve 仍走各自独立字段（p2pkh.transfer
   *     走 p2pkhAutoApproveEnabled，feepool 走 feePoolAutoSignMaxSatoshis）。
   *   - aud / origin 校验仍由对应 execute 方法内部 throw，自动批准
   *     路径不绕过校验。
   */
  cipherAutoApproveEnabled: boolean;
  /** 自动签名上限（amount <= max 才放行 feepool.commit）。0 = 关闭。 */
  feePoolAutoSignMaxSatoshis: number;
  /**
   * 该 origin 首次 `feepool.prepare` 命中 create 时使用的池大小。
   * 默认 0；0 = "未配置"，首次会要求用户在 popup 内补。
   */
  feePoolDefaultFundSatoshis: number;
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
   *     补 `30`，不扫库迁移，不升 DB version。
   */
  confirmTimeoutSeconds: number;
  updatedAt: number;
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
 *   - key 格式：
 *       `${origin}::${ownerPublicKeyHex}::${counterpartyPublicKeyHex}`；
 *       `::` 不可能出现在 origin / publicKeyHex 字符串里，碰撞风险极低。
 */
export interface ProtocolFeePoolRecord {
  /**
   * 复合 key。施工单 2026-06-28 002 硬切换：补 `ownerPublicKeyHex` 维度，
   * 不再仅按 `origin + counterpartyPublicKeyHex` 归档。
   * 格式：`${origin}::${ownerPublicKeyHex}::${counterpartyPublicKeyHex}`。
   */
  poolKey: string;
  origin: string;
  /** 绑定该池的 connect session owner 的公钥 hex。 */
  ownerPublicKeyHex: string;
  counterpartyPublicKeyHex: string;
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
 * 本地终态原因（仅写本地历史；对外统一 `user_rejected`）。
 *
 * 设计缘由：余额不足 / 池缺失 / DB 不可用等敏感失败，以及用户本地取消 /
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
 *   - cipher.* 不再读取钱包全局 active key；通过 `connectSessionId` 找到
 *     绑定 key。
 *   - popup 刷新 / 关闭 → 当前 popup unlock runtime 失效；auth session
 *     持久化记录仍保留，caller 通过 `connect.resume` 补 unlock 即可。
 *   - `connect.logout` 是 auth 失效的唯一正常路径。
 *
 * 不删除 `identity.get` / `intent.sign` / `cipher.encrypt` / `cipher.decrypt`：
 *   - `identity.get` 仍保留，但**不**再作为 note 这类持续登录 caller
 *     的推荐入口；走 `connect.login` 取 sessionId。
 *   - `cipher.*` 的稳定调用路径改为 session 绑定版本；继续保留旧 method
 *     名但**强制**要求 `connectSessionId` 字段。
 */

/**
 * 持久化的 connect session 记录。
 *
 * 设计缘由（施工单 2026-06-28 002 硬切换 + 施工单 2026-06-30 002 硬切换）：
 *   - 这是 auth session 真值；**不**是 unlock runtime。
 *   - 允许持久化（IndexedDB `connectSessions` store）。
 *   - **不**混入 pending request / 中间密文 / 解锁材料。
 *   - `revokedAt` 是被 `connect.logout` 主动吊销的时间戳；非空记录
 *     不允许 `connect.resume` 复活。
 *   - **owner 唯一真值 = `ownerPublicKeyHex`**。`ownerKeyId` **不允许**
 *     出现在 session record / request record / result payload / fee pool
 *     key / service 分支判断里——它会制造第二套 owner 身份。Vault 内部
 *     借用句柄按需从 keyspace 解析，**不**落 session 持久化。
 *   - **不**持久化执行 runtime 来源：`runtimeBinding` 已从 session
 *     真值里删掉。同一 session 在窗口生命周期内可以从
 *     `bootstrap_owner` 切到 `vault_unlock`——这是允许的；
 *     持久化来源会阻止这条切换路径。runtime 来源是窗口内运行时状态，
 *     不是业务真值。
 *
 * 关键不变量：
 *   - `ownerPublicKeyHex` 在创建后**不**可变（resume 不重新选 key）。
 *   - origin / sessionId / ownerPublicKeyHex 三元组是 session 的稳定真值。
 *   - 执行 owner 解析时按 `sessionId -> ownerPublicKeyHex` 走
 *     `resolveOwnerRuntime(session)`，统一在
 *     `bootstrap_owner | vault_unlock` 两条来源里挑当前可用的那条。
 */
export interface ConnectSessionRecord {
  /** sessionId：service 在 connect.login / launchAppView 时生成；UUID。 */
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
}

/**
 * `connect.login` 成功结果。
 *
 * 设计缘由：返回 sessionId + owner + claimsSnapshot 三元组，caller 把
 * sessionId 持久化在本地；后续 connect.resume / 业务方法都用这个 sessionId
 * 找回绑定关系。
 *
 * 关键（施工单 2026-06-28 002 硬切换）：**不**再返回 `ownerKeyId`。
 * owner 唯一真值 = `ownerPublicKeyHex`；vault 内部 keyId 属于实现细节。
 */
export interface ConnectLoginResult {
  /** 持久化 sessionId；caller 必须存本地。 */
  connectSessionId: string;
  /** 绑定 key 的压缩公钥 hex；与 session 记录内字段一致。 */
  ownerPublicKeyHex: string;
  /** 本次 login 时一次解析的 claims 真值快照。 */
  resolvedClaims: Record<string, ResolvedClaimValue>;
  /** 本次解析时间（unix milliseconds）。 */
  resolvedAt: number;
}

/**
 * `connect.resume` 请求参数。
 *
 * 设计缘由：resume 必须显式传入 sessionId；service 在执行时按
 * `event.origin` + sessionId 查 session 记录。sessionId 不在 params
 * 里时直接 invalid_request。
 */
export interface ConnectResumeParams {
  /**
   * 由 `connect.login` 返回的 sessionId。
   * caller 持 sessionId，popup 持有 session 真值与 unlock runtime。
   */
  connectSessionId: string;
}

/**
 * `connect.resume` 成功结果。
 *
 * 设计缘由：与 `connect.login` 对称——返回 sessionId + owner + claimsSnapshot
 * 三元组。claimsSnapshot 是 connect.login 时已落库的真值快照；resume 不重新
 * 跑 identity.get，避免 popup unlock 后还要走人工确认。
 *
 * 关键（施工单 2026-06-28 002 硬切换）：**不**再返回 `ownerKeyId`。
 */
export interface ConnectResumeResult {
  connectSessionId: string;
  ownerPublicKeyHex: string;
  resolvedClaims: Record<string, ResolvedClaimValue>;
  /**
   * 解析时间——本次 resume 时间戳，**不**是 connect.login 时的快照时间。
   * 给 caller 用来做"是否要重新登录"的客户端超时策略。
   */
  resolvedAt: number;
}

/**
 * `connect.logout` 请求参数。
 *
 * 设计缘由：logout 只需要 sessionId；service 在执行时按 event.origin + sessionId
 * 找到对应记录并吊销。
 */
export interface ConnectLogoutParams {
  connectSessionId: string;
}

/**
 * `connect.logout` 成功结果。
 *
 * 设计缘由：返回 ok=true 即表示 session 已被吊销；不需要返回 claims。
 */
export interface ConnectLogoutResult {
  connectSessionId: string;
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
  /** 当前 auth owner 类型；`null` 表示没有 auth owner。 */
  ownerType: "login" | "resume" | null;
  /** 当前 auth owner 对应的 recordId；无 owner 时为 null。 */
  recordId: string | null;
  /** service 侧当前是否已具备提交条件。 */
  canSubmit: boolean;
  /** 当前 auth 请求是否已经提交过；用于 UI 呈现 busy / 禁用态。 */
  submitted: boolean;
  /** login auth owner 的候选 key；无 login owner 时为 null。 */
  login: {
    recordId: string;
    availableKeys: Array<{ publicKeyHex: string; label: string }>;
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
 *     sessionId + 后续 connect.resume / cipher.*"路径。
 */
export interface ConnectLaunchParams {
  /** 由 launcher 写入 client app 启动 URL 的 launchToken。一次性消费。 */
  launchToken: string;
}

/** `connect.launch` 成功结果（与 `connect.login` 对齐）。 */
export interface ConnectLaunchResult {
  connectSessionId: string;
  ownerPublicKeyHex: string;
  resolvedClaims: Record<string, ResolvedClaimValue>;
  resolvedAt: number;
}

/* ============== plugin-apps launcher 启动入口（施工单 2026-06-29 002 硬切换） ============== */

/**
 * `protocol.service.launchAppView(...)` 的入参。
 *
 * 设计缘由（施工单 2026-06-29 002 硬切换）：
 *   - 这是 `plugin-apps` **唯一**允许调用的 appView 启动入口；plugin-apps
 *     自己**不**直接操作 `protocolStorageDb` / `buildAppBootstrapPayload`
 *     / `installLauncherBootstrapRegistry` / `window.open` popup URL。
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
  /**
   * 期望在 connect.login 快照的 claim 列表；与 `connect.login.claims`
   * 同语义。V1 不传时取空数组。
   */
  claims?: string[];
}

/**
 * `protocol.service.launchAppView(...)` 的成功结果。
 *
 * 设计缘由（施工单 2026-06-29 002 硬切换）：
 *   - 成功意味着 launcher 已完成整套：vault 已解锁校验 + owner key 已 ready
 *     校验 + app 配置合法 + 预建 connect session + 导出 unlock runtime +
 *     生成 launchToken + 安装 bootstrap registry + 打开 Session Window。
 *   - 启动失败（任何一道闸）一律 throw，**不**返回 `sessionWindowOpened=false`
 *     的"半成功"语义——避免业务插件"先显示成功，再去查"等隐式兼容路径。
 *   - 返回的 `appUrl` 是已拼上 `?launchToken=<id>` 的真实打开 URL；
 *     `plugin-apps` 仅作展示用，**不**自己再去 `window.open(appUrl)`。
 */
export interface LaunchAppViewResult {
  /** Session Window 是否已成功打开新窗口。 */
  sessionWindowOpened: boolean;
  /** launcher 在点击 `Open App` 时预建的 connect sessionId。 */
  connectSessionId: string;
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
  /** 当前运行环境不支持 window / window 不可用。 */
  | "window_unavailable"
  /** connect session 存储不可用。 */
  | "session_storage_unavailable"
  /**
   * 借 owner 私钥 / 准备 owner runtime bootstrap 失败（施工单
   * 2026-06-30 002）。
   *
   * 设计缘由：launcher 用 `vault.withPrivateKey(keyId, fn)` 借出
   * owner 私钥 hex 拼 owner runtime bootstrap。借不到（vault 状态
   * 错 / key 状态错）时报这个 code。
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
  /** bootstrap 时 launcher 已建的 connectSessionId。 */
  connectSessionId: string;
  /** bootstrap 时锁定的 owner public key hex。 */
  ownerPublicKeyHex: string;
  /** bootstrap 时一次解析的 claims 快照。 */
  resolvedClaims: Record<string, ResolvedClaimValue>;
  /** bootstrap 时间（unix milliseconds）。 */
  resolvedAt: number;
}

/**
 * Owner runtime bootstrap：launcher → Session Window 一次性交接的
 * "Session Window 启动早期注入统一 owner execution runtime 用的材料"。
 *
 * 设计缘由（施工单 2026-06-30 002 硬切换）：
 *   - bootstrap 内字段叫 `ownerRuntimeBootstrap`，表达"启动时注入的
 *     统一 owner runtime 材料"。
 *   - Session Window 在 bootstrap 成功后**只在内存**注册 owner runtime；
 *     **不**导入整套 vault unlock runtime，**不**把 vault 切到
 *     unlocked 态——appView mode 下 Session Window 不假装是"完整解锁
 *     钱包窗口"。
 *   - 持有这套材料就持有这扇 Session Window 的全部签名 / 派生能力；
 *     不需要 masterKey / masterSalt / keySnapshot / activePublicKeyHex。
 *   - 校验：Session Window consume 时必须验
 *     `ownerPublicKeyHex === payload.ownerPublicKeyHex` 且
 *     `privateKeyHex` 派生的压缩公钥确实等于该 publicKeyHex。
 *   - 失败一律 fail-closed：不缓存半残 runtime / 不写 appViewContext /
 *     不打开 client app。
 *   - **不**走 postMessage 事件队列（launcher 在子窗口 listener 挂好
 *     之前发消息会丢失）。Session Window mount 时**主动**调 launcher
 *     `window` 上的 `__keymaster_session_window_bootstrap__.acquire
 *     (token)` 拉取——同源普通 JS 函数调用，**没有**时序竞态。
 *   - Session Window 刷新 / 关闭后 bootstrap runtime 随窗口内存丢失；
 *     是允许的，本窗口用户后续 unlock 可按同 owner 从 vault 重建 runtime。
 *   - `privateKeyHex` **不**写 IndexedDB / localStorage / sessionStorage
 *     / URL / command history / 明文日志；只允许存在于 launcher 当前内存
 *     与 Session Window 当前内存。
 */
export interface OwnerRuntimeBootstrap {
  /** 绑定 key 的压缩公钥 hex；与 payload.ownerPublicKeyHex 必须一致。 */
  ownerPublicKeyHex: string;
  /** 绑定 key 的 label（仅展示用）。 */
  ownerLabel: string;
  /**
   * owner 私钥明文 hex（32 字节十六进制小写编码）。
   *
   * Session Window consume 时按 secp256k1 从 hex 推出压缩公钥，必须
   * 与 `ownerPublicKeyHex` 一致；不一致直接 fail-closed。
   */
  privateKeyHex: string;
  /** 该 runtime 拥有的能力列表（例如 `["p2pkh"]`）；与 vault KeyRef
   * capabilities 对齐。V1 简化为只校验存在性。 */
  capabilities: string[];
  /** runtime 创建时间，unix milliseconds。 */
  createdAt: number;
}

/**
 * Launcher 在 bootstrap 阶段一次性塞给 Session Window 的 capsule。
 *
 * 设计缘由（施工单 2026-06-30 002 硬切换，撤销 2026-06-29/003）：
 *   - **不**走 postMessage handoff。Launcher 在 `window` 上挂一个
 *     `LauncherBootstrapRegistry` 接口（`__keymaster_session_window_bootstrap__`），
 *     Session Window mount 后**主动**从同源 `window.opener` 调
 *     `acquire(token)` 拉取 capsule。
 *   - URL 里**只**承载"此窗口要以哪种模式启动"的轻量标记
 *     （`?boot=appView&bootstrapToken=<id>`）：token 是 launcher 生成的
 *     不透明 ID，本身不敏感；真正的 owner runtime + session 真值只在
 *     launcher 的当前内存中。
 *   - capsule 包含 launcher 已建的 session 真值、claims 快照、
 *     launchToken，以及本次 session 绑定 owner 的 owner runtime bootstrap
 *     （见 `OwnerRuntimeBootstrap`）。
 *   - Session Window 拿到 capsule 后做校验：launchToken 非空 /
 *     bootstrap payload 完整 / `bootstrap.ownerPublicKeyHex ===
 *     payload.ownerPublicKeyHex` / `bootstrap.privateKeyHex` 派生
 *     公钥与 `ownerPublicKeyHex` 一致；通过后**只在内存**注册 owner
 *     runtime + 应用 appViewContext + 缓存 launchToken。
 *   - **不**导入 unlock runtime，**不**把 vault 切到 unlocked 态；
 *     appView mode 下的 Session Window 不假装是"完整解锁钱包窗口"。
 *   - 这只是"启动时拥有 owner runtime 的一种方式"：当本窗口用户后续
 *     在 Session Window 内 unlock，且 vault 里 owner 可读，运行时
 *     自动按同 owner 切到 `vault_unlock` 来源继续处理同 session request。
 */
export interface AppBootstrapPayload {
  /** 当前 app 信息（仅 UI / 启动用）。 */
  app: {
    appId: string;
    appOrigin: string;
    appUrl: string;
  };
  /** launcher 已建的 connect sessionId。 */
  connectSessionId: string;
  ownerPublicKeyHex: string;
  resolvedClaims: Record<string, ResolvedClaimValue>;
  resolvedAt: number;
  /** launcher 给 client app 的 launchToken；Session Window 收 bootstrap 时缓存、消费在 connect.launch。 */
  launchToken: string;
  /**
   * 本次 session 绑定 owner 的 owner runtime bootstrap（施工单
   * 2026-06-30 002 硬切换）。
   *
   * Session Window 校验通过后**只**把它注册到当前窗口的 owner
   * runtime，**不**写任何长期存储，**不**调用 vault import runtime。
   * `privateKeyHex` 遵守"不在长期存储落库"边界。
   */
  ownerRuntimeBootstrap: OwnerRuntimeBootstrap;
}

/**
 * Owner execution runtime 当前来源（施工单 2026-06-30 002 硬切换）。
 *
 * 设计缘由：
 *   - `runtimeBinding` 已从 `ConnectSessionRecord` 删除；
 *     runtime 来源不再落库，不再作执行路径二分。
 *   - 同一 session 在 Session Window 生命周期内可以从
 *     `bootstrap_owner` 切到 `vault_unlock`：
 *       - 启动早期 `bootstrap_owner`：launcher 一次性注入的 owner 私钥
 *         材料，足够跑 `identity.*` / `intent.sign` / `cipher.*` /
 *         `p2pkh.transfer` / `feepool.*`。
 *       - 本窗口用户后续 unlock + vault owner 可读 → `vault_unlock`：
 *         从本地 vault 按 `ownerPublicKeyHex` 重建 owner runtime，
 *         覆盖 `bootstrap_owner` 的同一把 owner；服务外部行为一致。
 *   - 这是窗口内运行时状态 + 调试信息；**不**是 session 业务真值，
 *     **不**影响 cipher.* / p2pkh.transfer 的对外语义。
 */
export type OwnerRuntimeSource = "bootstrap_owner" | "vault_unlock";

/**
 * 统一 owner execution runtime 接口。
 *
 * 设计缘由：
 *   - 业务方法（`identity.*` / `intent.sign` / `cipher.*` /
 *     `p2pkh.transfer` / `feepool.*`）只通过 `withPrivateKeyHex(...)`
 *     闭包持有 owner 私钥；业务方法**不**知道也不依赖 `source` 是哪一条。
 *   - `bootstrap_owner` 来源：launcher 在 Session Window 启动早期注入；
 *     `vault_unlock` 来源：本窗口用户后续 unlock 后从 vault 重建。两条
 *     路径对外行为完全一致。
 *   - 解析入口 `resolveOwnerRuntime(session)`：`bootstrap_owner` →
 *     `vault_unlock` → 解析失败。解析失败时业务方走 fail-fast
 *     （不再 fallback 到 vault 或活动 active key）。
 *   - `ownerPublicKeyHex` 是返回值上的唯一标识；执行时与
 *     `session.ownerPublicKeyHex` 严格比对。
 *   - 闭包内短暂暴露私钥 hex；调用方负责"用完即丢"，**不**把
 *     `material.hex` 写出 `withPrivateKeyHex` 范围之外。
 */
export interface OwnerExecutionRuntime {
  /** 会话绑定 owner 的压缩公钥 hex；与 session.ownerPublicKeyHex 一致。 */
  ownerPublicKeyHex: string;
  /** 当前 owner runtime 来源（仅调试 / 日志用，业务方不依赖）。 */
  source: OwnerRuntimeSource;
  /**
   * 在闭包内短暂持有 owner 私钥 hex；调用方回 `fn(material)` 后
   * material 即丢弃。失败时抛 localFailure；调用方按业务方法语义映射。
   */
  withPrivateKeyHex: <T>(
    fn: (material: { hex: string }) => Promise<T> | T
  ) => Promise<T>;
}

/**
 * Launcher 在 `window` 上挂的 bootstrap registry 接口。
 *
 * 设计缘由（施工单 2026-06-29 001 硬切换 + 用户确认）：
 *   - **不**用 postMessage listener 做 handoff——launcher 在子窗口
 *     listener 挂好之前发出消息会丢失。
 *   - launcher 在自己的 `window.__keymaster_session_window_bootstrap__`
 *     挂一个对象；Session Window mount 后**主动**调 `window.opener.____
 *     keymaster_session_window_bootstrap__.acquire(token)`。
 *   - 这是同源直接调用：launcher 和 Session Window 同 origin，
 *     `window.opener` 是 launcher's window；acquire 是普通 JS 函数调用，
 *     不是事件队列消息，**不**有时序竞态。
 *   - launcher 在打开 Session Window 之前**先**把 capsule 放进 registry；
 *     Session Window 可能在 launcher 之后 mount，所以 acquire 既要支持
 *     "立即返回"也要支持"launcher 还在准备"（返回 Promise）。
 *   - acquire 成功一次后 launcher 把对应 entry 从 registry 删除，保证
 *     一次性消费（与 `AppBootstrapPayload.launchToken` 一次性语义对齐）。
 *   - URL 中只承载 `bootstrapToken=<id>`（不透明 ID，非敏感），URL
 *     不承载 capsule 内容。
 *   - Session Window 端的 consume 逻辑封装在
 *     `consumeLauncherBootstrap()`；launcher 端的安装逻辑封装在
 *     `installLauncherBootstrapRegistry()`。
 */
export interface LauncherBootstrapRegistry {
  /**
   * Session Window 主动调此函数拉取 capsule。
   *
   * @param token launcher 写入 URL 的 `bootstrapToken`，与 launcher
   *   注册时的 key 一一对应。
   * @returns 成功返回 capsule；token 未知 / 已消费 / launcher 已
   *   关闭 → 返回 null。launcher vault 未解锁 / 无 active key → throw。
   */
  acquire(token: string): Promise<AppBootstrapPayload | null>;
}

/**
 * 安装 launcher 端 bootstrap registry。
 *
 * 设计缘由：
 *   - launcher 在打开 Session Window 之前调用本函数挂好 registry；
 *     Session Window mount 后通过 `window.opener.__...__.acquire(token)`
 *     拉取 capsule。
 *   - 返回 uninstall 函数；launcher 自己决定何时卸载（launcher 关闭、
 *     Session Window 消费完、明确放弃时）。
 *   - 挂载前 launcher 自己持有 `Map<token, AppBootstrapPayload>`；
 *     acquire 命中即 `delete`。
 *   - 同一窗口只允许挂一个 registry；重复挂载会覆盖并返回旧 uninstall。
 */
export function installLauncherBootstrapRegistry(
  host: Window,
  registry: LauncherBootstrapRegistry
): () => void {
  const symbol = "__keymaster_session_window_bootstrap__" as keyof Window;
  const previous = host[symbol] as LauncherBootstrapRegistry | undefined;
  (host as unknown as Record<string, unknown>)[symbol] = registry;
  return () => {
    const current = host[symbol] as LauncherBootstrapRegistry | undefined;
    if (current === registry) {
      if (previous) {
        (host as unknown as Record<string, unknown>)[symbol] = previous;
      } else {
        delete (host as unknown as Record<string, unknown>)[symbol];
      }
    }
  };
}

/**
 * Session Window 端：启动一次性的 launcher bootstrap consume 流程。
 *
 * 流程：
 *   1. 解析 URL `?bootstrapToken=<id>`（opaque、非敏感）；
 *   2. 校验 `window.opener` 存在、未关闭、当前 origin 同 launcher origin；
 *   3. 校验 opener 上挂的 `__keymaster_session_window_bootstrap__.acquire`
 *      是函数；
 *   4. 调 `acquire(token)`，与超时定时器 race；
 *   5. 返回 capsule；token 未知 / launcher 异常 / 超时 → 返回 failureReason。
 *
 * 设计缘由：
 *   - 整个 consume 是同源直接调用，**不**挂 message listener，**不**
 *     做 postMessage handoff——完全消除"launcher 在子窗口 listener
 *     挂好之前发消息导致丢失"的时序竞态。
 *   - 一次成功调用之后 launcher 端应把对应 entry 从 registry 删除；
 *     Session Window 端**不**重复调 acquire（`awaitLauncherBootstrap`
 *     内部幂等）。
 */
export interface SessionWindowBootstrapConsumerInput {
  /** URL 解析出来的 bootstrapToken；opaque、不透明。 */
  token: string | null;
  /** Session Window 的 `window.opener`，即 launcher 的 window。 */
  opener: Window | null;
  /** 当前窗口 origin（用于同源校验）。 */
  ownOrigin: string;
  /** 超时毫秒；到点未拉到 capsule → fail-closed。 */
  timeoutMs: number;
}
export interface SessionWindowBootstrapConsumerOutput {
  bootstrap: AppBootstrapPayload | null;
  /** 失败原因；null 表示成功。 */
  failureReason: string | null;
}

/**
 * 从 URL 解析 bootstrap token；不存在时返回 null。
 *
 * 设计缘由：URL 只承载 `?boot=appView&bootstrapToken=<id>`。token 是
 * launcher 生成的不透明 ID，本身**不**敏感；URL 中**不**承载 capsule。
 */
export function parseBootstrapToken(search: string): string | null {
  if (typeof search !== "string" || search.length === 0) return null;
  const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
  const t = params.get("bootstrapToken");
  return t && t.length > 0 ? t : null;
}

/**
 * 从 URL 解析 `sessionWindowOrigin`。
 *
 * 设计缘由（施工单 2026-06-30 004 硬切换）：
 *   - appView / launch 模式下 transport target origin 真值 =
 *     `sessionWindowOrigin`：Session Window 在 `openClientApp()` 时
 *     把自己的 `window.location.origin` 显式注入 child app URL；下游
 *     client app 在 appView 模式下**只**认这个值，**不**再读 UI /
 *     用户输入的 `targetOrigin`。
 *   - 校验：必须是完整 origin（scheme + host + 合法端口），不允许省略
 *     scheme、不允许只传 `domain:port`、不允许传 `*` / 非 http(s)
 *     scheme（file: / blob: / data: / chrome-extension: 等）。
 *   - 校验失败或缺失一律返回 null；调用方按 fail-closed 处理。
 */
export function parseSessionWindowOrigin(search: string): string | null {
  if (typeof search !== "string" || search.length === 0) return null;
  const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
  const raw = params.get("sessionWindowOrigin");
  if (!raw || raw.length === 0) return null;
  if (raw === "*") return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.origin !== raw) return null;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.origin;
}

/* ============== Method dispatch ============== */

/**
 * 方法 -> 请求参数类型 的映射。`MethodParams<M>` 是计算出的参数类型。
 * 业务代码里直接 `MethodParams<"identity.get">` 等价于 `IdentityGetParams`。
 */
export interface MethodParamsMap {
  "identity.get": IdentityGetParams;
  "intent.sign": IntentSignParams;
  "cipher.encrypt": CipherEncryptParams;
  "cipher.decrypt": CipherDecryptParams;
  "p2pkh.transfer": P2pkhTransferParams;
  "feepool.prepare": FeepoolPrepareParams;
  "feepool.commit": FeepoolCommitParams;
  "connect.login": ConnectLoginParams;
  "connect.resume": ConnectResumeParams;
  "connect.logout": ConnectLogoutParams;
  "connect.launch": ConnectLaunchParams;
}

export type MethodParams<M extends ProtocolMethod> = M extends keyof MethodParamsMap
  ? MethodParamsMap[M]
  : never;

export interface MethodResultMap {
  "identity.get": IdentityGetResult;
  "intent.sign": IntentSignResult;
  "cipher.encrypt": CipherEncryptResult;
  "cipher.decrypt": CipherDecryptResult;
  "p2pkh.transfer": P2pkhTransferResult;
  "feepool.prepare": FeepoolPrepareResult;
  "feepool.commit": FeepoolCommitResult;
  "connect.login": ConnectLoginResult;
  "connect.resume": ConnectResumeResult;
  "connect.logout": ConnectLogoutResult;
  "connect.launch": ConnectLaunchResult;
}

export type MethodResult<M extends ProtocolMethod = ProtocolMethod> = M extends keyof MethodResultMap
  ? MethodResultMap[M]
  : never;

/* ============== popup 命令流（施工单 002：popup 复用与命令流） ============== */

/**
 * popup 命令卡状态。**不**与"会话生命周期"耦合——一条命令从收到
 * 合法 request 走到最终决定（approved / rejected / failed），状态
 * 由 service 在状态推进时同步更新。
 *
 * 历史 DB 持久化的是 `ProtocolCommandRecord.phase` / `status` /
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
 *     让 DB 旧记录仍能被新逻辑识别。
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
 *   - DB 真值 = Keymaster IndexedDB；UI 文案可显示"站点 / 域名"，
 *     但 DB 落盘必须是 `event.origin` 原样字符串。
 *   - 不持久化私钥 / 大体积密文 / 完整签名结果 / 解密明文 / 完整 rawTx。
 *   - **owner 唯一真值 = `ownerPublicKeyHex`**：所有业务方法在 record
 *     创建时即快照 `connectSessionId` + `ownerPublicKeyHex`；执行时不再
 *     改写归属。`ownerKeyId` 不再出现。
 *
 * 字段语义扩展（p2pkh + feepool + connect）：
 *   - `recipientAddress` / `amountSatoshis` 摘要显示用；不要把整笔交易存进来。
 *   - `action` 只在 feepool.prepare/commit 上填写。
 *   - `operationId` 只在 feepool.commit 上填写（指向 prepare 阶段产的 op）。
 *   - `counterpartyPublicKeyHex` 只在 feepool.prepare/commit 上填写。
 *   - `connectSessionId` 业务方法（除 `connect.login`）必填；记录创建时
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
   * 该 record 所属 connect sessionId（业务方法必填；`connect.login` 为空）。
   *
   * 关键不变量（施工单 2026-06-28 002 硬切换）：record 创建时立即绑定，
   * record 生命周期内**不**可漂移——不允许"旧请求漂进新 session"。
   */
  connectSessionId: string;
  /**
   * 该 record 在创建时快照的 owner public key hex。
   *
   * 关键不变量（施工单 2026-06-28 002 硬切换）：
   *   - 取自 `connectSession.ownerPublicKeyHex`（业务方法）或
   *     `connectLoginSelected`（connect.login）；
   *   - record 生命周期内**不**可变；
   *   - **不**再读取当前 active key；后续写卡**不**再读 keyspace.active()。
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
  /** DB 读 / 写是否可用；false 时 UI 顶部显示"历史不可用"。 */
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
 *       1. `bootstrap_owner`：launcher / bootstrap 继承过来的 owner runtime
 *          （appView mode 下 `applyLauncherBootstrap` 注册到
 *          `ownerRuntimesBySessionId` 后即对当前窗口持续有效）；
 *       2. `vault_unlock`：本窗口用户后续通过本地 vault 解锁得到的
 *          owner runtime。
 *   - UI 据此决定渲染锁屏页还是主 popup；accept 阶段据此决定 request
 *     推进到 `confirming` / `queued` 还是 `waiting_unlock_*`。
 */
export type ProtocolPopupLockState = "locked" | "unlocked";

/**
 * 命令流 DB capability key。manifest 在 setup 阶段 provide；
 * ProtocolService 通过 ctx 注入，**不**直接 import DB 模块。
 */
export const PROTOCOL_COMMAND_DB_CAPABILITY = "protocol.commandDb";

/**
 * 协议存储 DB capability key。
 *
 * 设计缘由（施工单 002 硬切换）：原 `PROTOCOL_COMMAND_DB_CAPABILITY` 只承载
 * commands store；本次把 DB 升级到 3 store（commands / origins / feePools），
 * capability 同步改名。manifest 在 setup 阶段 provide，service 通过 deps
 * 注入，**不**直接 import DB 模块。
 */
export const PROTOCOL_STORAGE_DB_CAPABILITY = "protocol.storageDb";

/**
 * 协议存储 DB 抽象。实现走 IndexedDB；测试用 `fake-indexeddb`。
 *
 * 关键不变量：
 *   - DB 名固定 `keymaster.protocol`。施工单 2026-07-01 001 硬切换：
 *     物理删除 `storageProviderConfig` store；DB version 升 9。
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
 *   - DB 异常一律 `console.error + rethrow`；调用方决定怎么降级（p2pkh
 *     走 manual confirm、feepool fail-closed、connect session 不可用
 *     时 caller 被要求重新登录）。
 */
export interface ProtocolStorageDb {
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

  /* ----- connectSessions ----- */
  /**
   * 写一条 connect session 记录；同 sessionId 覆盖。
   *
   * **不**写密码 / 解锁运行时材料；只写 public 字段
   * （sessionId / origin / ownerPublicKeyHex / claimsSnapshot / 时间戳 /
   * revokedAt）。`connectSessions` store 不允许出现私钥材料或密码字段。
   */
  putConnectSession(record: ConnectSessionRecord): Promise<void>;
  /** 按 sessionId 读一条 connect session。 */
  getConnectSession(sessionId: string): Promise<ConnectSessionRecord | null>;
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
   * 当前内存上下文。**不**写 IndexedDB——V1 显式要求 launchToken 只
   * 存在 Session Window 当前内存，刷新 / 关闭即失效。本接口保留
   * 为可选（实现可走内存 Map），便于将来如果需要"重启 launcher 后仍
   * 能恢复 launchToken"再开启持久化路径。
   */
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
 *       * `connectSessionId`：bootstrap 期 launcher 已建的 session；
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
  connectSessionId: string;
  ownerPublicKeyHex: string;
  resolvedClaims: Record<string, ResolvedClaimValue>;
  resolvedAt: number;
  consumed: boolean;
  expiresAt: number;
}

/**
 * （施工单 002 收尾反馈：已废弃并删除）
 *
 * 原本想用 system-level bridge 暴露 `feePoolDefaultFundSatoshis`，
 * 实际收口为 per-origin 字段 `ProtocolOriginSettingsRecord.feePoolDefaultFundSatoshis`。
 * 本接口不再导出；service / manifest / settings 页一并删除。
 */

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
   *   - `bootstrap_owner`：appView mode 下 launcher 一次性注入的
   *     owner runtime，bootstrap 成功后即对当前窗口持续有效。
   *   - `vault_unlock`：本窗口用户后续通过本地 vault 解锁。
   *   - 任一可用即 `unlocked`；二者皆不可用才是 `locked`。
   *
   * 注意：`phase` 与 `lockState` 是两层语义；不允许把 phase 改写
   * 成 lockState，也不允许把 lockState 合并进 phase。
   */
  lockState: ProtocolPopupLockState;
}

/* ============== capability ============== */

/** ProtocolService capability key。 */
export const PROTOCOL_SERVICE_CAPABILITY = "protocol.service";

/**
 * 协议 service 对外契约。`apps/web` / `ProtocolPopupPage` 通过
 * `useCapability<ProtocolService>(PROTOCOL_SERVICE_CAPABILITY)` 拿到实例。
 *
 * 设计缘由：service 负责 transport + 校验 + 解锁 + 确认流调度 + 调用
 * vault / keyspace + 构造 envelope + 签名 / 加解密；UI 只负责渲染态。
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
 *   - 所有 p2pkh 业务能力（listUtxos / prepareTransfer / submitTransfer）
 *     **必须**接受 `ownerPublicKeyHex` 维度。owner 是 connect session 绑定
 *     的 owner；plugin-protocol 永远**不**传当前钱包 active key 给 p2pkh
 *     适配层——只有 session 绑定的 owner 才是真值。`ownerPublicKeyHex`
 *     缺省视作旧路径的"取 active key"语义（**仅**为旧测试 / 兜底保留）；
 *     002 之后所有业务方法都强制传 owner。
 */
export interface P2pkhProtocolAdapter {
  /**
   * 列指定 owner 在指定 assetId 下的 UTXO（mainnet P2PKH）。
   *
   * `ownerPublicKeyHex` 必填；缺省 = "取 active key namespace"是
   * 兜底路径，**只**为兼容旧调用。002 之后所有调用方都应传 owner。
   */
  listUtxos(filter?: {
    assetId?: string;
    ownerPublicKeyHex?: string;
  }): Promise<Array<{ txid: string; vout: number; value: number }>>;
  /**
   * 准备 p2pkh 转账预览。
   *
   * `ownerPublicKeyHex` 必填；plugin-protocol 永远传 session 绑定 owner。
   * UTXO 选币 + 签名都按该 owner 走，**不**读全局 active key。
   */
  prepareTransfer(input: {
    assetId: "bsv";
    ownerPublicKeyHex: string;
    recipientAddress: string;
    amountSatoshis: number;
    feeRateSatoshisPerKb: number;
  }): Promise<{
    assetId: "bsv";
    network: "main";
    recipientAddress: string;
    amountSatoshis: number;
    feeRateSatoshisPerKb: number;
    allocation: unknown;
    changeAddress: string;
    outputs: Array<{ address: string; value: number }>;
    estimatedFeeSatoshis: number;
    serializedSizeBytes: number;
    txid: string;
    rawTxHex: string;
  }>;
  /**
   * 广播已签名 transfer preview。
   *
   * `ownerPublicKeyHex` 必填：plugin-p2pkh 在 submit 阶段会校验 resource
   * / 签名 key 与该 ownerPublicKeyHex 一致——owner 变了就拒绝广播。
   */
  submitTransfer(preview: {
    assetId: "bsv";
    network: "main";
    ownerPublicKeyHex: string;
    recipientAddress: string;
    amountSatoshis: number;
    feeRateSatoshisPerKb: number;
    allocation: unknown;
    changeAddress: string;
    outputs: Array<{ address: string; value: number }>;
    estimatedFeeSatoshis: number;
    serializedSizeBytes: number;
    txid: string;
    rawTxHex: string;
  }): Promise<{
    status: string;
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
  confirmByUser(recordId?: string): Promise<void>;
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
   * 读 origin 配置；DB 不可用或该 origin 尚未配置时返回 null。
   * UI 用此填默认 + 弹 modal 编辑当前 origin。
   */
  getOriginSettings(origin: string): Promise<ProtocolOriginSettingsRecord | null>;
  /**
   * 写 origin 配置；DB 不可用时 throw（由调用方决定怎么降级）。
   */
  setOriginSettings(record: ProtocolOriginSettingsRecord): Promise<void>;
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
   *     ——任一来源（`bootstrap_owner` / `vault_unlock`）可用即
   *     `unlocked`，二者皆不可用才是 `locked`。
   *   - appView bootstrap 完成后 Session Window 即视为 unlocked；
   *     后续即便 vault 被 relock，只要 bootstrap_owner runtime 仍在
   *     `ownerRuntimesBySessionId` 内，就保持 unlocked。
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
  /**
   * 暴露底层 vault service 引用（施工单 2026-06-27 001 反馈修复）。
   *
   * 设计缘由：vault 状态变化（unlock / relock）需要在 popup 顶层监听，
   * 跨 locked / unlocked 视图切换仍生效。UI 不应再 useCapability 拿
   * 一个独立的 vault 实例——会双订阅。
   */
  getVaultService(): VaultService;
  /**
   * 由 popup 顶层 vault.onStatusChange 调用的切换入口。
   *
   * 设计缘由（施工单 2026-06-30 003 硬切换 4.5）：
   *   - 传入的 `locked` 仅表达当前 vault 状态；最终 `lockStateValue`
   *     由 service 内部用 `computeLockState()` 同时参考 vault 状态 +
   *     `ownerRuntimesBySessionId` 是否非空统一决定。
   *   - 因此：
   *       * vault unlock 后 → 至少有一路 owner runtime 可用 → unlocked；
   *         已存在的 `waiting_unlock_*` 记录批量推进到
   *         `confirming` / `queued`。
   *       * vault lock 后 → 如果 `ownerRuntimesBySessionId` 里还保留
   *         bootstrap_owner runtime，仍维持 unlocked；否则推回 locked
   *         并触发 `confirming` → `waiting_unlock_manual` 的硬收口。
   *   - 同方法也被 `applyLauncherBootstrap` 在注册完 owner runtime 后
   *     调用一次，使 appView bootstrap 完成即可立刻把当前 Session Window
   *     视为 unlocked。
   */
  setVaultLockState(locked: boolean): void;

  /* ============== Session Window（施工单 2026-06-29 001 硬切换） ============== */

  /**
   * Session Window 当前 boot mode。
   *
   * 设计缘由（施工单 2026-06-29 001 硬切换）：
   *   - `connect` 是缺省 mode；`appView` 是 launcher 启动模式。
   *   - mode 仅在启动阶段决定；一旦 session 建立，后续执行路径不再
   *     区分两种 mode（`connect.resume` / `cipher.*` 都
   *     按同一套代码走）。
   */
  bootMode(): "connect" | "appView";

  /**
   * 当前 appView 上下文。
   *
   * 设计缘由：
   *   - 仅当 Session Window 处于 `appView` mode 且 bootstrap 成功后
   *     非空；`connect` mode 下恒为 null。
   */
  appViewContext(): AppViewContext | null;

  /**
   * appView bootstrap 是否已失败。
   *
   * 设计缘由（修复 issue #3）：
   *   - 这里只承载 launcher -> Session Window 这一步的硬失败：
   *       - launcher 在合理时间（如 30s）内未把 bootstrap 发过来；
   *       - bootstrap payload / owner runtime bootstrap 校验失败。
   *   - UI 据此渲染明确错误态，让用户关闭 Session Window 重新从 launcher
   *     启动 app。**不**无限等待。
   *   - `Open App` 后 child app 连接超时属于软超时，不写进这里；迟到连接
   *     仍允许恢复。
   */
  bootstrapFailed(): boolean;
  /** bootstrap 失败原因（仅本地历史；不进对外 result）。 */
  bootstrapFailureReason(): string | null;

  /**
   * `Open App` 后 child app 是否已触发连接超时提示。
   *
   * 设计缘由（施工单 2026-06-30 003 硬切换）：
   *   - Session Window 点击 `Open App` 后会启动 5s 软超时；
   *   - 若 5s 内仍未收到合法 child `ready`，UI 要提示"连接较慢"。
   *   - 这是**软超时**：只清掉等待态、提示用户；不重建 `connectSessionId`、
   *     不重新 bootstrap、不偷偷补偿；按钮恢复可点。
   *   - 迟到 child `ready` 仍允许进入 popup 阶段；同时清掉本提示。
   *   - 跑 `connect.*` / 业务方法的请求与本超时**互不绑定**——超时只表达
   *     "child 还未声明 listener 就绪"，不是"child 没在工作"。
   */
  appClientConnectTimedOut(): boolean;

  /**
   * Session Window 启动早期是否有"等待 child `ready`"的活跃等待态。
   *
   * 设计缘由（施工单 2026-06-30 003 硬切换）：
   *   - true：用户点过 `Open App`，且 child `ready` 仍未到达、5s 软超时
   *     也未到点；UI 用此把 `Open App` 按钮置为 disabled。
   *   - false：未点过 `Open App`、child `ready` 已到达、软超时已触发，
   *     三者任一即 false。**不**因为该 flag 重新进入 waiting。
   *   - 软超时到点**只**让本 flag 翻回 false；**不**重建 `connectSessionId`、
   *     **不**重发 bootstrap、**不**重开 child 窗口。
   */
  appClientWaitingForReady(): boolean;

  /**
   * child app 是否已"活着"（施工单 2026-06-30 003 硬切换）。
   *
   * 设计缘由：
   *   - `ready` 方向对称：`client web -> Session Window` 发 `ready`
   *     （与传统 popup 流 `Session Window -> client web` 对称）。
   *   - UI 的 appView 两段式切换信号不**只**盯显式 `ready`——首条
   *     合法 child 协议消息（无论是顶层 `ready` 还是首条 `connect.*`
   *     request / cancel）都视为 child 已"活着"，立刻把 UI 切到
   *     传统 popup。`childReady` 一旦 true 在 Session Window 生命周期
   *     内不再回 false。
   *   - 合法性统一按 `event.origin === appViewContext.appOrigin` +
   *     `currentAppClientSource`（如已绑定）双重校验。
   *   - `connect mode` 下恒为 false；`appView mode` 但 bootstrap 未完成
   *     也恒为 false。
   */
  childReady(): boolean;

  /**
   * Session Window 主动从同源 `window.opener` 拉取 bootstrap capsule。
   *
   * 设计缘由（施工单 2026-06-29 001 硬切换 + 用户确认；修复 issue #1）：
   *   - **不**做 postMessage handoff——postMessage 是事件队列，launcher
   *     在子窗口 message listener 挂好之前发消息会**丢失**。
   *   - Session Window mount 时**主动**调 launcher `window` 上的
   *     `__keymaster_session_window_bootstrap__.acquire(token)`（同源
   *     普通 JS 函数调用），把 token 作为不透明 ID 通过 URL
   *     `?bootstrapToken=<id>` 传递。
   *   - 内部走 `consumeLauncherBootstrap` helper：读 URL token + 校验
   *     `window.opener` 同源 + 读 registry + 调 `acquire(token)` + race
   *     超时（30s 默认）。到点未拉到 → `bootstrapFailed = true`，UI 渲染
   *     错误态；用户可关闭 Session Window 重新从 Keymaster 启动 app。
   *   - launcher 自己持有 `Map<token, AppBootstrapPayload>`；`acquire`
   *     命中即从 map 删除——一次性消费。
   *   - 该方法**幂等**：第二次调用直接忽略。
   */
  awaitLauncherBootstrap(): void;

  /**
   * Session Window bootstrap 成功后调用：把 client app URL（含 launchToken）
   * 在命名窗口打开。Session Window 与 client app 后续走现有 transport
   * （child → Session Window `ready` → request → result）。
   *
   * 设计缘由（施工单 2026-06-30 003 硬切换）：
   *   - 仅允许在 appViewContext 非空时调用；否则 throw。
   *   - **不**带 `noopener`：client app 必须能拿到 `window.opener =
   *     Session Window`，否则无法把第一条 `connect.launch` 发回。
   *   - 命名窗口 target = `keymaster-app-<encodeOrigin(appOrigin)>`；
   *     浏览器会按 target 复用同一扇 child app 窗口，避免 `_blank`
   *     每次点 `Open App` 都新开一扇。
   *   - **不**主动向 child 发 `ready` / 不再走 ready 泵：
   *     `ready` 方向对称要求 child 在自己的 listener 就绪后向 Session
   *     Window 发 `ready`。Session Window 不再猜测 child listener 是否
   *     就绪。
   *   - **不**负责 child app 的运行期状态；运行期交互完全走现有 popup
   *     transport（child 发 `ready` → Session Window 进入 popup 阶段 →
   *     child 发 request → Session Window 回 result）。
   *   - 5s 软超时只用于 UI 提示"连接较慢"；到点只清等待态，**不**重建
   *     `connectSessionId` / `launchToken` / bootstrap。
   *   - 返回被打开的 window；失败返回 null（best-effort）。
   */
  openClientApp(): Window | null;

  /* ============== plugin-apps launcher 启动入口（施工单 2026-06-29 002 硬切换） ============== */

  /**
   * Keymaster 内部 app launcher 启动入口（`plugin-apps` 唯一允许依赖）。
   *
   * 设计缘由（施工单 2026-06-29 002 硬切换）：
   *   - 这是 plugin-apps 唯一允许的 appView 启动入口。plugin-apps 自己
   *     **不**直接 import / 操作：
   *       - `protocolStorageDb`
   *       - `buildAppBootstrapPayload`
   *       - `installLauncherBootstrapRegistry`
   *       - `window.open("/protocol/v1/popup?...")` popup URL
   *     这些细节全部收口在 service 内部，避免协议真值散落到业务插件。
   *   - 完整流程（施工单 2026-06-30 002 硬切换）：
   *       1. 校验 vault 已解锁 + active key ready + owner key 有 vault keyId；
   *       2. 校验 app 配置合法（`new URL(appUrl).origin === appOrigin`）；
   *       3. 解析 claims 快照（按 input.claims 走 builtin claim 解析）；
   *       4. 创建新 `connectSessionId` 并落 DB，写 session 真值三元组
   *          （sessionId + origin + ownerPublicKeyHex）；
   *       5. 调 `vault.withPrivateKey(keyId, fn)` 借出 owner 私钥 hex，
   *          组装 `OwnerRuntimeBootstrap`；
   *       6. 生成 `launchToken`；
   *       7. 组装 `AppBootstrapPayload`（含 `ownerRuntimeBootstrap`，
   *          **不**含 unlock runtime）；
   *       8. 在 launcher window 上挂一次性 bootstrap registry；
   *       9. `window.open("/protocol/v1/popup?boot=appView&bootstrapToken=...")`。
   *   - 任何一道闸失败：throw，**不**补偿、**不**回退、**不**做"半启动"。
   *     `plugin-apps` 必须以"打开失败就失败"语义收口。
   *   - session 在 launcher 点击 `Open App` 时**预建**；`connect.launch`
   *     只消费 `launchToken`、不创建 session。
   */
  launchAppView(input: LaunchAppViewInput): Promise<LaunchAppViewResult>;

  /* ============== connect.*（施工单 2026-06-28 001 硬切换） ============== */

  /**
   * 当前 popup 是否存在"等待用户处理"的 connect login 流程。
   * 兼容旧 UI；新 UI 应优先读 `connectAuthSnapshot()`。
   */
  connectLoginRecord(recordId?: string): {
    recordId: string;
    method: "connect.login";
    availableKeys: Array<{ publicKeyHex: string; label: string }>;
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
  confirmConnectLogin(recordId: string, ownerPublicKeyHex: string, password: string): Promise<void>;
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
