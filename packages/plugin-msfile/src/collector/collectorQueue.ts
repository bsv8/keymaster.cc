// 采集队列纯逻辑：合并、触发判定、版本 pinning 确认。
// 无 IO，状态由 collectorState 持久化，调度由 collectorService 驱动。

import type { CollectorRecord } from "./collectorCodec.js";

/** 超过 1000 条（即达到 1001 条）提前触发。 */
export const COLLECTOR_EARLY_TRIGGER_COUNT = 1001;

/** 每小时触发一次。 */
export const COLLECTOR_HOURLY_MS = 3_600_000;

/** 发送中批次：固定的 gzip、签名与该批记录版本。 */
export interface CollectorInflight {
  /** 实际发送的 gzip Base64（重试复用，不反复压缩）。 */
  gzipBase64: string;
  /** low-S DER hex。 */
  signatureHex: string;
  /** 压缩公钥小写 hex。 */
  pubkeyHex: string;
  /** 该批发送的记录版本（按 Hash）。 */
  records: Record<string, CollectorRecord>;
  /** 触发来源：early/hourly/manual。 */
  trigger: string;
}

/** 已确认状态：每个 Hash 最近成功提交的完整记录（变化检测只看文件名、介绍）。 */
export type CollectorConfirmedEntry = CollectorRecord;

/** 同一 Hash 的提交内容是否相同（名称、介绍、长度、MIME 全比）。 */
export function collectorSameRecord(a: CollectorRecord | undefined, b: CollectorRecord | undefined): boolean {
  return !!a && !!b
    && a.fileName === b.fileName && a.description === b.description
    && a.fileSizeBytes === b.fileSizeBytes && a.mediaType === b.mediaType;
}

/**
 * 入队判定：与已确认一致且无排队差异则 noop，否则合并为最新。
 * 仅名称或介绍变化触发的规则由调用方保证（长度/MIME 变化不调用）。
 */
export function collectorUpsert(
  confirmed: Record<string, CollectorConfirmedEntry>,
  pending: Record<string, CollectorRecord>,
  record: CollectorRecord,
): "queued" | "noop" {
  const known = confirmed[record.seedHashHex];
  const queued = pending[record.seedHashHex];
  const matchesConfirmed = !!known && known.fileName === record.fileName && known.description === record.description;
  if (matchesConfirmed && (!queued || collectorSameRecord(queued, record))) return "noop";
  pending[record.seedHashHex] = { ...record };
  return "queued";
}

/** 触发判定：early 优先于 hourly。 */
export function collectorShouldTrigger(pendingCount: number, nowMs: number, lastAttemptAtMs: number): "early" | "hourly" | null {
  if (pendingCount >= COLLECTOR_EARLY_TRIGGER_COUNT) return "early";
  if (nowMs - lastAttemptAtMs >= COLLECTOR_HOURLY_MS) return "hourly";
  return null;
}

/**
 * 成功确认：只确认该批发送的版本；提交期间产生的新修改保留。
 * 返回确认的 Hash 列表。
 */
export function collectorConfirm(
  confirmed: Record<string, CollectorConfirmedEntry>,
  pending: Record<string, CollectorRecord>,
  sent: Record<string, CollectorRecord>,
): string[] {
  const done: string[] = [];
  for (const [hash, version] of Object.entries(sent)) {
    const current = pending[hash];
    if (current && collectorSameRecord(current, version)) {
      confirmed[hash] = { ...version };
      delete pending[hash];
      done.push(hash);
    } else if (!current) {
      confirmed[hash] = { ...version };
      done.push(hash);
    }
  }
  return done;
}
