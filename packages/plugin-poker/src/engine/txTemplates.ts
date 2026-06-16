// packages/plugin-poker/src/engine/txTemplates.ts
// bsv-poker `TxTemplates` 的 TS 对等实现。
//
// 设计缘由（硬切换 001 修订版 620 行）：
//   - 文档把 typed output 描述为：
//       <marker> OP_DROP (<field> OP_DROP)* <ownerPub(33)> OP_CHECKSIG
//     其中 marker 是 "BSVP:<TAG>:1" 这样的 ASCII 字符串。所有字段按"模板"
//     固定顺序排列；TS 必须能 build / parse 同一 wire-format，否则与
//     bsv-poker 的对端不可互通。
//   - 浏览器侧 build/parse 是签名 / 验签 / ingest 的前置；引擎的"真值"
//     起点就在这里。该模块仅依赖 BsvEncoding（utf8 / hex）；不引入 sdk
//     的高层对象，以保持纯函数 & 可对拍。
//
// 与 C# 对齐的细节：
//   - 使用 BSV "MINIMALDATA" push 规则：空 → OP_0；单字节 1..16 → OP_1..OP_16；
//     单字节 0x81 → OP_1NEGATE；其它按最短长度前缀。
//   - 解析时若解码出的 push 不是最短编码也接受（解析方更宽松，与 C# 一致）。
//   - marker 必须以 "BSVP:" 起头，由 ASCII 字符组成；用 marker 字符串
//     而不是 enum 值作为 wire 标识。

import { BsvEncoding } from "../tsstack/adapter.js";

// 操作码常量。
const OP_0 = 0x00;
const OP_PUSHDATA1 = 0x4c;
const OP_PUSHDATA2 = 0x4d;
const OP_PUSHDATA4 = 0x4e;
const OP_1NEGATE = 0x4f;
const OP_DROP = 0x75;
const OP_CHECKSIG = 0xac;

/**
 * bsv-poker 的所有 typed tx kind 名称（仅 ASCII tag，不导出 enum）。
 * 与 C# TxTemplates.Registry 一致；任何新增 kind 必须同步到 proxy 的
 * classifier 与 conformance fixtures。
 */
export const TX_TEMPLATES: Readonly<Record<string, { tag: string; fields: readonly string[] }>> = {
  Payment:       { tag: "BSVP:PAY:1",  fields: ["memo"] },
  KeepAlive:     { tag: "BSVP:KA:1",   fields: ["seat", "nonce"] },
  ChatDirect:    { tag: "BSVP:DM:1",   fields: ["senderPub", "recipientPub", "index", "ciphertext"] },
  ChatGroup:     { tag: "BSVP:GC:1",   fields: ["groupId", "senderPub", "ciphertext"] },
  CardNft:       { tag: "BSVP:NFT:1",  fields: ["sealCommitment"] },
  Commitment:    { tag: "BSVP:CMT:1",  fields: ["commitHash"] },
  Reveal:        { tag: "BSVP:RVL:1",  fields: ["commitHash", "preimage"] },
  ShuffleStage:  { tag: "BSVP:SHF:1",  fields: ["handId", "step", "commitment", "deck"] },
  ShuffleReveal: { tag: "BSVP:SHR:1",  fields: ["handId", "step", "global", "perm"] },
  Deal:          { tag: "BSVP:DEAL:1", fields: ["handId", "position", "mask"] },
  BoardReveal:   { tag: "BSVP:BRD:1",  fields: ["handId", "street", "mask"] },
  Showdown:      { tag: "BSVP:SHO:1",  fields: ["handId", "seat", "holeMasks"] },
  Bet:           { tag: "BSVP:BET:1",  fields: ["handId", "seat", "action", "amount"] },
  PotEscrow:     { tag: "BSVP:POT:1",  fields: ["handId", "members", "amount"] },
  Settlement:    { tag: "BSVP:STL:1",  fields: ["handId", "winnerPub"] },
  Recovery:      { tag: "BSVP:REC:1",  fields: ["handId", "lockHeight"] },
  Bid:           { tag: "BSVP:BID:1",  fields: ["auctionId", "bidderPub", "amount", "commit"] },
  Auction:       { tag: "BSVP:AUC:1",  fields: ["auctionId", "item", "reserve", "deadline"] },
  RoleClaim:     { tag: "BSVP:ROLE:1", fields: ["auctionId", "role", "winnerPub"] },
  TableGenesis:  { tag: "BSVP:TBL:1",  fields: ["tableId", "variant", "seats", "stakes"] },
  GameStart:     { tag: "BSVP:GAME:1", fields: ["tableId", "gameId"] },
  HandStart:     { tag: "BSVP:HAND:1", fields: ["gameId", "handId", "button"] },
  Announce:      { tag: "BSVP:ANN:1",  fields: ["playerPub", "endpoint"] },
  Identity:      { tag: "BSVP:ID:1",   fields: ["identityPub", "attestationPub", "pseudonym", "email", "signature"] },
  Points:        { tag: "BSVP:PTS:1",  fields: ["gameId", "identityPub", "points", "handId"] },
  NodeSeed:      { tag: "BSVP:NODE:1", fields: ["pub", "endpoint"] }
} as const;

export type TxKindName = keyof typeof TX_TEMPLATES;

/** 解析结果。 */
export interface ParsedTypedOutput {
  kind: TxKindName;
  tag: string;
  /** 按模板顺序排列的 fields；命名版本见 fieldsByName。 */
  fields: Uint8Array[];
  /** 按模板字段名拆出来的命名 map（便于业务代码读取）。 */
  fieldsByName: Record<string, Uint8Array>;
  /** owner 33 字节压缩公钥。 */
  ownerPub: Uint8Array;
}

/**
 * 构造一个 typed output script：
 *   <marker> OP_DROP (<field> OP_DROP)* <ownerPub(33)> OP_CHECKSIG
 * 校验：fields 长度必须与模板严格一致；ownerPub 必须 33 字节。
 */
export function buildTypedOutput(kind: TxKindName, fields: Uint8Array[], ownerPub: Uint8Array): Uint8Array {
  // noUncheckedIndexedAccess: 取出后立刻做 null 守卫，保留 "unknown kind"
  // 的运行期错误信息。
  const tpl = TX_TEMPLATES[kind];
  if (!tpl) throw new Error(`Unknown TxKind: ${kind}`);
  if (fields.length !== tpl.fields.length) {
    throw new Error(`${kind} expects ${tpl.fields.length} fields (${tpl.fields.join(",")}), got ${fields.length}`);
  }
  if (ownerPub.length !== 33) throw new Error("ownerPub must be 33-byte compressed");

  const out: number[] = [];
  pushDrop(out, BsvEncoding.fromUtf8(tpl.tag));
  for (const f of fields) pushDrop(out, f);
  push(out, ownerPub);
  out.push(OP_CHECKSIG);
  return new Uint8Array(out);
}

/**
 * 解析 typed output script；不是 typed-output 时返回 null。
 *
 * 设计缘由：proxy 的 classifier 已经从 raw tx 里 substring 切片识别；
 * 浏览器侧 ingest 走完整 script-level 解析，能取到 owner pub + 全字段。
 */
export function parseTypedOutput(script: Uint8Array): ParsedTypedOutput | null {
  try {
    let p = 0;
    const marker = readPush(script, p);
    if (!marker) return null;
    p = marker.next;
    if (script[p] !== OP_DROP) return null;
    p += 1;
    const tag = BsvEncoding.toUtf8(marker.data);
    if (!tag.startsWith("BSVP:")) return null;

    let kind: TxKindName | null = null;
    for (const [k, v] of Object.entries(TX_TEMPLATES)) {
      if (v.tag === tag) { kind = k as TxKindName; break; }
    }
    if (!kind) return null;
    // 注：tsconfig 在 apps/web 下开启了 noUncheckedIndexedAccess，因此
    // TX_TEMPLATES[kind] 会被推导成 `Template | undefined`。这里显式取出
    // 并做 null 检查，等价于"刚才循环已经命中所以一定存在"，类型层面
    // 不再需要后续 `tpl.fields.length` 处的额外断言。
    const tpl = TX_TEMPLATES[kind];
    if (!tpl) return null;

    const fields: Uint8Array[] = [];
    // 循环 pull pushes 直到下一个不是 push+OP_DROP 模式。
    // 该 push 之后应当紧跟 OP_CHECKSIG（且 push 长度 33 = ownerPub）。
    let ownerPub: Uint8Array | null = null;
    while (p < script.length) {
      const item = readPush(script, p);
      if (!item) return null;
      const after = item.next;
      if (after < script.length && script[after] === OP_DROP) {
        fields.push(item.data);
        p = after + 1;
        continue;
      }
      if (item.data.length === 33 && after < script.length && script[after] === OP_CHECKSIG && after + 1 === script.length) {
        ownerPub = item.data;
        p = after + 1;
        break;
      }
      return null;
    }
    if (!ownerPub) return null;
    if (fields.length !== tpl.fields.length) return null;

    const fieldsByName: Record<string, Uint8Array> = {};
    for (let i = 0; i < tpl.fields.length; i++) {
      const name = tpl.fields[i] as string;
      fieldsByName[name] = fields[i] as Uint8Array;
    }
    return { kind, tag, fields, fieldsByName, ownerPub };
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// 内部：BSV minimal push 编码
// ----------------------------------------------------------------------------

function push(out: number[], data: Uint8Array): void {
  if (data.length === 0) { out.push(OP_0); return; }
  if (data.length === 1) {
    const b = data[0] as number;
    if (b >= 1 && b <= 16) { out.push(0x50 + b); return; }
    if (b === 0x81) { out.push(OP_1NEGATE); return; }
  }
  if (data.length < OP_PUSHDATA1) {
    out.push(data.length);
  } else if (data.length <= 0xff) {
    out.push(OP_PUSHDATA1, data.length);
  } else if (data.length <= 0xffff) {
    out.push(OP_PUSHDATA2, data.length & 0xff, (data.length >> 8) & 0xff);
  } else {
    out.push(OP_PUSHDATA4,
      data.length & 0xff,
      (data.length >> 8) & 0xff,
      (data.length >> 16) & 0xff,
      (data.length >> 24) & 0xff);
  }
  for (let i = 0; i < data.length; i++) out.push(data[i] as number);
}

function pushDrop(out: number[], data: Uint8Array): void {
  push(out, data);
  out.push(OP_DROP);
}

/** 读取一个 push；返回 { data, next } 或 null。 */
function readPush(s: Uint8Array, p: number): { data: Uint8Array; next: number } | null {
  if (p >= s.length) return null;
  const op = s[p++] as number;
  if (op === OP_0) return { data: new Uint8Array(0), next: p };
  if (op === OP_1NEGATE) return { data: new Uint8Array([0x81]), next: p };
  if (op >= 0x51 && op <= 0x60) return { data: new Uint8Array([op - 0x50]), next: p };
  let len = 0;
  if (op < OP_PUSHDATA1) {
    len = op;
  } else if (op === OP_PUSHDATA1) {
    if (p >= s.length) return null;
    len = s[p++] as number;
  } else if (op === OP_PUSHDATA2) {
    if (p + 2 > s.length) return null;
    len = (s[p] as number) | ((s[p + 1] as number) << 8);
    p += 2;
  } else if (op === OP_PUSHDATA4) {
    if (p + 4 > s.length) return null;
    len = (s[p] as number)
      | ((s[p + 1] as number) << 8)
      | ((s[p + 2] as number) << 16)
      | ((s[p + 3] as number) << 24);
    p += 4;
  } else {
    return null;
  }
  if (len < 0 || p + len > s.length) return null;
  return { data: s.slice(p, p + len), next: p + len };
}
