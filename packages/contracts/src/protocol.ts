// packages/contracts/src/protocol.ts
// Keymaster 对外协议 V1 公共契约。
//
// 设计缘由（施工单 001）：
//   - 协议四方法（identity.get / intent.sign / cipher.encrypt / cipher.decrypt）
//     全部走同一套 transport + 同一套 BinaryField + 同一套 ready/request/result
//     状态机；任何一份契约都要与 "硬切换 001" 中列出的核心不变量保持一致。
//   - 本文件**只**放类型与错误码字面量；具体 CBOR 编码、签名、加解密、claim
//     解析都收敛在 `packages/plugin-protocol` 内部，不在 contracts 暴露实现。
//   - 二进制统一用 `BinaryField`，不允许 base64 / stringified ArrayBuffer 偷渡。
//   - `identityEnvelope` / `signedEnvelope` 是最终真值字节（Deterministic CBOR），
//     不是"待调用方重编码的对象"；调用方验签时**直接**对这些字节验签。
//   - `signature.bytes` 固定为 compact 64-byte secp256k1（r || s），不允许双格式。
//   - `event.origin` 在 cipher 路径上**原样**参与站点密钥派生，不做归一化。
//   - 所有错误信息走英文；UI 展示由调用方自己翻译。

/**
 * 二进制字段。V1 协议里所有二进制内容（密文、签名、信封真值、文件本体、
 * 头像本体等）必须包成这种结构；不允许直接传 ArrayBuffer / base64 字符串。
 *
 * structured clone 允许 ArrayBuffer / Uint8Array 走 postMessage；本包装
 * 只是为了让"这是二进制内容"在对象层有显式标记，避免调用方误把
 * base64 / hex 字符串塞进协议层。
 */
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
  "cipher.decrypt"
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

/** 顶层报文 union。 */
export type ProtocolMessage =
  | ProtocolReadyMessage
  | ProtocolRequestMessage
  | ProtocolResultMessage;

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
}

export type MethodParams<M extends ProtocolMethod> = M extends keyof MethodParamsMap
  ? MethodParamsMap[M]
  : never;

export interface MethodResultMap {
  "identity.get": IdentityGetResult;
  "intent.sign": IntentSignResult;
  "cipher.encrypt": CipherEncryptResult;
  "cipher.decrypt": CipherDecryptResult;
}

export type MethodResult<M extends ProtocolMethod = ProtocolMethod> = M extends keyof MethodResultMap
  ? MethodResultMap[M]
  : never;

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
export interface ProtocolService {
  /**
   * 启动一个 popup 会话。同一 service 实例允许多次启动会话（每次都重置
   * 内部状态），但**一次只处理一个 request**。调用方在 popup 加载时
   * 调用一次；之后由 service 自己维护 ready / bind / state。
   */
  startSession(): void;
  /**
   * 关闭当前会话并清理内部状态。UI 在用户关闭 popup / 主动取消时调用。
   */
  endSession(): void;
  /**
   * 接收来自 `window.message` 的事件。UI 监听 message 事件后转发给
   * service。
   */
  handleMessage(event: MessageEvent): void;
  /**
   * 用户在确认页点击"确认"。service 收到后开始执行方法。
   */
  confirmByUser(): Promise<void>;
  /**
   * 用户在确认页或解锁页点击"取消"。service 立即向 opener 回
   * `user_rejected`。
   */
  rejectByUser(): Promise<void>;
  /**
   * 通知 service 钱包已解锁，service 把已绑定 request 推进到
   * confirming 阶段。仅当 phase === "unlocking" 时生效。
   */
  resumeAfterUnlock(): void;
  /**
   * 当前已绑定 request 的拷贝（不绑定时返回 null）。UI 在 confirm 页
   * 用来展示 aud / text / claims / contentType。
   */
  currentRequest():
    | {
        id: string;
        method: ProtocolMethod;
        params: MethodParams<ProtocolMethod>;
      }
    | null;
  /**
   * 订阅会话状态变化，UI 用来驱动页面。
   */
  subscribe(handler: (snapshot: ProtocolSessionSnapshot) => void): () => void;
  /** 同步取当前会话快照。 */
  snapshot(): ProtocolSessionSnapshot;
}
