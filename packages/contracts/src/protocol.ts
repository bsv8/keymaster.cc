// packages/contracts/src/protocol.ts
// Keymaster 对外协议 V1 公共契约。
//
// 设计缘由（施工单 001 + 002 硬切换）：
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
//   - `event.origin` 在 cipher 路径上**原样**参与站点密钥派生，不做归一化；
//     origin settings / fee pool 持久化也按 exact origin 归档。
//   - 所有错误信息走英文；UI 展示由调用方自己翻译。
//   - `p2pkh.transfer` / `feepool.*` 涉及本地敏感信息（余额 / 池状态 / 失败原因）；
//     真实原因只写本地历史；对外统一 `user_rejected`，**不**暴露真实原因。
//   - `feepool.commit` 的 `operationId` 只在 popup 会话内存中有效，
//     不持久化；popup 刷新 / 关闭后 operation 失效。

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
  "feepool.commit"
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

/** identity.get 请求参数。 */
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

/** intent.sign 请求参数。 */
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
}

/** intent.sign 成功结果。 */
export interface IntentSignResult {
  /** 签名信封最终真值字节（Deterministic CBOR）。 */
  signedEnvelope: BinaryField;
  /** 签名（compact 64-byte secp256k1）。 */
  signature: BinaryField;
}

/* ============== cipher.encrypt ============== */

/** cipher.encrypt 请求参数。 */
export interface CipherEncryptParams {
  /** 人类可读确认文案。 */
  text: string;
  /** 调用方自定义的内容类型；与 contentBytes 一起进入密文内层结构。 */
  contentType: string;
  /** 业务字节本体。 */
  content: BinaryField;
}

/** cipher.encrypt 成功结果。 */
export interface CipherEncryptResult {
  /** 本次加密随机生成的 12 字节 nonce。 */
  nonce: BinaryField;
  /** AES-GCM 密文字节（含认证 tag）。 */
  cipherbytes: BinaryField;
}

/* ============== cipher.decrypt ============== */

/** cipher.decrypt 请求参数。 */
export interface CipherDecryptParams {
  /** 人类可读确认文案。 */
  text: string;
  /** 加密时保存的 12 字节 nonce。 */
  nonce: BinaryField;
  /** 加密时保存的密文字节。 */
  cipherbytes: BinaryField;
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
 * 设计缘由（施工单 002 硬切换）：
 *   - 本次只支持 `bsv` 主网 P2PKH 转账。不引入 assetId / network / 多币种
 *     / 多网络协商。
 *   - site 不允许传 `text` / `confirmMessage`：确认文案由 Keymaster 自己
 *     按方法语义生成；不允许 site 伪装转账为登录确认。
 *   - `aud` 不接受：connect popup 已天然拿到 `event.origin` 真值，origin
 *     等价检查由 service 自动执行。
 *   - `feeRateSatoshisPerKb` 可选；缺省时由 service 走一个保守默认值。
 *   - amountSatoshis 是整数 satoshis，不接受小数；feeSatoshis 在 result 里
 *     回。
 */
export interface P2pkhTransferParams {
  /** 主网 P2PKH 地址（base58check，version 0x00）；testnet 直接 invalid_request。 */
  recipientAddress: string;
  /** 正整数 satoshis。 */
  amountSatoshis: number;
  /** 可选 fee rate（sat/kB）。>= 1。 */
  feeRateSatoshisPerKb?: number;
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
 * 设计缘由（施工单 002 硬切换 + 收尾反馈）：
 *   - site **不**传 `action` / `lockHeight` 等策略字段；action（create /
 *     spend / close_and_recreate）和 lockHeight 由 Keymaster 单边决定。
 *   - site 只提交：
 *       - `counterpartyPublicKeyHex`：对端公钥。
 *       - `amountSatoshis`：**本次想转给对端的金额**（satoshis）。
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
 */
export interface FeepoolCommitParams {
  /** 由 `feepool.prepare` 返回的 operationId；只在本 popup 会话内有效。 */
  operationId: string;
  /** 33-byte compressed secp256k1 公钥 hex。 */
  counterpartyPublicKeyHex: string;
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
 * 设计缘由（V4 收口）：feepool 真实模型是两笔 tx：
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
 *   - key 必须包含 counterpartyPublicKeyHex：同一 origin 可能切换对端公钥，
 *     旧池不应串到新池。
 *   - key 格式：`${origin}::${counterpartyPublicKeyHex}`；`::` 不可能出现在
 *     origin 字符串里（origin 是 URL），实际碰撞风险极低。
 */
export interface ProtocolFeePoolRecord {
  /** `${origin}::${counterpartyPublicKeyHex}` 复合 key。 */
  poolKey: string;
  origin: string;
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
 * 真实失败原因（仅写本地历史；对外统一 `user_rejected`）。
 *
 * 设计缘由：余额不足 / 池缺失 / DB 不可用等都属于本地敏感状态；
 * 站点**不**应通过 `error.message` 反推。V1 把这些原因收口在一个
 * 固定的 union 里；service 层映射到 `ProtocolErrorCode = "user_rejected"`。
 */
export type ProtocolFailureReason =
  | "insufficient_balance"
  | "invalid_address"
  | "invalid_amount"
  | "fee_pool_not_found"
  | "fee_pool_db_unavailable"
  | "unknown_operation"
  | "cross_origin_operation"
  | "request_timeout"
  | "internal_error";

/**
 * 站点配置与费用池状态（施工单 002 硬切换）
 *
 * fee pool 缺省 fund **已收回到 per-origin 配置**
 * （`ProtocolOriginSettingsRecord.feePoolDefaultFundSatoshis`）。
 * 不再有系统级常量 / 不再有 `/settings/protocol` 入口；同一站点不同 origin
 * 之间彼此独立。
 */

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
 * 设计缘由（施工单 002 硬切换）：
 *   - 一条 request = 一条 `ProtocolCommandRecord`；
 *   - 不做 event-sourcing：状态推进直接更新同一条记录；
 *   - 历史只按 `origin`（exact origin，**不**做 host 归一化）归档；
 *   - DB 真值 = Keymaster IndexedDB；UI 文案可显示"站点 / 域名"，
 *     但 DB 落盘必须是 `event.origin` 原样字符串。
 *   - 不持久化私钥 / 大体积密文 / 完整签名结果 / 解密明文 / 完整 rawTx。
 *
 * 字段语义扩展（p2pkh + feepool）：
 *   - `recipientAddress` / `amountSatoshis` 摘要显示用；不要把整笔交易存进来。
 *   - `action` 只在 feepool.prepare/commit 上填写。
 *   - `operationId` 只在 feepool.commit 上填写（指向 prepare 阶段产的 op）。
 *   - `counterpartyPublicKeyHex` 只在 feepool.prepare/commit 上填写。
 *   - `failureReason` 是真实原因（写本地）；对外 `errorCode` 永远是 `user_rejected`。
 *   - `autoApproved` 在 p2pkh.transfer auto 命中时为 true；UI 据此隐藏 confirm 页。
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
  /** identity.get 的请求 claims 列表（其它方法为空数组）。 */
  claimsSummary: string[];
  /** intent.sign / cipher.encrypt / cipher.decrypt 的内容类型。 */
  contentType: string;
  /** 请求正文字节数（cipher.decrypt 时是 `cipherbytes.bytes.byteLength`）。 */
  payloadSize: number;
  /** 执行该命令时 active public key hex；写记录时取一次。 */
  activePublicKeyHex: string;
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
  /** 本地真实失败原因；隐私敏感场景下与对外 `errorCode` 解耦。 */
  failureReason?: ProtocolFailureReason;
  /** p2pkh.transfer auto-approve 命中时为 true；UI 据此跳过 confirm 页。 */
  autoApproved?: boolean;
}

/**
 * popup 内"按当前 origin 归档"的命令流 feed 状态。
 *
 * service 维护的内部状态：每条合法 request 进入时按 `event.origin`
 * 重新载入历史；feed 列表按 `updatedAt desc` 排序。
 *
 * 设计缘由（施工单 2026-06-27 001 硬切换）：
 *   - 加 `lockSummary` 字段给锁屏页提供聚合视图；该字段是从
 *     `commands` 派生出来的，**不**是另一份可变状态。
 *   - `lockSummary` 字段在 unlocked 时是 null；锁屏页不读 commands 走
 *     自己摘要，命令流仍以 commands 为真相源。
 */
export interface ProtocolCommandFeedState {
  /** 当前 popup 服务的 exact origin；未收到第一条 request 时为 null。 */
  currentOrigin: string | null;
  /** 当前 feed 列表（最新在前）。 */
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
 *   - DB 名固定 `keymaster.protocol`，version 2；
 *   - 三 store 各司其职：
 *       - `commands`：命令流历史（一条 request = 一条 record）；
 *       - `origins`：按 exact origin 存站点级配置；
 *       - `feePools`：按 `${origin}::${counterpartyPublicKeyHex}` 复合 key
 *         存费用池状态；
 *   - commands store 索引按 `origin + updatedAt desc`；
 *   - feePools store 索引 `origin`，便于按 origin 列出该站点的所有池；
 *   - `putCommand` / `putOrigin` / `putFeePool` 写同 key 覆盖；
 *   - DB 异常一律 `console.error + rethrow`；调用方决定怎么降级（p2pkh
 *     走 manual confirm、feepool fail-closed）。
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
   * 当前会话级锁状态（施工单 2026-06-27 001 硬切换）。
   * - `unlocked` → 进入主 popup 页面（顶栏 + 命令流 + 站点配置）；
   * - `locked`   → 全页锁屏页（解锁表单 + 待处理摘要）。
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
 * 设计缘由：plugin-protocol 不直接 import plugin-p2pkh（边界检查禁止
 * 插件间互相 import）。这里在 contracts 层定义一个最小子集；plugin-p2pkh
 * 的现有 `P2pkhService` 已经覆盖该子集，manifest setup 时做一次
 * 适配即可。
 */
export interface P2pkhProtocolAdapter {
  /** 列当前 active key 在指定 assetId 下的 UTXO（mainnet P2PKH）。 */
  listUtxos(filter?: { assetId?: string }): Promise<
    Array<{ txid: string; vout: number; value: number }>
  >;
  prepareTransfer(input: {
    assetId: "bsv";
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
  submitTransfer(preview: {
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
   * 同步取当前命令流 feed 状态。`commands` 已是按 `updatedAt desc`
   * 排序后的最新在前列表；UI 拿来直接渲染。
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
   * 当前会话级锁状态（施工单 2026-06-27 001 硬切换）。
   *
   * 同步读：UI 用此决定渲染锁屏页还是主 popup 页面。
   */
  lockState(): ProtocolPopupLockState;
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
   * 语义：
   *   - locked → unlocked：批量推进 `waiting_unlock_*`；manual 进
   *     `confirming`（启动 timer + 异步 clamp 到 DB 真值），auto 进
   *     `queued`；尝试启动执行器。
   *   - unlocked → locked：所有 `confirming` 立即回到
   *     `waiting_unlock_manual` + 清 timer；queued 保持；executing 当前
   *     这条允许跑完；执行器暂停取新任务。
   */
  setVaultLockState(locked: boolean): void;
}
