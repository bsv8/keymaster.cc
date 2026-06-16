// packages/plugin-poker/src/engine/txIngest.ts
// 对等实现 bsv-poker 的 `Ingest(tx)` 语义。
//
// 设计缘由（硬切换 001 修订版 610 行）：
//   - proxy 不会代解析也不会代过滤；每个 web client 必须本地按原始
//     `Ingest` 语义识别 raw tx 是否与自己相关，并把已识别的事件交给
//     NetGame / NetBlackjack 引擎推进状态。
//   - ingest 是**纯函数**：输入 raw tx + 当前玩家上下文（poker identity
//     pub），输出一组分类好的事件。**不**做解密、不做签名校验；那些
//     由各 specialized engine（chat decrypt / hand state machine）后续完成。
//   - 这层是 fallback broadcast 兜底安全的关键：识别不了的 tx 进入
//     "unknown" 路径并被引擎安全忽略。

import { BsvTx } from "../tsstack/adapter.js";
import { parseChatDirectFields, parseChatGroupFields, type ChatDirectFields, type ChatGroupFields } from "./chat.js";
import { parseTypedOutput, TX_TEMPLATES, type ParsedTypedOutput, type TxKindName } from "./txTemplates.js";

/** ingest 阶段对一个 typed-output 的分类结果。 */
export type IngestedEvent =
  | { kind: "node-seed"; pub: Uint8Array; endpoint: string; output: ParsedTypedOutput }
  | { kind: "announce"; playerPub: Uint8Array; endpoint: string; output: ParsedTypedOutput }
  | { kind: "chat-direct"; chat: ChatDirectFields; relevantToMe: boolean; output: ParsedTypedOutput }
  | { kind: "chat-group"; chat: ChatGroupFields; output: ParsedTypedOutput }
  | { kind: "payment"; output: ParsedTypedOutput }
  | { kind: "table-genesis"; tableId: string; output: ParsedTypedOutput }
  | { kind: "game-start"; tableId: string; gameId: string; output: ParsedTypedOutput }
  | { kind: "hand-start"; gameId: string; handId: string; output: ParsedTypedOutput }
  | { kind: "bet" | "pot" | "settlement" | "recovery" | "deal" | "board-reveal" | "showdown"; handId: string; output: ParsedTypedOutput }
  | { kind: "identity"; output: ParsedTypedOutput }
  | { kind: "other"; output: ParsedTypedOutput }
  | { kind: "unknown" };

/** ingest 输入上下文：当前玩家身份（与稳定 poker identity 绑定一致）。 */
export interface IngestContext {
  /** 33 字节压缩公钥；用于"我是收件人吗？"判定。 */
  myPub33: Uint8Array;
}

/** 解析 raw tx 并按 typed output 分类成 IngestedEvent[]；包含 0~N 条事件。 */
export function ingestRawTx(rawTx: Uint8Array, ctx: IngestContext): IngestedEvent[] {
  let parsed;
  try {
    parsed = BsvTx.parse(rawTx);
  } catch {
    return [{ kind: "unknown" }];
  }
  const out: IngestedEvent[] = [];
  for (const o of parsed.outputs) {
    const ev = classifyOutput(o.script, ctx);
    if (ev) out.push(ev);
  }
  if (out.length === 0) out.push({ kind: "unknown" });
  return out;
}

/** 按 typed-output 拆出单个 IngestedEvent。 */
export function classifyOutput(script: Uint8Array, ctx: IngestContext): IngestedEvent | null {
  const parsed = parseTypedOutput(script);
  if (!parsed) return null;
  switch (parsed.kind as TxKindName) {
    case "NodeSeed":
      return classifyNodeSeed(parsed);
    case "Announce":
      return classifyAnnounce(parsed);
    case "ChatDirect": {
      const chat = parseChatDirectFields(parsed.fieldsByName);
      if (!chat) return { kind: "other", output: parsed };
      const me = ctx.myPub33;
      const relevantToMe =
        equalBytes(chat.senderPub, me) || equalBytes(chat.recipientPub, me);
      return { kind: "chat-direct", chat, relevantToMe, output: parsed };
    }
    case "ChatGroup": {
      const chat = parseChatGroupFields(parsed.fieldsByName);
      if (!chat) return { kind: "other", output: parsed };
      return { kind: "chat-group", chat, output: parsed };
    }
    case "Payment":
      return { kind: "payment", output: parsed };
    case "TableGenesis": {
      const tableId = decodeUtf8(parsed.fieldsByName["tableId"]);
      return { kind: "table-genesis", tableId, output: parsed };
    }
    case "GameStart": {
      const tableId = decodeUtf8(parsed.fieldsByName["tableId"]);
      const gameId = decodeUtf8(parsed.fieldsByName["gameId"]);
      return { kind: "game-start", tableId, gameId, output: parsed };
    }
    case "HandStart": {
      const gameId = decodeUtf8(parsed.fieldsByName["gameId"]);
      const handId = decodeUtf8(parsed.fieldsByName["handId"]);
      return { kind: "hand-start", gameId, handId, output: parsed };
    }
    case "Bet":
      return { kind: "bet", handId: decodeUtf8(parsed.fieldsByName["handId"]), output: parsed };
    case "PotEscrow":
      return { kind: "pot", handId: decodeUtf8(parsed.fieldsByName["handId"]), output: parsed };
    case "Settlement":
      return { kind: "settlement", handId: decodeUtf8(parsed.fieldsByName["handId"]), output: parsed };
    case "Recovery":
      return { kind: "recovery", handId: decodeUtf8(parsed.fieldsByName["handId"]), output: parsed };
    case "Deal":
      return { kind: "deal", handId: decodeUtf8(parsed.fieldsByName["handId"]), output: parsed };
    case "BoardReveal":
      return { kind: "board-reveal", handId: decodeUtf8(parsed.fieldsByName["handId"]), output: parsed };
    case "Showdown":
      return { kind: "showdown", handId: decodeUtf8(parsed.fieldsByName["handId"]), output: parsed };
    case "Identity":
      return { kind: "identity", output: parsed };
    default:
      return { kind: "other", output: parsed };
  }
}

function classifyNodeSeed(parsed: ParsedTypedOutput): IngestedEvent {
  const pub = parsed.fieldsByName["pub"];
  const ep = parsed.fieldsByName["endpoint"];
  if (!pub || !ep) return { kind: "other", output: parsed };
  return { kind: "node-seed", pub, endpoint: decodeUtf8(ep), output: parsed };
}

function classifyAnnounce(parsed: ParsedTypedOutput): IngestedEvent {
  const pub = parsed.fieldsByName["playerPub"];
  const ep = parsed.fieldsByName["endpoint"];
  if (!pub || !ep) return { kind: "other", output: parsed };
  return { kind: "announce", playerPub: pub, endpoint: decodeUtf8(ep), output: parsed };
}

function decodeUtf8(bytes: Uint8Array | undefined): string {
  if (!bytes) return "";
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 工具：检查某个 typed marker 是否在白名单内；proxy / 单测都需要。
 * 返回 null 表示 unknown marker；后续可作为 unsupported tag 告警。
 */
export function knownTxKindByTag(tag: string): TxKindName | null {
  for (const [k, v] of Object.entries(TX_TEMPLATES)) {
    if (v.tag === tag) return k as TxKindName;
  }
  return null;
}
