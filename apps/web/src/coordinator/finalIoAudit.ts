// Coordinator 最终 I/O 审计：记录已经进入最终租约边界的业务操作。
//
// 这不是业务重试日志，也不保存请求内容。它只回答发布验收需要的两个
// 问题：某个不可逆入口是否经过统一 lease，以及该次结果应被当作成功、
// 失败还是未知。写操作失败时默认归类为 unknown，调用方必须回到领域
// 仓库核对，不能把它当成可安全重放。

export type FinalIoAuditOperation =
  | "coordinator.bootstrap.recover"
  | "coordinator.settings.persist"
  | "coordinator.plugin-intent.persist"
  | "keyspace.delete-journal.recover"
  | "keyspace.active.set"
  | "vault.unlock"
  | "vault.activate-key"
  | "vault.digest.sign"
  | "vault.address.derive"
  | "service.owner-generation.read"
  | "service.crypto.sign"
  | "storage.control"
  | "storage.platform.data"
  | "storage.owner.data"
  | "storage.owner.files"
  | "storage.connect.data"
  | "storage.owner.delete"
  | "msfile.data"
  | "msfile.control"
  | "sat.address.derive"
  | "sat.operation"
  | "channel.subscribe"
  | "channel.unsubscribe"
  | "channel.public-publish"
  | "channel.hash-publish"
  | "channel.private-publish"
  | "channel.incoming-decrypt"
  | "channel.history-open"
  | "window-p2p.identity.sign"
  | "window-p2p.spike-transfer"
  | "contacts.presence-probe"
  | "p2pkh.sync"
  | "p2pkh.utxo-snapshot"
  | "token-bsv21.sync"
  | "token-stas.sync"
  | "collectible-1satordinals.sync"
  | "vault.operation"
  | "p2pkh.broadcast";

export type FinalIoAuditOutcome = "completed" | "failed" | "unknown";

export interface FinalIoAuditSnapshot {
  /** 当前内存审计窗口中的每个入口统计；不包含请求 payload。 */
  operations: Readonly<Record<string, {
    /** 已进入最终租约的次数。 */
    admitted: number;
    /** 最终边界确认成功的次数。 */
    completed: number;
    /** 明确失败且未视为未知结果的次数。 */
    failed: number;
    /** 可能已触发不可逆副作用、必须查领域仓库的次数。 */
    unknown: number;
  }>>;
}

interface MutableAuditStats {
  admitted: number;
  completed: number;
  failed: number;
  unknown: number;
}

export interface FinalIoAuditHandle {
  finish(outcome: FinalIoAuditOutcome): void;
}

export interface FinalIoAudit {
  begin(operation: FinalIoAuditOperation): FinalIoAuditHandle;
  snapshot(): FinalIoAuditSnapshot;
}

function emptyStats(): MutableAuditStats {
  return { admitted: 0, completed: 0, failed: 0, unknown: 0 };
}

/** 创建有界的最终 I/O 审计器；只保留按 operation 聚合的计数。 */
export function createFinalIoAudit(): FinalIoAudit {
  const stats = new Map<string, MutableAuditStats>();
  return {
    begin(operation) {
      const current = stats.get(operation) ?? emptyStats();
      current.admitted += 1;
      stats.set(operation, current);
      let finished = false;
      return {
        finish(outcome) {
          if (finished) return;
          finished = true;
          current[outcome] += 1;
        },
      };
    },
    snapshot() {
      const operations: Record<string, MutableAuditStats> = {};
      for (const [operation, current] of stats) operations[operation] = { ...current };
      return { operations };
    },
  };
}
