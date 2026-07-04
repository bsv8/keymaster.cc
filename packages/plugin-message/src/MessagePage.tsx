// packages/plugin-message/src/MessagePage.tsx
// 系统消息应用页面：查看 / 管理本地消息。
//
// 设计缘由（施工单 2026-07-03 001 + 反馈 §"必须修改"）：
//   - 列表 / 搜索 / 按 appId/origin 分组 / 本地统计 / 本地同步状态 /
//     在线查询都从这里出；**不**依赖远端 HubMsg 数量统计。
//   - 渲染：尽量简，只展示 message body + sender + 同步状态 + 在线状态。
//   - 接入方式：插件页面直接通过 `useCapability<AppMsgCore>("appmsg.core")`
//     从平台 runtime 取 core；**不**通过 props 注入主路径，也不访问任何
//     `window.__keymaster_appmsg_core__` 全局变量。

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useCapability, useI18n } from "@keymaster/runtime";
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
 * 直接通过 `useCapability` 取 `appmsg.core`；**不**走 props 注入。
 * 在宿主通过 `PluginHostProvider` / `usePluginContext` 等提供的 React 上下文
 * 里渲染即可拿到。
 */
export function MessagePage(): React.ReactElement {
  const core = useCapability<AppMsgCore>(APPMESSAGE_CORE_CAPABILITY);
  const i18n = useI18n();

  // 在没有 appmsg.core 的极端 host（裸测试 / 单元测试场景）下，给一个空态。
  if (!core) {
    return (
      <section data-appmsg-page="missing-core" style={{ padding: 16 }}>
        <h1 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>
          {i18n.t("message.platform.title")}
        </h1>
        <p style={{ color: "var(--km-fg-muted, #888)" }}>
          appmsg.core capability is not available.
        </p>
      </section>
    );
  }

  return <MessagePageInner core={core} />;
}

/**
 * 内部分离式组件——避免每次 core 变化时 useI18n 被重置。
 */
function MessagePageInner({ core }: { core: AppMsgCore }): React.ReactElement {
  const i18n = useI18n();
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
    const listRes = await service.listLocalMessages({ limit: 200 });
    setMessages(listRes.items);
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
      ? i18n.t("message.page.sync.state.open")
      : snapshot.state === "closed"
        ? i18n.t("message.page.sync.state.closed")
        : i18n.t("message.page.sync.state.idle");

  return (
    <section data-appmsg-page="messages" style={{ padding: 16 }}>
      <h1 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>
        {i18n.t("message.platform.title")}
      </h1>
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          marginBottom: 12
        }}
      >
        <span data-appmsg-sync-state={snapshot.state}>{syncStateLabel}</span>
        <button
          type="button"
          onClick={() => {
            void service.triggerSync().then(() => refresh());
          }}
        >
          {i18n.t("message.page.refresh")}
        </button>
      </div>

      <div style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
          {i18n.t("message.page.sync.state.label")}
        </h2>
        {targets.length === 0 ? (
          <p style={{ color: "var(--km-fg-muted, #888)" }}>
            {i18n.t("message.page.sync.state.no_targets")}
          </p>
        ) : (
          <ul>
            {targets.map((t) => (
              <li key={t.targetKey}>
                <code>{t.targetKey}</code>
                {" — "} {i18n.t("message.page.sync.lastSynced")}:{" "}
                {t.lastSyncedMessageId || "(none)"}
                {t.lastSyncError ? ` (${i18n.t("message.page.sync.error")}: ${t.lastSyncError})` : ""}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
          {i18n.t("message.page.search.label")}
        </h2>
        <input
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={i18n.t("message.page.search.placeholder")}
          style={{ width: 280 }}
        />
      </div>

      <div style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
          {i18n.t("message.page.online.label")}
        </h2>
        <input
          type="text"
          value={onlineQueryHex}
          onChange={(e) => setOnlineQueryHex(e.target.value)}
          placeholder={i18n.t("message.page.online.placeholder")}
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
          {i18n.t("message.page.checkOnline")}
        </button>
        <ul>
          {Object.entries(onlineResult).map(([k, v]) => (
            <li key={k}>
              <code>{k.slice(0, 8)}…</code>:{" "}
              {v === "online"
                ? i18n.t("message.page.online.online")
                : v === "offline"
                  ? i18n.t("message.page.online.offline")
                  : i18n.t("message.page.online.unknown")}
            </li>
          ))}
        </ul>
      </div>

      <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
        {i18n.t("message.page.list.label")}
      </h2>
      {filtered.length === 0 ? (
        <p style={{ color: "var(--km-fg-muted, #888)" }}>
          {i18n.t("message.page.empty")}
        </p>
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
              <div
                style={{ fontSize: 12, color: "var(--km-fg-muted, #888)" }}
              >
                {i18n.t("message.page.sender.label")}{" "}
                <code>{m.senderPublicKeyHex.slice(0, 8)}…</code>
                {m.senderOrigin ? ` (${m.senderOrigin})` : ""}
                {m.senderAppId ? ` (${m.senderAppId})` : ""}
                {" → "}
                {i18n.t("message.page.recipient.label")}{" "}
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
