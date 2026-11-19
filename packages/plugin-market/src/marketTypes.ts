import type { AppSourceEntry } from "@keymaster/contracts";

/** 单条手工来源/待验证项：Market 自生 ID，验证前只有用户输入和验证状态。 */
export interface MarketPendingItem {
  pendingId: string;
  /** 该次输入修订号；验证中删除或修改输入时，旧验证任务的迟到结果按此丢弃。 */
  revision: number;
  kind: "url";
  url?: string;
  /** 验证状态：待验证/验证失败/已验证。验证成功、同步失败仍保留已验证。 */
  validation: "pending" | "failed" | "verified";
  /** 验证失败原因。 */
  validationError?: string;
  /** 验签通过的完整已验证发布（手工来源）。 */
  verifiedPublication?: AppSourceEntry;
  verifiedAt?: number;
  /** 同步状态单独记录：未同步/同步失败/已同步/版本较低。 */
  syncStatus: "unsynced" | "sync-failed" | "synced" | "lower-version";
  syncError?: string;
  createdAt: number;
  updatedAt: number;
}

/** 已登记市场的配置；ID 是来源关联键与持久身份。 */
export interface MarketConfig {
  id: string;
  name: string;
  /** 完整目录 URL；第三方可使用任何路径或静态托管 JSON。 */
  directoryUrl: string;
  builtIn: boolean;
}

/** 单个市场的同步记录。 */
export interface MarketSyncRecord {
  lastSuccessAt: number | null;
  lastError: string | null;
  /** 本轮部分拒绝的结果（较低版本拒绝或单条失败），设置页展示。 */
  lastRejected: Array<{ sourceId: string; appPublicKeyHex: string; status: string; reason?: string }>;
}

/** 在途批次恢复日志：提交 Connect 前落盘，记账成功后清除。 */
export interface MarketJournal {
  marketId: string;
  pendingId?: string;
  revision?: number;
  changes: Array<{ kind: "submit"; sourceId: string; appPublicKeyHex: string; appVersion: string; publication: AppSourceEntry } | { kind: "invalidate"; sourceId: string; appPublicKeyHex: string }>;
}

export interface MarketStateDocument {
  version: 1;
  /** 已登记市场（含恰一个内置市场）。 */
  markets: MarketConfig[];
  /** 每个市场自己的已应用清单（marketId → 公钥 → 发布）。 */
  applied: Record<string, Record<string, AppSourceEntry>>;
  /** 手工来源与待验证项（按 pendingId）。 */
  pending: Record<string, MarketPendingItem>;
  /** 每个市场的同步记录（marketId → 记录）。 */
  sync: Record<string, MarketSyncRecord>;
  /** 在途批次恢复日志；空表示无未记账提交。 */
  journal: MarketJournal | null;
}

export interface MarketRepository {
  read(): Promise<{ document: MarketStateDocument; revision: number } | null>;
  write(document: MarketStateDocument, options: { ifRevision?: number }): Promise<number>;
}
