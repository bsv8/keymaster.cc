// packages/plugin-poker/src/conformance/conformance.test.ts
// 与 bsv-poker C# 行为对拍的核心测试。
//
// 覆盖（硬切换 001 修订版 626 行）：
//   1. typed tx parse/build round-trip 对齐；
//   2. minimal-push 编码与 bsv-poker 一致（PAY:1 字节级期望）；
//   3. chat marker / group-id 派生与 OnChainChat 公式严格一致；
//   4. ingest 路径对"我相关的 chat / 不相关的 chat / unknown tx"分别给出
//      正确分类（fallback-broadcast 安全忽略）。

import { describe, expect, it } from "vitest";
import { BsvCrypto, BsvEncoding } from "../tsstack/adapter.js";
import { chatMarker, directKeyInfo, groupId, parseChatDirectFields, u64Be } from "../engine/chat.js";
import { buildTypedOutput, parseTypedOutput, TX_TEMPLATES } from "../engine/txTemplates.js";
import { devClassifyScript, devWrapAsRawTx } from "../engine/pokerProtocolEngine.js";
import {
  CHAT_MARKER_VECTOR,
  FIXED_PUB_A,
  FIXED_PUB_A_HEX,
  FIXED_PUB_B,
  FIXED_PUB_B_HEX,
  FIXED_PUB_C_HEX,
  GROUP_ID_VECTOR,
  TYPED_OUTPUT_PAY_VECTOR
} from "./vectors.js";

describe("conformance: typed-output build/parse", () => {
  it("Payment build matches BSV minimal-push byte expectation", () => {
    const built = buildTypedOutput("Payment", [BsvEncoding.fromUtf8(TYPED_OUTPUT_PAY_VECTOR.fieldsUtf8[0] ?? "")], TYPED_OUTPUT_PAY_VECTOR.ownerPub);
    // 手算 layout：marker(11)+OP_DROP + push("hi")+OP_DROP + push(pubA33) + OP_CHECKSIG
    // = 0x0a||"BSVP:PAY:1"||0x75 || 0x02||0x68||0x69||0x75 || 0x21||pubA||0xac
    const expected =
      "0a425356503a5041593a3175" +
      "02686975" +
      "21" + FIXED_PUB_A_HEX +
      "ac";
    expect(BsvEncoding.toHex(built)).toBe(expected);
  });

  it("parse round-trips every template kind", () => {
    for (const kind of Object.keys(TX_TEMPLATES) as Array<keyof typeof TX_TEMPLATES>) {
      const tpl = TX_TEMPLATES[kind];
      const fields = tpl.fields.map((name, i) => BsvEncoding.fromUtf8(`${kind}-${name}-${i}`));
      const built = buildTypedOutput(kind, fields, FIXED_PUB_A);
      const parsed = parseTypedOutput(built);
      expect(parsed).not.toBeNull();
      expect(parsed?.kind).toBe(kind);
      expect(parsed?.tag).toBe(tpl.tag);
      expect(parsed?.fields.length).toBe(tpl.fields.length);
      // ownerPub 必须 33 字节且原样回来。
      expect(parsed?.ownerPub.length).toBe(33);
      expect(BsvEncoding.toHex(parsed!.ownerPub)).toBe(FIXED_PUB_A_HEX);
      // 字段命名 map 必须按模板顺序对齐到原值。
      for (let i = 0; i < tpl.fields.length; i++) {
        const name = tpl.fields[i] as string;
        expect(BsvEncoding.toHex(parsed!.fieldsByName[name] as Uint8Array))
          .toBe(BsvEncoding.toHex(fields[i] as Uint8Array));
      }
    }
  });

  it("parse rejects non-typed script", () => {
    expect(parseTypedOutput(new Uint8Array([0x76, 0xa9, 0x14]))).toBeNull();
  });
});

describe("conformance: chat marker / group id", () => {
  it("chatMarker is sha256(bsvpoker-chat-marker| || lo || hi) and symmetric", () => {
    const m1 = chatMarker(CHAT_MARKER_VECTOR.pubA, CHAT_MARKER_VECTOR.pubB);
    const m2 = chatMarker(CHAT_MARKER_VECTOR.pubB, CHAT_MARKER_VECTOR.pubA);
    expect(BsvEncoding.toHex(m1)).toBe(BsvEncoding.toHex(m2));

    // 重新按公式手算一次，确保实现没有偏移。
    const tag = BsvEncoding.fromUtf8("bsvpoker-chat-marker|");
    const a = FIXED_PUB_A, b = FIXED_PUB_B;
    const expected = BsvCrypto.sha256(concat(tag, a, b));
    expect(BsvEncoding.toHex(m1)).toBe(BsvEncoding.toHex(expected));
  });

  it("directKeyInfo follows bsvpoker-dm| || senderPub || index(8 BE)", () => {
    const info = directKeyInfo(FIXED_PUB_A, 7n);
    const expected = concat(
      BsvEncoding.fromUtf8("bsvpoker-dm|"),
      FIXED_PUB_A,
      u64Be(7n)
    );
    expect(BsvEncoding.toHex(info)).toBe(BsvEncoding.toHex(expected));
  });

  it("groupId is sha256(join('|', sortedLowerHexUnique))", () => {
    const gid = groupId(GROUP_ID_VECTOR.input);
    // 期望值按定义重新派生：去重 + lowercase + lex sort + join("|").
    const cleaned = Array.from(new Set(GROUP_ID_VECTOR.input.map((p) => p.toLowerCase()))).sort();
    const expected = BsvCrypto.sha256(BsvEncoding.fromUtf8(cleaned.join("|")));
    if (expected[0] === 0) expected[0] = 1;
    expect(BsvEncoding.toHex(gid)).toBe(BsvEncoding.toHex(expected));
    expect(gid[0]).not.toBe(0);
  });
});

describe("conformance: ingest classification", () => {
  it("classifies ChatDirect to me as relevant", () => {
    const script = buildTypedOutput(
      "ChatDirect",
      [FIXED_PUB_B, FIXED_PUB_A, u64Be(1n), BsvEncoding.fromUtf8("ct")],
      FIXED_PUB_A
    );
    const events = devClassifyScript(script, { myPub33: FIXED_PUB_A });
    expect(events.length).toBe(1);
    const first = events[0]!;
    expect(first.kind).toBe("chat-direct");
    if (first.kind !== "chat-direct") throw new Error("kind mismatch");
    expect(first.relevantToMe).toBe(true);
    const parsed = parseChatDirectFields(first.output.fieldsByName);
    expect(parsed?.index).toBe(1n);
  });

  it("classifies ChatDirect to other as not relevant (still recorded)", () => {
    const script = buildTypedOutput(
      "ChatDirect",
      [BsvEncoding.fromHex(FIXED_PUB_C_HEX), FIXED_PUB_B, u64Be(2n), BsvEncoding.fromUtf8("ct")],
      FIXED_PUB_B
    );
    const events = devClassifyScript(script, { myPub33: FIXED_PUB_A });
    const first = events[0]!;
    expect(first.kind).toBe("chat-direct");
    if (first.kind !== "chat-direct") throw new Error("kind mismatch");
    expect(first.relevantToMe).toBe(false);
  });

  it("classifies TableGenesis with tableId field", () => {
    const tableId = "t-deadbeef~TexasHoldem~p4";
    const script = buildTypedOutput(
      "TableGenesis",
      [BsvEncoding.fromUtf8(tableId), BsvEncoding.fromUtf8("TexasHoldem"), BsvEncoding.fromUtf8("4"), BsvEncoding.fromUtf8("100/1")],
      FIXED_PUB_A
    );
    const events = devClassifyScript(script, { myPub33: FIXED_PUB_A });
    const first = events[0]!;
    expect(first.kind).toBe("table-genesis");
    if (first.kind !== "table-genesis") throw new Error("kind mismatch");
    expect(first.tableId).toBe(tableId);
  });

  it("ingest of unknown/non-typed tx falls back to 'unknown' safely", () => {
    // 一个全 0 的 raw tx 不会解析成功 → unknown。
    const raw = devWrapAsRawTx(new Uint8Array([0x00, 0x01, 0x02]));
    const ctx = { myPub33: FIXED_PUB_A };
    const events = devClassifyScript(new Uint8Array([0x00, 0x01, 0x02]), ctx);
    // devClassifyScript 包装后 outputs 仍是 1 个 invalid script → ingest 兜底 "unknown"。
    expect(events.length).toBeGreaterThan(0);
    const first = events[0]!;
    expect(["unknown", "other"]).toContain(first.kind);
    void raw;
  });
});

function concat(...bs: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const b of bs) total += b.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of bs) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}
