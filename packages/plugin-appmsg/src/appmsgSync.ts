// packages/plugin-appmsg/src/appmsgSync.ts
// appmsg 增量同步器（施工单 2026-07-04 001 + 2026-07-04 004 硬切换）。
//
// 设计缘由：
//   - 每个本地收件目标保存自己的 `lastSyncedMessageId`；
//   - 重连后 / 收到推送后 / 手动刷新后，按游标增量从 active provider
//     拉取新消息，按 messageId 去重写本地库；
//   - 同步是平台内部行为，app / plugin 无感知；
//   - 失败就失败：靠下次重连 / 下次推送 / 下次手动刷新继续；**不**抛错
//     反向阻塞推送分发，不引入额外 replay 队列；
//   - provider 已删的旧消息不影响本地已写入的副本（施工单 §7.5）；
//   - **不再**调用 wire 字符串方法 `request("message.list", ...)` ——
//     走 typed `MessageProviderOperations.listMessages(...)`；wire 翻译
//     完全由 provider 内部负责；
//   - 同步拿到的每条记录都是 sealed envelope record（**不再**含明文
//     body）；本模块**不**做 verify / decrypt——把解密委托给调用方
//     注入的 `openSealed` 回调（plugin-appmsgCore 唯一持有 ECDH 私钥）。

import type {
  AppMsgMessage,
  MessageProviderOperations,
  ProviderListInput,
  ProviderListResult,
  ProviderSealedMessageRecord
} from "@keymaster/contracts";
import type { AppMsgLocalDbOps } from "./appmsgDb.js";

export interface AppMsgSyncLogger {
  info?: (input: unknown) => void;
  warn?: (input: unknown) => void;
  error?: (input: unknown) => void;
}

function emitSyncLog(
  logger: AppMsgSyncLogger | undefined,
  level: "info" | "warn" | "error",
  event: string,
  data?: Record<string, unknown>
): void {
  if (!logger) return;
  const fn = logger[level];
  if (!fn) return;
  try {
    const payload: Record<string, unknown> = { event };
    if (data) {
      for (const key of Object.keys(data)) {
        payload[key] = data[key];
      }
    }
    fn(payload);
  } catch {
    // ignore
  }
}

export interface AppMsgSyncOutcome {
  /** 本次增量同步写入了多少条新消息到本地库。 */
  written: number;
  /** 新的 lastSyncedMessageId（同步完成后回写到本地库）。 */
  newCursorMessageId: string;
  /** 本次同步是否成功（best-effort，即使 0 条也算成功）。 */
  ok: boolean;
  /** 失败 message（成功时为 null）。 */
  error: string | null;
}

/** targetKey 默认值（基础结构）。 */
function baseTargetState(targetKey: string) {
  return {
    targetKey,
    lastSyncedMessageId: "",
    lastReceivedAtMs: 0,
    lastSyncStartedAtMs: 0,
    lastSyncCompletedAtMs: 0,
    lastSyncError: null as string | null
  };
}

/**
 * 一次单 scope 增量同步。
 *
 * 流程（施工单 2026-07-04 004 硬切换后）：
 *   1. 从本地库读出 `(providerId, targetKey)` 复合键的 lastSyncedMessageId
 *      作为 cursor（无则 `""`）。
 *   2. 写 `lastSyncStartedAtMs = now` 到 targets。
 *   3. 调 `providerOperations.listMessages({ownerPublicKeyHex,
 *      scopeEndpoint, afterMessageId, limit})` 拿 sealed records。
 *   4. 用 `openSealed` 把每条 sealed record 解密 → 公开 `AppMsgMessage`；
 *      验签 / 解密失败由 `openSealed` 内部 swallow 并返回 null。
 *   5. 把 items 按 messageId 去重后 put 到本地库（带 providerId）。
 *   6. 更新 target 的 `lastSyncedMessageId` 为本次 items 中最大
 *      messageId；同时写 `lastSyncCompletedAtMs` / `lastSyncError`。
 *
 * 任何一步失败：
 *   - 把 err 写到 `lastSyncError`；
 *   - `ok = false`，**不**抛错。
 */
export async function syncOneScope(input: {
  handle: MessageProviderOperations | null;
  ops: AppMsgLocalDbOps | null;
  providerId: string;
  ownerPublicKeyHex: string;
  scopeEndpoint: { kind: "origin" | "plugin"; id: string };
  targetKey: string;
  cursorMessageId: string;
  pageLimit?: number;
  /**
   * 把 sealed record 翻译成公开 `AppMsgMessage`；由调用方注入
   * （plugin-appmsgCore）以保证密钥闭包仅在 core 内持有。返回 null
   * 表示该条 sealed record 验签或解密失败——按 fail-closed 跳过。
   */
  openSealed: (rec: ProviderSealedMessageRecord) => Promise<AppMsgMessage | null>;
  /** 每条新消息成功写入本地库后通知上层刷新其 scoped 资源。 */
  onMessageStored?: (message: AppMsgMessage) => void;
  logger?: AppMsgSyncLogger;
}): Promise<AppMsgSyncOutcome> {
  const startedAt = Date.now();
  emitSyncLog(input.logger, "info", "appmsg.sync.scope.begin", {
    providerId: input.providerId,
    ownerPublicKeyHex: input.ownerPublicKeyHex,
    targetKey: input.targetKey,
    scopeKind: input.scopeEndpoint.kind,
    scopeId: input.scopeEndpoint.id,
    cursorMessageId: input.cursorMessageId,
    pageLimit: input.pageLimit ?? 100,
    hasHandle: input.handle !== null,
    hasLocalDb: input.ops !== null
  });
  if (input.ops) {
    try {
      const prev =
        (await input.ops.getTargetState(input.providerId, input.targetKey)) ??
        baseTargetState(input.targetKey);
      await input.ops.putTargetState(input.providerId, {
        ...prev,
        lastSyncStartedAtMs: startedAt
      });
    } catch {
      // swallow
    }
  }

  if (!input.handle || !input.ops) {
    return fail(
      input.ops,
      input.providerId,
      input.targetKey,
      startedAt,
      "no connection or local db"
    );
  }

  let res: ProviderListResult;
  try {
    const listInput: ProviderListInput = {
      ownerPublicKeyHex: input.ownerPublicKeyHex,
      scopeEndpoint: input.scopeEndpoint,
      afterMessageId: input.cursorMessageId,
      limit: input.pageLimit ?? 100
    };
    emitSyncLog(input.logger, "info", "appmsg.sync.scope.list.begin", {
      providerId: input.providerId,
      targetKey: input.targetKey,
      scopeKind: input.scopeEndpoint.kind,
      scopeId: input.scopeEndpoint.id,
      afterMessageId: input.cursorMessageId,
      limit: listInput.limit
    });
    res = await input.handle.listMessages(listInput);
    emitSyncLog(input.logger, "info", "appmsg.sync.scope.list.done", {
      providerId: input.providerId,
      targetKey: input.targetKey,
      itemCount: res?.items?.length ?? 0,
      hasMore: res?.hasMore ?? false,
      elapsedMs: Date.now() - startedAt
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitSyncLog(input.logger, "error", "appmsg.sync.scope.list.failed", {
      providerId: input.providerId,
      targetKey: input.targetKey,
      elapsedMs: Date.now() - startedAt,
      err: msg
    });
    return fail(
      input.ops,
      input.providerId,
      input.targetKey,
      startedAt,
      msg
    );
  }
  const items = res?.items ?? [];
  if (items.length === 0) {
    await okIdle(
      input.ops,
      input.providerId,
      input.targetKey,
      startedAt,
      input.cursorMessageId
    );
    emitSyncLog(input.logger, "info", "appmsg.sync.scope.idle", {
      providerId: input.providerId,
      targetKey: input.targetKey,
      cursorMessageId: input.cursorMessageId,
      elapsedMs: Date.now() - startedAt
    });
    return {
      written: 0,
      newCursorMessageId: input.cursorMessageId,
      ok: true,
      error: null
    };
  }

  const seen = new Set<string>();
  const toWrite: AppMsgMessage[] = [];
  let maxMessageId = input.cursorMessageId;
  let openedCount = 0;
  let skippedDuplicateCount = 0;
  let skippedCryptoCount = 0;
  for (const rec of items) {
    if (!rec?.messageId) continue;
    if (seen.has(rec.messageId)) {
      skippedDuplicateCount += 1;
      continue;
    }
    seen.add(rec.messageId);
    const m = await input.openSealed(rec);
    if (!m) {
      skippedCryptoCount += 1;
      continue;
    }
    openedCount += 1;
    toWrite.push(m);
    if (m.messageId > maxMessageId) maxMessageId = m.messageId;
  }
  emitSyncLog(input.logger, "info", "appmsg.sync.scope.opened", {
    providerId: input.providerId,
    targetKey: input.targetKey,
    receivedCount: items.length,
    openedCount,
    skippedDuplicateCount,
    skippedCryptoCount,
    maxMessageId
  });
  // 写入前先**用本地 DB 的 (providerId, targetId) 维度去重**——同一
  // message 已经在 DB 命中 targetId 时本次跳过，避免"重复 cover"表面
  // 写入。
  const filtered: AppMsgMessage[] = [];
  let skippedExistingCount = 0;
  for (const m of toWrite) {
    let skip = false;
    try {
      const existing = await input.ops.getMessageForTarget({
        providerId: input.providerId,
        messageId: m.messageId,
        targetId: input.targetKey
      });
      if (existing) skip = true;
    } catch {
      // 取失败不阻断写入
    }
    if (!skip) {
      filtered.push(m);
    } else {
      skippedExistingCount += 1;
    }
  }
  emitSyncLog(input.logger, "info", "appmsg.sync.scope.filtered", {
    providerId: input.providerId,
    targetKey: input.targetKey,
    candidateCount: toWrite.length,
    filteredCount: filtered.length,
    skippedExistingCount
  });
  let written = 0;
  try {
    written = await input.ops.putMessages(input.providerId, filtered);
    for (const message of filtered) {
      try {
        input.onMessageStored?.(message);
      } catch {
        // 数据已落库；刷新监听器失败不能反向破坏同步结果。
      }
    }
    emitSyncLog(input.logger, "info", "appmsg.sync.scope.write.done", {
      providerId: input.providerId,
      targetKey: input.targetKey,
      filteredCount: filtered.length,
      written,
      elapsedMs: Date.now() - startedAt
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitSyncLog(input.logger, "error", "appmsg.sync.scope.write.failed", {
      providerId: input.providerId,
      targetKey: input.targetKey,
      filteredCount: filtered.length,
      elapsedMs: Date.now() - startedAt,
      err: msg
    });
    return fail(
      input.ops,
      input.providerId,
      input.targetKey,
      startedAt,
      msg
    );
  }
  try {
    const prev =
      (await input.ops.getTargetState(input.providerId, input.targetKey)) ??
      baseTargetState(input.targetKey);
    await input.ops.putTargetState(input.providerId, {
      ...prev,
      lastSyncedMessageId: maxMessageId,
      lastSyncStartedAtMs: startedAt,
      lastSyncCompletedAtMs: Date.now(),
      lastSyncError: null
    });
  } catch {
    // swallow
  }
  emitSyncLog(input.logger, "info", "appmsg.sync.scope.completed", {
    providerId: input.providerId,
    targetKey: input.targetKey,
    written,
    newCursorMessageId: maxMessageId,
    elapsedMs: Date.now() - startedAt
  });
  return {
    written,
    newCursorMessageId: maxMessageId,
    ok: true,
    error: null
  };
}

async function okIdle(
  ops: AppMsgLocalDbOps | null,
  providerId: string,
  targetKey: string,
  startedAt: number,
  cursor: string
): Promise<void> {
  if (!ops) return;
  try {
    const prev =
      (await ops.getTargetState(providerId, targetKey)) ??
      baseTargetState(targetKey);
    await ops.putTargetState(providerId, {
      ...prev,
      lastSyncedMessageId: prev.lastSyncedMessageId || cursor,
      lastSyncStartedAtMs: startedAt,
      lastSyncCompletedAtMs: Date.now(),
      lastSyncError: null
    });
  } catch {
    // swallow
  }
}

async function fail(
  ops: AppMsgLocalDbOps | null,
  providerId: string,
  targetKey: string,
  startedAt: number,
  err: string
): Promise<AppMsgSyncOutcome> {
  if (ops) {
    try {
      const prev =
        (await ops.getTargetState(providerId, targetKey)) ??
        baseTargetState(targetKey);
      await ops.putTargetState(providerId, {
        ...prev,
        lastSyncStartedAtMs: startedAt,
        lastSyncCompletedAtMs: Date.now(),
        lastSyncError: err
      });
    } catch {
      // swallow
    }
  }
  return { written: 0, newCursorMessageId: "", ok: false, error: err };
}

/**
 * 全量一次同步：把所有已知 scopeEndpoint 都同步一次。
 *
 * cursor key = `(providerId, targetKey)`——切 provider 后 cursor 不串。
 */
export async function syncAllScopes(input: {
  handle: MessageProviderOperations | null;
  ops: AppMsgLocalDbOps | null;
  providerId: string;
  ownerPublicKeyHex: string;
  scopeEndpoints: Array<{ kind: "origin" | "plugin"; id: string }>;
  pageLimit?: number;
  resolveTargetKey: (ep: { kind: "origin" | "plugin"; id: string }) => string;
  loadCursor: (targetKey: string) => Promise<string>;
  openSealed: (rec: ProviderSealedMessageRecord) => Promise<AppMsgMessage | null>;
  onMessageStored?: (message: AppMsgMessage) => void;
  logger?: AppMsgSyncLogger;
}): Promise<AppMsgSyncOutcome[]> {
  const startedAt = Date.now();
  emitSyncLog(input.logger, "info", "appmsg.sync.all.begin", {
    providerId: input.providerId,
    ownerPublicKeyHex: input.ownerPublicKeyHex,
    scopeCount: input.scopeEndpoints.length,
    hasHandle: input.handle !== null,
    hasLocalDb: input.ops !== null
  });
  const out: AppMsgSyncOutcome[] = [];
  for (const ep of input.scopeEndpoints) {
    const targetKey = input.resolveTargetKey(ep);
    const cursor = await input.loadCursor(targetKey).catch(() => "");
    emitSyncLog(input.logger, "info", "appmsg.sync.all.scope_queued", {
      providerId: input.providerId,
      targetKey,
      scopeKind: ep.kind,
      scopeId: ep.id,
      cursorMessageId: cursor
    });
    out.push(
      await syncOneScope({
        handle: input.handle,
        ops: input.ops,
        providerId: input.providerId,
        ownerPublicKeyHex: input.ownerPublicKeyHex,
        scopeEndpoint: ep,
        targetKey,
        cursorMessageId: cursor,
        pageLimit: input.pageLimit,
        openSealed: input.openSealed,
        onMessageStored: input.onMessageStored,
        logger: input.logger
      })
    );
  }
  const okCount = out.filter((item) => item.ok).length;
  const failCount = out.length - okCount;
  const written = out.reduce((sum, item) => sum + item.written, 0);
  emitSyncLog(input.logger, "info", "appmsg.sync.all.completed", {
    providerId: input.providerId,
    scopeCount: out.length,
    okCount,
    failCount,
    written,
    elapsedMs: Date.now() - startedAt
  });
  return out;
}
