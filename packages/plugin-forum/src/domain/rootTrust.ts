// Forum 根信任验证。
//
// 首次连接下载根 raw，然后独立核对三件事，任何一件不通过都不能建立信任：
//   1. raw 的 txid 等于配置的固定根 txid；
//   2. 输出结构恰好两个，findings 都是正数，数据输出固定 1 sat；
//   3. forumSig 从当前声明的名称、价格与**全部 input outpoint 顺序**重建，
//      采用当前四项数组规则（旧三项形式没有兼容路径），并用配置的论坛公钥验签。
//
// 另外核对两个输出都点名同一个论坛公钥：只核对数据输出的话，一份把找零付给
// 别人的「合法」声明也能通过。
//
// 更新公钥必须重新验证根；地址不替代身份。

import type { ForumConfig, ForumRootVerification } from "@keymaster/contracts";

import { bytesToHex, hexToBytes, isCanonicalDer } from "../protocol/bytes.js";
import { sha256Digest, verifyDerSignature } from "../protocol/crypto.js";
import { parseGenesisTransaction } from "../protocol/layout.js";
import { encodeForumSignatureObject } from "../protocol/signatureObjects.js";
import { inputOutpointTxid, parseTransaction, type RawTransaction } from "../protocol/transaction.js";

/** 服务端协议基线版本；协议升级后需要重新核对证据。 */
export const FORUM_SERVER_BASELINE = "bsv8-forum/0.1.0";

export class ForumTrustError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ForumTrustError";
    this.code = code;
  }
}

export interface ForumRootVerificationInput {
  readonly config: ForumConfig;
  /** 首次下载的根 raw 字节。 */
  readonly rawTxBytes: Uint8Array;
  readonly nowMs: number;
}

/**
 * 验证根 raw 并产出可保存的证据。
 *
 * 只做纯计算：网络由调用方负责，这里拿到 raw 就必须能独立判断它配不配得上配置的
 * 论坛公钥。
 */
export function verifyForumRoot(input: ForumRootVerificationInput): ForumRootVerification {
  const { config } = input;
  if (!/^(02|03)[0-9a-f]{64}$/u.test(config.forumPublicKeyHex)) {
    throw new ForumTrustError("forum-key", "配置的论坛服务公钥必须是 33 字节压缩公钥");
  }
  if (!/^[0-9a-f]{64}$/u.test(config.forumTxid)) {
    throw new ForumTrustError("forum-txid", "配置的创世根 txid 必须是 64 字符小写 hex");
  }
  let tx: RawTransaction;
  try {
    tx = parseTransaction(input.rawTxBytes, sha256Digest);
  } catch (error) {
    throw new ForumTrustError("root-parse", `根 raw 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
  // txid 必须是 raw 自身算出来的那个，而不是服务端或配置里声称的那个。
  const txidHex = bytesToHex(tx.txid);
  if (txidHex !== config.forumTxid) {
    throw new ForumTrustError("root-txid", `根 raw 的 txid 是 ${txidHex}，与配置的 ${config.forumTxid} 不一致`);
  }
  let parsed;
  try {
    // input txid 在 raw 里是反向的；这一次反转让 forumSig 覆盖的正是显示顺序。
    parsed = parseGenesisTransaction(tx, (index) => inputOutpointTxid(tx.inputs[index] as never));
  } catch (error) {
    throw new ForumTrustError("root-layout", `根 raw 的输出结构不符合协议：${error instanceof Error ? error.message : String(error)}`);
  }
  // 两个输出必须都点名同一个论坛公钥。
  const forumKey = config.forumPublicKeyHex.toLowerCase();
  if (bytesToHex(parsed.forumPublicKey) !== forumKey) {
    throw new ForumTrustError("root-key-mismatch", "数据输出的论坛公钥与配置不一致");
  }
  if (bytesToHex(parsed.payToPublicKey) !== forumKey) {
    throw new ForumTrustError("root-key-mismatch", "找零输出的收款公钥与配置不一致");
  }
  if (!isCanonicalDer(parsed.forumSig)) {
    throw new ForumTrustError("root-sig-format", "forumSig 不是严格 DER low-S 签名");
  }
  // 从当前声明的名称、价格与全部 input outpoint 顺序重建四项数组。
  const object = {
    kind: "bsv8.forum.1" as const,
    forumName: parsed.forumName,
    tipPrice: parsed.tipPrice,
    inputs: parsed.inputs.map((entry) => ({ txid: hexToBytes(bytesToHex(entry.txid)), vout: entry.vout })),
  };
  let encoded: Uint8Array;
  try {
    encoded = encodeForumSignatureObject(object);
  } catch (error) {
    throw new ForumTrustError("root-sig-object", `无法重建 forumSig 对象：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!verifyDerSignature(hexToBytes(forumKey), sha256Digest(encoded), parsed.forumSig)) {
    throw new ForumTrustError("root-sig-invalid", "forumSig 无法用配置的论坛公钥验证");
  }
  return {
    configId: config.id,
    forumTxid: config.forumTxid,
    // raw 原样保存为 hex；重新编码会改变「证据」本身。
    rawTxHex: bytesToHex(input.rawTxBytes),
    forumName: parsed.forumName,
    tipPrice: parsed.tipPrice.toString(),
    forumPublicKeyHex: forumKey,
    payToPublicKeyHex: bytesToHex(parsed.payToPublicKey),
    verifiedAtMs: input.nowMs,
    baseline: FORUM_SERVER_BASELINE,
  };
}

/** 从已保存的证据恢复信任，用于离线展示。 */
export function rootEvidenceIsUsable(evidence: ForumRootVerification | undefined, config: ForumConfig | undefined): evidence is ForumRootVerification {
  if (evidence === undefined || config === undefined) return false;
  // 换根或换公钥都必须重新验证：地址不替代身份。
  return evidence.forumTxid === config.forumTxid && evidence.forumPublicKeyHex === config.forumPublicKeyHex.toLowerCase();
}