// packages/plugin-poker/src/engine/netGameEngine.ts
// `bsv-poker NetGame` 的 TS 对等状态机骨架。
//
// 设计缘由（硬切换 001 修订版 602 行）：
//   - "ts-stack 是底座，不是现成扑克状态机"——本期把状态机骨架放进
//     plugin-poker；具体 Mental Poker（commit-reveal、threshold escrow、
//     joint randomness）实现按后续硬切换分批补齐。
//   - 引擎只接受 IngestedEvent / 桌面层 frame 这两类输入；不直接读取
//     proxy WSS。pokerProtocolEngine 负责把外部输入翻译成本机事件。
//   - 状态机的"对外验收"是 phase 转移；具体每一帧的字节级行为由
//     conformance/ fixtures 在后续硬切换里补齐。

import type { IngestedEvent } from "./txIngest.js";
import { BsvEncoding } from "../tsstack/adapter.js";

/** NetGame 阶段枚举（与 bsv-poker 一致，便于审计）。 */
export type NetGamePhase =
  | "waiting-for-player"
  | "seating"
  | "dealing"
  | "playing"
  | "showdown"
  | "settlement"
  | "done"
  | "aborted";

/** 引擎需要的输入：当前桌面身份 + 玩家身份。 */
export interface NetGameEngineConfig {
  tableId: string;
  /** 当前玩家 33 字节公钥。 */
  myPub33: Uint8Array;
}

/** 引擎对外暴露的不变结构。 */
export interface NetGameSnapshot {
  tableId: string;
  phase: NetGamePhase;
  handNo: number;
  /** 当前 hand 的 handId（来自 HandStart typed tx）；尚未开局为空。 */
  handId: string;
  /** 该桌已观察到的 seat pub 列表（按 announce / table genesis 顺序）。 */
  seats: string[];
  /** 累计 ingest 事件数，仅诊断。 */
  ingestedCount: number;
  /** 最近一次 abort 原因，可空。 */
  abortReason?: string;
}

/** 引擎事件订阅签名。 */
export type NetGameSubscriber = (snapshot: NetGameSnapshot) => void;

/**
 * NetGameEngine 是单桌、单玩家视角的状态机；并发的多桌由
 * pokerProtocolEngine 维护"tableId -> NetGameEngine"映射。
 *
 * 不变量：
 *   1. 任何输入事件抛错都被吞掉（防止单条 frame 把整个 lobby 拖垮）。
 *   2. phase 转移只朝单方向推进；要回到 waiting 必须 reset()。
 *   3. handId 仅在收到 HandStart 后才有；其它依赖 handId 的事件在
 *      handId 缺失时改为 "abort + 等待 hand index 恢复"。
 */
export class NetGameEngine {
  private readonly cfg: NetGameEngineConfig;
  private snapshot: NetGameSnapshot;
  private subscribers = new Set<NetGameSubscriber>();

  constructor(cfg: NetGameEngineConfig) {
    this.cfg = cfg;
    this.snapshot = {
      tableId: cfg.tableId,
      phase: "waiting-for-player",
      handNo: -1,
      handId: "",
      seats: [],
      ingestedCount: 0
    };
  }

  /** 注入一条 ingest 事件；按 kind 推进 phase / hand 索引。 */
  ingest(event: IngestedEvent): void {
    try {
      this.snapshot = this.dispatch(this.snapshot, event);
      this.snapshot = { ...this.snapshot, ingestedCount: this.snapshot.ingestedCount + 1 };
      this.notify();
    } catch (err) {
      // 防御性：任何引擎异常 → 标记 abort，不让一次坏事件锁住引擎。
      this.snapshot = {
        ...this.snapshot,
        phase: "aborted",
        abortReason: err instanceof Error ? err.message : String(err),
        ingestedCount: this.snapshot.ingestedCount + 1
      };
      this.notify();
    }
  }

  /** 当前快照（始终返回浅拷贝，便于 UI diff）。 */
  state(): NetGameSnapshot {
    return { ...this.snapshot, seats: [...this.snapshot.seats] };
  }

  /** 订阅 snapshot 变化；订阅时立即推一次当前值。 */
  subscribe(handler: NetGameSubscriber): () => void {
    this.subscribers.add(handler);
    handler(this.state());
    return () => {
      this.subscribers.delete(handler);
    };
  }

  /** 重置引擎（玩家离桌 / 桌主关桌 / 用户切 identity）。 */
  reset(reason?: string): void {
    this.snapshot = {
      tableId: this.cfg.tableId,
      phase: "waiting-for-player",
      handNo: -1,
      handId: "",
      seats: [],
      ingestedCount: this.snapshot.ingestedCount,
      abortReason: reason
    };
    this.notify();
  }

  // ----------------------- 内部 dispatch -----------------------

  private dispatch(prev: NetGameSnapshot, event: IngestedEvent): NetGameSnapshot {
    switch (event.kind) {
      case "table-genesis":
        if (event.tableId !== this.cfg.tableId) return prev;
        return { ...prev, phase: prev.phase === "waiting-for-player" ? "seating" : prev.phase };

      case "announce": {
        const pubHex = BsvEncoding.toHex(event.playerPub);
        if (prev.seats.includes(pubHex)) return prev;
        return { ...prev, seats: [...prev.seats, pubHex] };
      }

      case "game-start":
        if (event.tableId !== this.cfg.tableId) return prev;
        return { ...prev, phase: "dealing", handNo: 0, handId: "" };

      case "hand-start": {
        // hand-start 自带 gameId/handId；这里只关心 handId 改变。
        const next = { ...prev, handId: event.handId, handNo: Math.max(0, prev.handNo + 1) };
        if (prev.phase === "dealing" || prev.phase === "waiting-for-player" || prev.phase === "seating") {
          next.phase = "playing";
        }
        return next;
      }

      case "bet":
      case "pot":
      case "deal":
      case "board-reveal":
        // 仅在已经有 handId 时推进；否则保持等待索引。
        if (!prev.handId || event.handId !== prev.handId) return prev;
        return { ...prev, phase: prev.phase === "dealing" ? "playing" : prev.phase };

      case "showdown":
        if (!prev.handId || event.handId !== prev.handId) return prev;
        return { ...prev, phase: "showdown" };

      case "settlement":
        if (!prev.handId || event.handId !== prev.handId) return prev;
        return { ...prev, phase: "settlement" };

      case "recovery":
        return { ...prev, phase: "aborted", abortReason: "recovery tx observed" };

      case "chat-direct":
      case "chat-group":
      case "node-seed":
      case "payment":
      case "identity":
      case "other":
      case "unknown":
      default:
        // 这些事件不直接推进 NetGame；由 protocolEngine 转发到 chat 子系统等。
        return prev;
    }
  }

  private notify(): void {
    const snap = this.state();
    for (const h of this.subscribers) {
      try { h(snap); } catch { /* swallow */ }
    }
  }
}
