// packages/plugin-poker/src/engine/netBlackjackEngine.ts
// `bsv-poker NetBlackjack` 的 TS 对等状态机骨架。
//
// 设计缘由（硬切换 001 修订版 606 行）：
//   - 与 NetGameEngine 同理：本期落"phase 状态机 + 事件路由"，把
//     funding / dealer hole / pot escrow / refund 这些 Mental Poker 重型
//     步骤标注为 hook，后续硬切换补齐。
//   - blackjack 的 phase 顺序与 C# 严格一致：
//       WaitingForPlayer → Funding → Dealing → Playing → DealerPlay →
//       HandOver → (Dealing | Settling) → Done.
//   - "HandOver"是为了让 UI 显示上一手结果再开下一手；这里通过
//     handsCompleted 计数。

import type { IngestedEvent } from "./txIngest.js";
import { BsvEncoding } from "../tsstack/adapter.js";

export type NetBlackjackPhase =
  | "waiting-for-player"
  | "funding"
  | "dealing"
  | "playing"
  | "dealer-play"
  | "hand-over"
  | "settling"
  | "done"
  | "aborted";

export interface NetBlackjackEngineConfig {
  tableId: string;
  myPub33: Uint8Array;
}

export interface NetBlackjackSnapshot {
  tableId: string;
  phase: NetBlackjackPhase;
  /** 桌上已 seat 的玩家公钥（hex）。 */
  roster: string[];
  /** 已经发生的 hand 数。 */
  handsCompleted: number;
  /** 当前 hand id；尚未开局为空。 */
  handId: string;
  /** 累计 ingest 事件数。 */
  ingestedCount: number;
  /** 最近一次 abort 原因；可空。 */
  abortReason?: string;
}

export type NetBlackjackSubscriber = (snapshot: NetBlackjackSnapshot) => void;

/**
 * NetBlackjackEngine 是单桌 blackjack 的状态机；与 NetGameEngine 行为
 * 一致地把异常隔离到自己内部，避免污染 lobby。
 */
export class NetBlackjackEngine {
  private readonly cfg: NetBlackjackEngineConfig;
  private snapshot: NetBlackjackSnapshot;
  private subscribers = new Set<NetBlackjackSubscriber>();

  constructor(cfg: NetBlackjackEngineConfig) {
    this.cfg = cfg;
    this.snapshot = {
      tableId: cfg.tableId,
      phase: "waiting-for-player",
      roster: [],
      handsCompleted: 0,
      handId: "",
      ingestedCount: 0
    };
  }

  ingest(event: IngestedEvent): void {
    try {
      this.snapshot = this.dispatch(this.snapshot, event);
      this.snapshot = { ...this.snapshot, ingestedCount: this.snapshot.ingestedCount + 1 };
      this.notify();
    } catch (err) {
      this.snapshot = {
        ...this.snapshot,
        phase: "aborted",
        abortReason: err instanceof Error ? err.message : String(err),
        ingestedCount: this.snapshot.ingestedCount + 1
      };
      this.notify();
    }
  }

  state(): NetBlackjackSnapshot {
    return { ...this.snapshot, roster: [...this.snapshot.roster] };
  }

  subscribe(handler: NetBlackjackSubscriber): () => void {
    this.subscribers.add(handler);
    handler(this.state());
    return () => {
      this.subscribers.delete(handler);
    };
  }

  reset(reason?: string): void {
    this.snapshot = {
      tableId: this.cfg.tableId,
      phase: "waiting-for-player",
      roster: [],
      handsCompleted: 0,
      handId: "",
      ingestedCount: this.snapshot.ingestedCount,
      abortReason: reason
    };
    this.notify();
  }

  // ----------------------- 内部 dispatch -----------------------

  private dispatch(prev: NetBlackjackSnapshot, event: IngestedEvent): NetBlackjackSnapshot {
    switch (event.kind) {
      case "table-genesis":
        if (event.tableId !== this.cfg.tableId) return prev;
        return { ...prev, phase: prev.phase === "waiting-for-player" ? "funding" : prev.phase };

      case "announce": {
        const pubHex = BsvEncoding.toHex(event.playerPub);
        if (prev.roster.includes(pubHex)) return prev;
        return { ...prev, roster: [...prev.roster, pubHex] };
      }

      case "pot":
        // funding 阶段每个玩家 escrow 进 pot；这里只看 phase 转移。
        if (prev.phase === "funding") return { ...prev, phase: "dealing" };
        return prev;

      case "hand-start": {
        const next = { ...prev, handId: event.handId };
        if (prev.phase === "funding") next.phase = "dealing";
        else if (prev.phase === "hand-over") next.phase = "dealing";
        return next;
      }

      case "deal":
        if (!prev.handId || event.handId !== prev.handId) return prev;
        return { ...prev, phase: "playing" };

      case "showdown":
        if (!prev.handId || event.handId !== prev.handId) return prev;
        return { ...prev, phase: "dealer-play" };

      case "settlement":
        if (!prev.handId) return prev;
        if (event.handId !== prev.handId) return prev;
        // 一手结束：累计 + 进入 hand-over，等待下一手 dealing 或全局 settling。
        return {
          ...prev,
          phase: "hand-over",
          handsCompleted: prev.handsCompleted + 1,
          handId: ""
        };

      case "recovery":
        return { ...prev, phase: "aborted", abortReason: "recovery tx observed" };

      case "node-seed":
      case "chat-direct":
      case "chat-group":
      case "payment":
      case "identity":
      case "bet":
      case "board-reveal":
      case "game-start":
      case "other":
      case "unknown":
      default:
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
