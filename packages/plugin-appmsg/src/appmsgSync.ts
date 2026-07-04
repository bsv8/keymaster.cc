// packages/plugin-appmsg/src/appmsgSync.ts
// appmsg 增量同步器。
//
// 设计缘由（施工单 2026-07-03 001 §5.2 / §7.3 / §7.5）：
//   - 每个本地收件目标保存自己的 `lastSyncedMessageId`。
//   - 重连后 / 收到推送后 / 手动刷新后，按游标增量从 HubMsg `message.list`
//     拉取新消息，按 messageId 去重写本地库。
//   - 同步是平台内部行为，app / plugin 无感知。
//   - 失败就失败：靠下次重连 / 下次推送 / 下次手动刷新继续；**不**抛错反
//     向阻塞推送分发，不引入额外 replay 队列。
//   - HubMsg 已删的旧消息不影响本地已写入的副本（施工单 §7.5）。

import type { AppMsgMessage } from "@keymaster/contracts";
import type { HubMsgConnectionLike, HubMsgMessageRecord } from "./hubmsgConnection.js";
import type { AppMsgLocalDbOps } from "./appmsgDb.js";

/**
 * 把 HubMsg wire `HubMsgMessageRecord` 转成公开 `AppMsgMessage`。
 */
function recordToPublicMessage(rec: HubMsgMessageRecord): AppMsgMessage {
  const sOrigin = rec.senderEndpoint.kind === "origin" ? rec.senderEndpoint.id : undefined;
  const sAppId = rec.senderEndpoint.kind === "plugin" ? rec.senderEndpoint.id : undefined;
  const rOrigin = rec.recipientEndpoint.kind === "origin" ? rec.recipientEndpoint.id : undefined;
  const rAppId = rec.recipientEndpoint.kind === "plugin" ? rec.recipientEndpoint.id : undefined;
  const out: AppMsgMessage = {
    messageId: rec.messageId,
    clientMessageId: rec.clientMessageId,
    senderPublicKeyHex: rec.senderOwnerPublicKeyHex,
    recipientPublicKeyHex: rec.recipientOwnerPublicKeyHex,
    contentType: rec.contentType,
    body: rec.body,
    createdAtMs: rec.createdAtMs,
    insertedAtMs: rec.insertedAtMs
  };
  if (sOrigin) out.senderOrigin = sOrigin;
  else if (sAppId) out.senderAppId = sAppId;
  if (rOrigin) out.recipientOrigin = rOrigin;
  else if (rAppId) out.recipientAppId = rAppId;
  return out;
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
 * 流程见施工单 §5.2：
 *   1. 从本地库读出 lastSyncedMessageId 作为 cursor（无则 `""`）。
 *   2. 写 `lastSyncStartedAtMs = now` 到 targets。
 *   3. 调 HubMsg `message.list`（scope = owner+endpoint，afterMessageId = cursor）。
 *   4. 把 items 按 messageId 去重（write 自身就是幂等的，但不去重会增加
 *      写开销；这里仅做数量统计）后 put 到本地库。
 *   5. 更新 target 的 `lastSyncedMessageId` 为本次 items 中最大 messageId；
 *      同时写 `lastSyncCompletedAtMs` / `lastSyncError`。
 *
 * 任何一步失败：
 *   - 把 err 写到 `lastSyncError`；
 *   - `ok = false`，**不**抛错。
 */
export async function syncOneScope(input: {
  conn: HubMsgConnectionLike | null;
  ops: AppMsgLocalDbOps | null;
  ownerPublicKeyHex: string;
  scopeEndpoint: { kind: "origin" | "plugin"; id: string };
  targetKey: string;
  cursorMessageId: string;
  pageLimit?: number;
}): Promise<AppMsgSyncOutcome> {
  const startedAt = Date.now();
  if (input.ops) {
    try {
      const prev =
        (await input.ops.getTargetState(input.targetKey)) ??
        baseTargetState(input.targetKey);
      await input.ops.putTargetState({
        ...prev,
        lastSyncStartedAtMs: startedAt
      });
    } catch {
      // swallow
    }
  }

  if (!input.conn || !input.ops) {
    return fail(input.ops, input.targetKey, startedAt, "no connection or local db");
  }

  let res: { items?: HubMsgMessageRecord[] };
  try {
    res = await input.conn.request<
      {
        scopeEndpoint: { kind: "origin" | "plugin"; id: string };
        scopeOwnerPublicKeyHex: string;
        afterMessageId: string;
        limit: number;
        box: "all";
      },
      { items?: HubMsgMessageRecord[] }
    >("message.list", {
      scopeEndpoint: input.scopeEndpoint,
      scopeOwnerPublicKeyHex: input.ownerPublicKeyHex,
      afterMessageId: input.cursorMessageId,
      limit: input.pageLimit ?? 100,
      box: "all"
    });
  } catch (err) {
    return fail(
      input.ops,
      input.targetKey,
      startedAt,
      err instanceof Error ? err.message : String(err)
    );
  }
  const items = res?.items ?? [];
  if (items.length === 0) {
    await okIdle(input.ops, input.targetKey, startedAt, input.cursorMessageId);
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
  for (const item of items) {
    if (!item?.messageId) continue;
    if (seen.has(item.messageId)) continue;
    seen.add(item.messageId);
    toWrite.push(recordToPublicMessage(item));
    if (item.messageId > maxMessageId) maxMessageId = item.messageId;
  }
  // 写入前先**用本地 DB 的 target 维度去重**——同一 message 已经在 DB
  // 命中 targetId 时本次跳过，避免"重复 cover"表面写入。
  const filtered: AppMsgMessage[] = [];
  for (const m of toWrite) {
    let skip = false;
    try {
      const existing = await input.ops.getMessageForTarget({
        messageId: m.messageId,
        targetId: input.targetKey
      });
      if (existing) skip = true;
    } catch {
      // 取失败不阻断写入
    }
    if (!skip) filtered.push(m);
  }
  let written = 0;
  try {
    written = await input.ops.putMessages(filtered);
  } catch (err) {
    return fail(
      input.ops,
      input.targetKey,
      startedAt,
      err instanceof Error ? err.message : String(err)
    );
  }
  try {
    const prev =
      (await input.ops.getTargetState(input.targetKey)) ??
      baseTargetState(input.targetKey);
    await input.ops.putTargetState({
      ...prev,
      lastSyncedMessageId: maxMessageId,
      lastSyncStartedAtMs: startedAt,
      lastSyncCompletedAtMs: Date.now(),
      lastSyncError: null
    });
  } catch {
    // swallow
  }
  return {
    written,
    newCursorMessageId: maxMessageId,
    ok: true,
    error: null
  };
}

async function okIdle(
  ops: AppMsgLocalDbOps | null,
  targetKey: string,
  startedAt: number,
  cursor: string
): Promise<void> {
  if (!ops) return;
  try {
    const prev = (await ops.getTargetState(targetKey)) ?? baseTargetState(targetKey);
    await ops.putTargetState({
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
  targetKey: string,
  startedAt: number,
  err: string
): Promise<AppMsgSyncOutcome> {
  if (ops) {
    try {
      const prev = (await ops.getTargetState(targetKey)) ?? baseTargetState(targetKey);
      await ops.putTargetState({
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
 */
export async function syncAllScopes(input: {
  conn: HubMsgConnectionLike | null;
  ops: AppMsgLocalDbOps | null;
  ownerPublicKeyHex: string;
  scopeEndpoints: Array<{ kind: "origin" | "plugin"; id: string }>;
  pageLimit?: number;
  resolveTargetKey: (ep: { kind: "origin" | "plugin"; id: string }) => string;
  loadCursor: (targetKey: string) => Promise<string>;
}): Promise<AppMsgSyncOutcome[]> {
  const out: AppMsgSyncOutcome[] = [];
  for (const ep of input.scopeEndpoints) {
    const targetKey = input.resolveTargetKey(ep);
    const cursor = await input.loadCursor(targetKey).catch(() => "");
    out.push(
      await syncOneScope({
        conn: input.conn,
        ops: input.ops,
        ownerPublicKeyHex: input.ownerPublicKeyHex,
        scopeEndpoint: ep,
        targetKey,
        cursorMessageId: cursor,
        pageLimit: input.pageLimit
      })
    );
  }
  return out;
}
