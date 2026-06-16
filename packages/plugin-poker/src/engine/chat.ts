// packages/plugin-poker/src/engine/chat.ts
// bsv-poker `OnChainChat` 的 TS 对等实现：
//   - 对等的 chat marker / group id 派生（哈希字段必须与 C# bit-for-bit 一致，
//     否则两端无法发现"同一段对话")。
//   - direct chat 对称密钥派生 DirectKey() = HKDF( ECDH(myPriv, otherPub),
//     salt = chatMarker, info = "bsvpoker-dm|" || senderPub || index ).
//   - 群聊（ChatGroup）payload 是 sealed BroadcastEnvelope，这里只解析 groupId
//     与字段；真正的 broadcast-encryption 解封逻辑不在本期硬切换范围内，
//     接口预留 hook 由 pokerProtocolEngine 调用。
//
// 设计缘由（硬切换 001 修订版 619 行）：
//   - chat 的"真值"在哈希派生这一层；不一致就直接拒收消息。本模块给
//     conformance/ 提供可对拍的纯函数。
//   - 不在本文件做实际 AES-GCM seal/open；这部分依赖 BroadcastEncryption
//     的完整实现（C# 引用了专利路径），后续单独硬切换。本模块给出
//     `tryDecryptDirect()` 时只调用注入的 cipher 实现，本身不做 AEAD。

import { BsvCrypto, BsvEncoding } from "../tsstack/adapter.js";

const DM_MARKER_TAG = BsvEncoding.fromUtf8("bsvpoker-chat-marker|");
const DM_INFO_TAG = BsvEncoding.fromUtf8("bsvpoker-dm|");

/**
 * 按 bsv-poker C# OnChainChat.ChatMarker 派生 per-pair chat marker：
 *   marker = sha256( "bsvpoker-chat-marker|" ‖ lo(pubA,pubB) ‖ hi(pubA,pubB) )
 * 排序由 lex compare 决定，使 (A,B) 与 (B,A) 得到同一 marker（对称）。
 */
export function chatMarker(pubA33: Uint8Array, pubB33: Uint8Array): Uint8Array {
  const cmp = compareBytes(pubA33, pubB33);
  const lo = cmp <= 0 ? pubA33 : pubB33;
  const hi = cmp <= 0 ? pubB33 : pubA33;
  const buf = new Uint8Array(DM_MARKER_TAG.length + lo.length + hi.length);
  buf.set(DM_MARKER_TAG, 0);
  buf.set(lo, DM_MARKER_TAG.length);
  buf.set(hi, DM_MARKER_TAG.length + lo.length);
  return BsvCrypto.sha256(buf);
}

/**
 * 把消息序列号编码为 8 字节 big-endian。与 C# OnChainChat.U64Be 一致。
 */
export function u64Be(index: bigint | number): Uint8Array {
  const buf = new Uint8Array(8);
  let v = typeof index === "bigint" ? index : BigInt(index);
  for (let i = 7; i >= 0; i--) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

/**
 * info bytes for HKDF, per bsv-poker DirectKey():
 *   info = "bsvpoker-dm|" ‖ senderPub(33) ‖ index(8 BE)
 */
export function directKeyInfo(senderPub33: Uint8Array, index: bigint | number): Uint8Array {
  const idx = u64Be(index);
  const out = new Uint8Array(DM_INFO_TAG.length + senderPub33.length + idx.length);
  out.set(DM_INFO_TAG, 0);
  out.set(senderPub33, DM_INFO_TAG.length);
  out.set(idx, DM_INFO_TAG.length + senderPub33.length);
  return out;
}

/**
 * ChatGroup 的 group id：sha256(utf8( join("|", sortedLowerHexPubs))).
 *
 * 设计缘由：C# 中 `GroupId` 用 `string.Join("|", sorted(lowerHex))`；任何
 * 字符串拼接 / 排序方式偏离都会得到不同 id，导致两端 group 不互通。
 * 我们用与 C# `string.Join("|")` 完全一致的拼接 + ordinal sort。
 *
 * 注意：member pubs 在 C# 端是 hex 字符串集合；这里也按 lowercase hex 排序。
 * 如果传入的是 byte 数组，调用方先 BsvEncoding.toHex。
 */
export function groupId(memberPubHex: readonly string[]): Uint8Array {
  const cleaned = Array.from(new Set(memberPubHex.map((p) => p.toLowerCase())));
  cleaned.sort(); // Ordinal compare = JS default for ASCII hex.
  const joined = cleaned.join("|");
  const h = BsvCrypto.sha256(BsvEncoding.fromUtf8(joined));
  if (h.every((b) => b === 0)) h[0] = 1; // 避免与"public broadcast"零 id 冲突。
  return h;
}

/** lex compare of two Uint8Arrays（与 C# Comparer<byte[]> ordinal 一致）。 */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/**
 * 解析 ChatDirect 字段（不解密 ciphertext）。
 *
 * 设计缘由：在 ingest 路径上，先按"我是否是 sender / recipient"快速判断
 * 是否需要去 attempts 解密；解密本身由注入的 cipher 实现。
 */
export interface ChatDirectFields {
  senderPub: Uint8Array;
  recipientPub: Uint8Array;
  index: bigint;
  ciphertext: Uint8Array;
}

export function parseChatDirectFields(fields: Record<string, Uint8Array>): ChatDirectFields | null {
  const senderPub = fields["senderPub"];
  const recipientPub = fields["recipientPub"];
  const idx = fields["index"];
  const ciphertext = fields["ciphertext"];
  if (!senderPub || !recipientPub || !idx || !ciphertext) return null;
  if (senderPub.length !== 33 || recipientPub.length !== 33) return null;
  if (idx.length !== 8) return null;
  let index = 0n;
  for (const b of idx) index = (index << 8n) | BigInt(b);
  return { senderPub, recipientPub, index, ciphertext };
}

/** 解析 ChatGroup 字段（不解密 ciphertext）。 */
export interface ChatGroupFields {
  groupId: Uint8Array;
  senderPub: Uint8Array;
  ciphertext: Uint8Array;
  /** "public broadcast" envelope（zero-id）vs 实际 group。 */
  isPublicBroadcast: boolean;
}

export function parseChatGroupFields(fields: Record<string, Uint8Array>): ChatGroupFields | null {
  const gid = fields["groupId"];
  const senderPub = fields["senderPub"];
  const ciphertext = fields["ciphertext"];
  if (!gid || !senderPub || !ciphertext) return null;
  if (gid.length !== 32) return null;
  if (senderPub.length !== 33) return null;
  return {
    groupId: gid,
    senderPub,
    ciphertext,
    isPublicBroadcast: gid.every((b) => b === 0)
  };
}
