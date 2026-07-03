// packages/plugin-message/src/MessagePage.tsx
// 系统消息应用页面：查看 / 管理本地消息。
//
// 设计缘由（施工单 2026-07-03 001 §5.4）：
//   - 列表 / 搜索 / 按 appId/origin 分组 / 本地统计 / 本地同步状态 /
//     在线查询都从这里出；**不**依赖远端 HubMsg 数量统计。
//   - 渲染：尽量简，只展示 message body + sender + 同步状态 + 在线状态。

import React, { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AppMsgCore,
  AppMsgLocalDbSnapshot,
  AppMsgMessage,
  AppMsgTargetSyncState
} from "@keymaster/contracts";
import { APPMESSAGE_CORE_CAPABILITY } from "@keymaster/contracts";
import { createMessageService } from "./messageService.js";

/**
 * 系统消息应用页面。
 *
 * 简化版本：单组件，挂载时从 `appmsg.core` 拿能力，渲染列表 + 同步状态
 * + 在线查询入口。组件依赖 `appmsg.core` capability；宿主在挂载时通过
 * plugin context 注入。
 */
export function MessagePage(props: {
  /**
   * 可选：注入 `appmsg.core`。不传时从全局 capability registry 取（测试
   * 场景下从 props 注入更稳定）。
   */
  appMsgCore?: AppMsgCore;
}): React.ReactElement {
  // 简化：宿主应当通过 React context 注入 appmsg.core；这里从 props 拿，
  // 兜底走 window["appmsg.core"]（极少使用，仅供手测脚本）。
  const core = props.appMsgCore ?? readGlobalCore();
  if (!core) {
    return (
      <section data-appmsg-page="missing-core">
        <h1>Messages</h1>
        <p style={{ color: "var(--km-fg-muted, #888)" }}>
          appmsg.core capability is not available.
        </p>
      </section>
    );
  }

  const service = useMemo(() => createMessageService(core), [core]);
  const [snapshot, setSnapshot] = useState<AppMsgLocalDbSnapshot>(() =>
    service.getLocalDbSnapshot()
  );
  const [messages, setMessages] = useState<AppMsgMessage[]>([]);
  const [targets, setTargets] = useState<AppMsgTargetSyncState[]>([]);
  const [searchInput, setSearchInput] = useState("");
  const [onlineQueryHex, setOnlineQueryHex] = useState("");
  const [onlineResult, setOnlineResult] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    setSnapshot(service.getLocalDbSnapshot());
    const res = await service.listLocalMessages({ limit: 200 });
    setMessages(res);
    setTargets(await service.listTargetSyncStates());
  }, [service]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 过滤（UI 本地行为）
  const filtered = useMemo(() => {
    const q = searchInput.trim().toLowerCase();
    if (!q) return messages;
    return messages.filter((m) => (m.body ?? "").toLowerCase().includes(q));
  }, [messages, searchInput]);

  const syncStateLabel =
    snapshot.state === "open"
      ? "Connected"
      : snapshot.state === "closed"
        ? "Disconnected"
        : "Idle";

  return (
    <section data-appmsg-page="messages" style={{ padding: 16 }}>
      <h1 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>Messages</h1>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
        <span data-appmsg-sync-state={snapshot.state}>{syncStateLabel}</span>
        <button
          type="button"
          onClick={() => {
            void service.triggerSync().then(() => refresh());
          }}
        >
          Refresh
        </button>
      </div>

      <div style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Sync state</h2>
        {targets.length === 0 ? (
          <p style={{ color: "var(--km-fg-muted, #888)" }}>No targets synced yet.</p>
        ) : (
          <ul>
            {targets.map((t) => (
              <li key={t.targetKey}>
                <code>{t.targetKey}</code>
                {" — last synced: "}
                {t.lastSyncedMessageId || "(none)"}
                {t.lastSyncError ? ` (error: ${t.lastSyncError})` : ""}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Search</h2>
        <input
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="filter messages by body"
          style={{ width: 280 }}
        />
      </div>

      <div style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Online check</h2>
        <input
          type="text"
          value={onlineQueryHex}
          onChange={(e) => setOnlineQueryHex(e.target.value)}
          placeholder="publicKeyHex (66 hex chars)"
          style={{ width: 360 }}
        />
        <button
          type="button"
          onClick={async () => {
            const hex = onlineQueryHex.trim();
            if (!/^[0-9a-f]{66}$/i.test(hex)) return;
            const res = await service.checkOnline([hex]);
            setOnlineResult(res as unknown as Record<string, string>);
          }}
        >
          Check online
        </button>
        <ul>
          {Object.entries(onlineResult).map(([k, v]) => (
            <li key={k}>
              <code>{k.slice(0, 8)}…</code>: {v}
            </li>
          ))}
        </ul>
      </div>

      <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Local messages</h2>
      {filtered.length === 0 ? (
        <p style={{ color: "var(--km-fg-muted, #888)" }}>No local messages yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {filtered.map((m) => (
            <li
              key={m.messageId}
              style={{
                padding: "8px 0",
                borderBottom: "1px solid var(--km-border, #eee)"
              }}
            >
              <div style={{ fontSize: 12, color: "var(--km-fg-muted, #888)" }}>
                from <code>{m.senderPublicKeyHex.slice(0, 8)}…</code>
                {m.senderOrigin ? ` (${m.senderOrigin})` : ""}
                {m.senderAppId ? ` (${m.senderAppId})` : ""}
                {" → "}
                <code>{m.recipientPublicKeyHex.slice(0, 8)}…</code>
                {m.recipientOrigin ? ` (${m.recipientOrigin})` : ""}
                {m.recipientAppId ? ` (${m.recipientAppId})` : ""}
              </div>
              <div style={{ whiteSpace: "pre-wrap" }}>{m.body}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 兜底：读 `window["__keymaster_appmsg_core__"]` 全局 core（极少使用）。 */
function readGlobalCore(): AppMsgCore | undefined {
  try {
    if (typeof window === "undefined") return undefined;
    const v = (window as unknown as Record<string, unknown>)["__keymaster_appmsg_core__"];
    return (v as AppMsgCore | undefined) ?? undefined;
  } catch {
    return undefined;
  }
}
