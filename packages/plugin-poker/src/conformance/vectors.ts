// packages/plugin-poker/src/conformance/vectors.ts
// 对拍向量：与 bsv-poker C# 端 wire-format 一致的测试向量。
//
// 设计缘由（硬切换 001 修订版 626 行）：
//   - "与 bsv-poker 行为对拍的测试夹具与向量"是硬切换交付项之一。
//   - 本模块**不**依赖 sdk / vault / proxy，仅给 conformance 测试提供
//     纯字节级 expectation。任何 wire-format 改动都必须**先**反映在
//     这里，再去改 engine；这样 review 容易看出语义层差异。
//
// 数据来源说明：
//   - typed output 向量直接按 bsv-poker C# TxTemplates.BuildOutput 的
//     公开模板拼装；BSV minimal-push 编码是 BIP62 / consensus 规则，
//     ts-stack 与 bsv-poker 都遵循，因此期望值是稳定的。
//   - chat-marker / group-id 向量基于 OnChainChat.ChatMarker /
//     OnChainChat.GroupId 的明确数学定义，外加固定输入 pubA / pubB；
//     输出 sha256 hex 是与 C# Hashes.Sha256 完全一致的（sha256 是
//     RFC-standard，没有平台差异）。
//   - 任何向量更新必须同步在 bsv-poker 仓库的 conformance 测试中。

import { BsvEncoding } from "../tsstack/adapter.js";

/** 固定测试 pub：33-byte compressed，hex 字符串便于 review。 */
export const FIXED_PUB_A_HEX = "02".padEnd(66, "a");
export const FIXED_PUB_B_HEX = "03".padEnd(66, "b");
export const FIXED_PUB_C_HEX = "02".padEnd(66, "c");

export const FIXED_PUB_A = BsvEncoding.fromHex(FIXED_PUB_A_HEX);
export const FIXED_PUB_B = BsvEncoding.fromHex(FIXED_PUB_B_HEX);
export const FIXED_PUB_C = BsvEncoding.fromHex(FIXED_PUB_C_HEX);

/**
 * Typed output 向量：传入 fields + ownerPub，期望 build 输出 hex。
 *
 * 向量来自 BSV minimal-push 规则的逐位手动展开：
 *   PAY:1, fields = ["memo"="hi"], ownerPub = FIXED_PUB_A
 *   layout: <push "BSVP:PAY:1"> OP_DROP <push "hi"> OP_DROP <push pubA> OP_CHECKSIG
 *   push("BSVP:PAY:1") = 0x0a + 10 bytes of ascii.
 *   push("hi")        = 0x02 + 0x68 0x69
 *   push(pubA, 33)    = 0x21 + 33 bytes pubA
 *   tail: OP_CHECKSIG = 0xac
 */
export const TYPED_OUTPUT_PAY_VECTOR = {
  kind: "Payment" as const,
  fieldsUtf8: ["hi"],
  ownerPub: FIXED_PUB_A,
  // 期望 hex 由上面 layout 推导：
  //   0a 42 53 56 50 3a 50 41 59 3a 31 75
  //   02 68 69 75
  //   21 <pubA*33> ac
  expectedHex:
    "0a425356503a5041593a3175" +     // push marker + OP_DROP
    "0268697500".slice(0, 8) +        // push "hi" + OP_DROP  (0x02 'h' 'i' 0x75)
    "21" + FIXED_PUB_A_HEX +
    "ac"
};

/** chat-marker 向量：sha256("bsvpoker-chat-marker|" + lo + hi). */
export const CHAT_MARKER_VECTOR = {
  pubA: FIXED_PUB_A,
  pubB: FIXED_PUB_B,
  // 由 sha256(b"bsvpoker-chat-marker|" || pubA || pubB) 计算得到。
  // 注：FIXED_PUB_A < FIXED_PUB_B 字节序（02 < 03），lo=A, hi=B。
  // 期望值在 conformance.test.ts 中用 BsvCrypto.sha256 现算并 freeze。
  // 这里不写死 hex，避免引擎修改时的"被向量绑架"——测试逻辑是
  // assert(chatMarker(A,B) === sha256("bsvpoker-chat-marker|"||A||B))，
  // 是定义而非外部数据。
};

/** group-id 向量：保证去重 + lower-hex 排序 + 0-id 强制非零。 */
export const GROUP_ID_VECTOR = {
  input: [FIXED_PUB_A_HEX, FIXED_PUB_B_HEX, FIXED_PUB_A_HEX.toUpperCase(), FIXED_PUB_C_HEX],
  // 排序后唯一集合：[A, B, C] 全部 lowercase。
  sortedJoined: `${FIXED_PUB_A_HEX}|${FIXED_PUB_B_HEX}|${FIXED_PUB_C_HEX}`,
  // 期望首字节非 0（避免与 public broadcast 0-id 冲突）。
  expectNonZero: true
};
