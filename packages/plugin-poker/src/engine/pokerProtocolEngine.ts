// packages/plugin-poker/src/engine/pokerProtocolEngine.ts
// 顶层协议引擎：把 proxy 帧 + raw tx 转成 ingest 事件，并按 tableId 分发到
// NetGameEngine / NetBlackjackEngine。
//
// 设计缘由（硬切换 001 修订版 594 行）：
//   - "在 plugin-poker 内补齐扑克专属协议引擎主入口"。pokerService 持有
//     一个 PokerProtocolEngine 实例；所有 onMessage / handleTxDeliver
//     都把"原始事件"喂给它，由它统一推进真值状态。
//   - 引擎只接收 IngestContext（稳定 poker identity），由 pokerService
//     在 connect / 切绑定时同步设置；任何路径上 ctx 缺失都 fail-closed。
//   - 引擎按需 lazy 创建 game-engine：观察到 TableGenesis 时新建，
//     桌主关桌或 settlement → done 后释放。

import { ingestRawTx, type IngestContext, type IngestedEvent } from "./txIngest.js";
import { NetGameEngine, type NetGameSnapshot } from "./netGameEngine.js";
import { NetBlackjackEngine, type NetBlackjackSnapshot } from "./netBlackjackEngine.js";
import { parseTypedOutput } from "./txTemplates.js";
import { BsvEncoding } from "../tsstack/adapter.js";

/**
 * 浏览器 ↔ poker-proxy 内部协议里的发现 topic 常量。
 *
 * 设计缘由：bsv-poker C# `P2PNode` 的 wire topic 带前导空格（" bsvp/presence"），
 * 那是 P2PNode 外网平面的协议奇癖。**但** poker-proxy 在浏览器侧用的是
 * 自家内部协议，它对 presence / table announce 一律写到无空格 topic：
 *   - presence → "bsvp/presence"（[broker.handlePresencePublish](../../../../Projects/poker-proxy/internal/browser/broker.go:243)）
 *   - table announce → tableId 直接当 topic（同文件第 296 行）
 *   - 桌目录聚合 → "bsvp/dir"（本次硬切换把表 announce 同步到这个 topic）
 *   - 目录查询信号 → "bsvp/dir?"
 *
 * `SessionRegistry.Subscribe` 按字符串精确匹配 topic，**不会** trim 空格，
 * 因此 plugin-poker 必须用无空格形式去订阅，否则代理侧根本不会路由。
 */
export const POKER_DISCOVERY_TOPICS = {
  Presence: "bsvp/presence",
  Dir: "bsvp/dir",
  DirQuery: "bsvp/dir?"
} as const;

/**
 * 一条解析好的 presence frame（与 C# `PresenceJson` 字段对齐）。
 * 设计缘由：proxy 不解析 payload；前端必须在 handleFrame 里按
 * `{playerId, addr, handle, sig}` JSON 解析，否则大厅永远是空的。
 */
export interface ParsedPresenceFrame {
  /** 玩家身份 pub hex（lowercase）。 */
  playerId: string;
  /** 玩家声明的 endpoint（host:port / onion / ""）。 */
  addr: string;
  /** 可选昵称。 */
  handle: string;
  /** 签名 hex；本期不在前端二次验签。 */
  sig: string;
}

/**
 * 一条解析好的 table announce frame（与 C# `TableJson` 字段对齐）。
 *
 * 设计缘由：`members === -1` 在原始协议里是"关桌信号"；UI 与目录
 * 必须把它视为删除而不是新增。
 */
export interface ParsedTableFrame {
  id: string;
  name: string;
  members: number;
  pub: string;
  sig: string;
  isClose: boolean;
}

/** 引擎的可选钩子（chat decrypt 等由 service 后期注入）。 */
export interface PokerProtocolEngineHooks {
  /**
   * 收到一条与"我"相关的 ChatDirect 时调用。
   * 设计缘由：本期不做 AEAD 解封；UI 仅在 inbox 列表里显示发件人 + index。
   */
  onChatDirect?(payload: { senderPubHex: string; recipientPubHex: string; index: bigint }): void;

  /** 收到一条 ChatGroup 时调用（实际成员判定与解封由 service 决定）。 */
  onChatGroup?(payload: { groupIdHex: string; senderPubHex: string }): void;

  /** 收到一条 NodeSeed / Announce 时调用，service 可同步 directory。 */
  onAnnounce?(payload: { playerPubHex: string; endpoint: string }): void;
  onNodeSeed?(payload: { pubHex: string; endpoint: string }): void;

  /** P2PNode presence 平面到达的一条 frame；payload 已解析为 PresenceAnnounce。 */
  onPresenceFrame?(payload: ParsedPresenceFrame): void;
  /** P2PNode dir 平面到达的一条 frame；payload 已解析为 TableAnnounce（含 close）。 */
  onTableFrame?(payload: ParsedTableFrame): void;
}

/**
 * "桌局变种"识别：tableId 形如 `t-<hex>~<Variant>~p<N>~s<stack>~b<bb>`；
 * 与 C# NetGame 解析路径一致。空 / 缺省 → TexasHoldem。
 */
export type TableVariant = "TexasHoldem" | "Blackjack" | "Unknown";

export function variantFromTableId(tableId: string): TableVariant {
  const parts = tableId.split("~");
  const v = (parts.length > 1 ? parts[1] : "TexasHoldem") ?? "TexasHoldem";
  if (/^texas/i.test(v) || /holdem/i.test(v)) return "TexasHoldem";
  if (/blackjack/i.test(v)) return "Blackjack";
  return "Unknown";
}

export interface PokerProtocolEngineConfig {
  hooks?: PokerProtocolEngineHooks;
}

export class PokerProtocolEngine {
  private readonly hooks: PokerProtocolEngineHooks;
  private ctx: IngestContext | null = null;
  private games = new Map<string, NetGameEngine>();
  private blackjacks = new Map<string, NetBlackjackEngine>();

  constructor(cfg: PokerProtocolEngineConfig = {}) {
    this.hooks = cfg.hooks ?? {};
  }

  /** 设置 / 切换当前 ingest context（稳定 poker identity 变化时调用）。 */
  setContext(ctx: IngestContext | null): void {
    this.ctx = ctx;
    if (!ctx) {
      // identity 解绑：清空所有桌局缓存，避免旧身份的状态泄漏到新绑定。
      for (const g of this.games.values()) g.reset("identity unbound");
      for (const b of this.blackjacks.values()) b.reset("identity unbound");
      this.games.clear();
      this.blackjacks.clear();
    }
  }

  /**
   * 处理一条 proxy 帧（topic frame，payload bytes）。
   *
   * 设计缘由（修复"发现链路没接上"问题）：
   *   - bsv-poker 把 presence 与 directory 都放在 P2PNode topic 平面；
   *     payload 是 UTF-8 JSON。proxy 不解析，前端必须自行解。
   *   - 原版只做了 "topic.startsWith('t-')" 这种粗判，导致 bsvp/presence
   *     / bsvp/dir 整条链路被丢；修复后这两类 topic 立即触发 hook，由
   *     pokerService 写入 presences / tables 映射。
   *   - 注意：proxy 内部协议 topic 是**无前导空格**形式（与 SessionRegistry
   *     精确匹配规则一致）；早期版本用过 trim 容错，但反而掩盖了
   *     "订阅了带空格 topic 导致代理侧根本不路由"的真 bug——现在按
   *     严格相等判定。
   *   - tableId 形如 "t-…" 的 topic 仍触发 ensureEnginesFor 创建状态机。
   */
  handleFrame(topic: string, payload: Uint8Array): void {
    if (!this.ctx) return;
    if (topic === POKER_DISCOVERY_TOPICS.Presence) {
      const parsed = tryParsePresence(payload);
      if (parsed) this.hooks.onPresenceFrame?.(parsed);
      return;
    }
    if (topic === POKER_DISCOVERY_TOPICS.Dir) {
      const parsed = tryParseTable(payload);
      if (parsed) this.hooks.onTableFrame?.(parsed);
      return;
    }
    if (topic === POKER_DISCOVERY_TOPICS.DirQuery) {
      // 仅信号性 topic（"我在找谁有桌？"）；payload 通常为空，不解析。
      return;
    }
    if (topic.startsWith("t-")) {
      this.ensureEnginesFor(topic);
      // 桌主在 handleTablePublish 把 announce 既发到 tableId 也发到 bsvp/dir；
      // tableId topic 上的 payload 是同一份 JSON，这里也尝试解析一次，方便
      // "客户端直接订阅了某 tableId 但还没订阅 bsvp/dir"的早期场景。
      const parsed = tryParseTable(payload);
      if (parsed) this.hooks.onTableFrame?.(parsed);
    }
  }

  /** 处理一条 raw tx：跑 ingest，按 tableId 路由到 game-engine。 */
  handleRawTx(rawTx: Uint8Array): IngestedEvent[] {
    if (!this.ctx) return [];
    const events = ingestRawTx(rawTx, this.ctx);
    for (const ev of events) this.dispatchEvent(ev);
    return events;
  }

  /** 单测 / inspect 用：取某 tableId 的 NetGame 快照。 */
  netGameSnapshot(tableId: string): NetGameSnapshot | null {
    return this.games.get(tableId)?.state() ?? null;
  }

  /** 单测 / inspect 用：取某 tableId 的 Blackjack 快照。 */
  netBlackjackSnapshot(tableId: string): NetBlackjackSnapshot | null {
    return this.blackjacks.get(tableId)?.state() ?? null;
  }

  /** 当前已 track 的桌局 id 列表。 */
  trackedTables(): string[] {
    const set = new Set<string>();
    for (const k of this.games.keys()) set.add(k);
    for (const k of this.blackjacks.keys()) set.add(k);
    return Array.from(set);
  }

  // ------------------- 内部 -------------------

  private dispatchEvent(ev: IngestedEvent): void {
    switch (ev.kind) {
      case "table-genesis":
      case "game-start":
      case "hand-start":
      case "bet":
      case "pot":
      case "deal":
      case "board-reveal":
      case "showdown":
      case "settlement":
      case "recovery":
      case "announce":
      case "identity":
      case "other":
      case "unknown":
        this.routeToTable(ev);
        break;
      case "node-seed":
        this.hooks.onNodeSeed?.({
          pubHex: BsvEncoding.toHex(ev.pub),
          endpoint: ev.endpoint
        });
        break;
      case "chat-direct":
        if (ev.relevantToMe) {
          this.hooks.onChatDirect?.({
            senderPubHex: BsvEncoding.toHex(ev.chat.senderPub),
            recipientPubHex: BsvEncoding.toHex(ev.chat.recipientPub),
            index: ev.chat.index
          });
        }
        break;
      case "chat-group":
        this.hooks.onChatGroup?.({
          groupIdHex: BsvEncoding.toHex(ev.chat.groupId),
          senderPubHex: BsvEncoding.toHex(ev.chat.senderPub)
        });
        break;
      case "payment":
        // 走 fallback；UI 可读但引擎不关心。
        break;
    }
  }

  /**
   * 根据 typed event 提取 tableId（事件自带或 owner 推断），分发到引擎。
   *
   * 设计缘由：典型 raw tx 不一定带 tableId 字段（Bet/Pot 等只带 handId）；
   * 我们用"已经存在的 NetGameEngine 集合"按 handId 反查桌局；找不到时
   * 创建一个 fallback table-id="?:<handId>" 以便保留事件而不丢。
   */
  private routeToTable(ev: IngestedEvent): void {
    let tableId = "";
    if ("tableId" in ev && typeof ev.tableId === "string") {
      tableId = ev.tableId;
    } else if ("handId" in ev && typeof ev.handId === "string" && ev.handId) {
      tableId = `?:${ev.handId}`;
    } else if (ev.kind === "announce") {
      // announce 不带 tableId；只更新 hook，不创建桌引擎。
      this.hooks.onAnnounce?.({
        playerPubHex: BsvEncoding.toHex(ev.playerPub),
        endpoint: ev.endpoint
      });
      return;
    } else if (ev.kind === "other" || ev.kind === "identity" || ev.kind === "unknown") {
      return;
    }
    if (!tableId) return;
    this.ensureEnginesFor(tableId);
    this.games.get(tableId)?.ingest(ev);
    this.blackjacks.get(tableId)?.ingest(ev);
  }

  /** 按 tableId 的 variant 懒创建引擎。 */
  private ensureEnginesFor(tableId: string): void {
    const variant = variantFromTableId(tableId);
    if (!this.ctx) return;
    if (variant === "TexasHoldem" || variant === "Unknown") {
      if (!this.games.has(tableId)) {
        this.games.set(tableId, new NetGameEngine({ tableId, myPub33: this.ctx.myPub33 }));
      }
    }
    if (variant === "Blackjack" || variant === "Unknown") {
      if (!this.blackjacks.has(tableId)) {
        this.blackjacks.set(tableId, new NetBlackjackEngine({ tableId, myPub33: this.ctx.myPub33 }));
      }
    }
  }
}

// ----------------------------------------------------------------------------
// 单测辅助：把 typed-output script 串成"假装的"完整 tx，便于喂 ingestRawTx
// 时跳过 sdk 的复杂解析。仅在 conformance 测试用，不导出到生产路径。
// ----------------------------------------------------------------------------

/** dev-only：把单个 typed-output 包装成最小可解析 raw tx。 */
export function devWrapAsRawTx(outputScript: Uint8Array): Uint8Array {
  // 版本(4) + #inputs(varint=0) + #outputs(varint=1) + value(8) + scriptLen(varint) + script + lockTime(4)
  const valueSats = 1;
  const valueLe = new Uint8Array(8);
  let v = valueSats;
  for (let i = 0; i < 8; i++) { valueLe[i] = v & 0xff; v = Math.floor(v / 256); }
  const scriptLen = outputScript.length;
  const scriptLenBytes = encodeVarint(scriptLen);
  const out: number[] = [];
  out.push(0x01, 0x00, 0x00, 0x00);
  out.push(0x00);
  out.push(0x01);
  for (const b of valueLe) out.push(b);
  for (const b of scriptLenBytes) out.push(b);
  for (let i = 0; i < outputScript.length; i++) out.push(outputScript[i] as number);
  out.push(0x00, 0x00, 0x00, 0x00);
  return new Uint8Array(out);
}

function encodeVarint(n: number): number[] {
  if (n < 0xfd) return [n & 0xff];
  if (n <= 0xffff) return [0xfd, n & 0xff, (n >> 8) & 0xff];
  if (n <= 0xffffffff) return [0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
  throw new Error("varint > 2^32 not supported");
}

/**
 * dev-only：只对 script 解析时使用 parseTypedOutput，避免 sdk 解析路径。
 * 暴露给 conformance / engine 测试，跳过 raw-tx 包装。
 */
export function devClassifyScript(script: Uint8Array, ctx: IngestContext) {
  void parseTypedOutput;
  return ingestRawTx(devWrapAsRawTx(script), ctx);
}

// ----------------------------------------------------------------------------
// Presence / Table announce JSON 解析
// ----------------------------------------------------------------------------

/**
 * 尝试把 bsvp/presence 的 UTF-8 JSON payload 解析为 ParsedPresenceFrame。
 *
 * 设计缘由：与 C# `PresenceJson` 输出严格对齐：
 *   {"playerId":"<pub-hex>","addr":"<host:port>","handle":"<nick>","sig":"<hex>"}
 * 任何字段缺失 / 非字符串 / JSON 损坏 → 返回 null（前端安全忽略）。
 */
export function tryParsePresence(payload: Uint8Array): ParsedPresenceFrame | null {
  const text = safeUtf8(payload);
  if (!text) return null;
  try {
    const j = JSON.parse(text) as Partial<Record<string, unknown>>;
    const playerId = typeof j["playerId"] === "string" ? (j["playerId"] as string) : "";
    const addr = typeof j["addr"] === "string" ? (j["addr"] as string) : "";
    const handle = typeof j["handle"] === "string" ? (j["handle"] as string) : "";
    const sig = typeof j["sig"] === "string" ? (j["sig"] as string) : "";
    if (!playerId) return null;
    return { playerId: playerId.toLowerCase(), addr, handle, sig };
  } catch {
    return null;
  }
}

/**
 * 尝试把 bsvp/dir 的 UTF-8 JSON payload 解析为 ParsedTableFrame。
 *
 * 与 C# `TableJson` 严格对齐：
 *   {"id":"<tableId>","name":"<...>","members":<int>,"pub":"<hex>","sig":"<hex>"}
 * members === -1 是协议约定的"关桌信号"（C# `CloseTable`）；UI 层必须把它
 * 当成"目录里移除该桌"，不是"新增一张 members=-1 的桌"。
 */
export function tryParseTable(payload: Uint8Array): ParsedTableFrame | null {
  const text = safeUtf8(payload);
  if (!text) return null;
  try {
    const j = JSON.parse(text) as Partial<Record<string, unknown>>;
    const id = typeof j["id"] === "string" ? (j["id"] as string) : "";
    const name = typeof j["name"] === "string" ? (j["name"] as string) : "";
    const members = typeof j["members"] === "number" ? (j["members"] as number) : 0;
    const pub = typeof j["pub"] === "string" ? (j["pub"] as string) : "";
    const sig = typeof j["sig"] === "string" ? (j["sig"] as string) : "";
    if (!id) return null;
    return { id, name, members, pub: pub.toLowerCase(), sig, isClose: members === -1 };
  } catch {
    return null;
  }
}

function safeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}
