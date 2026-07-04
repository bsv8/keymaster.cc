// packages/plugin-message/src/MessageDetailPage.tsx
// 单条消息详情页（施工单 2026-07-03 002 硬切换）。
//
// 设计缘由：
//   - 路由 `/messages/:messageId`：从 URL 拿 messageId，调 scoped client
//     `getMessage({ messageId })` 拉单条；
//   - 仅展示 `keymaster.message` scope 内可见消息；越权 `messageId`
//     返回 null → 详情页显示空态；
//   - 详情页**不**展示 HubMsg 连接态 / 同步态 / 全局统计；
//   - 顶部"返回"链到 `/messages`。

import React, { useEffect, useState } from "react";
import { useCapability, useI18n, router } from "@keymaster/runtime";
import { useParams } from "react-router";
import type { AppMsgMessage } from "@keymaster/contracts";
import type { MessageService } from "./messageService.js";

/**
 * plugin-message 内部 service capability key（与 manifest setup 内
 * `ctx.provide("message.service", ...)` 一致）。
 */
const MESSAGE_SERVICE_CAPABILITY = "message.service";

export function MessageDetailPage(): React.ReactElement {
  const i18n = useI18n();
  const params = useParams<{ messageId?: string }>();
  const messageId = typeof params.messageId === "string" ? params.messageId : "";
  const service = useCapabilityOrNull<MessageService>(MESSAGE_SERVICE_CAPABILITY);
  const [msg, setMsg] = useState<AppMsgMessage | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!service || !messageId) {
      setMsg(null);
      return;
    }
    setLoading(true);
    void service
      .getMessage(messageId)
      .then((got) => {
        if (cancelled) return;
        setMsg(got);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setMsg(null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [service, messageId]);

  if (!service) {
    return (
      <section className="km-message-detail km-message-detail--missing" data-message-detail="missing-service">
        <h1 className="km-message-detail__title">{i18n.t("message.page.detail.title")}</h1>
        <p className="km-message-detail__empty">{i18n.t("message.page.noClient")}</p>
        <button
          className="km-message-detail__back"
          type="button"
          onClick={() => router.push("/messages")}
        >
          {i18n.t("message.page.back")}
        </button>
      </section>
    );
  }

  if (!msg) {
    return (
      <section className="km-message-detail" data-message-detail="not-found">
        <h1 className="km-message-detail__title">{i18n.t("message.page.detail.title")}</h1>
        <p className="km-message-detail__empty">
          {loading ? "…" : i18n.t("message.page.detail.empty")}
        </p>
        <button
          className="km-message-detail__back"
          type="button"
          onClick={() => router.push("/messages")}
        >
          {i18n.t("message.page.back")}
        </button>
      </section>
    );
  }

  return (
    <section className="km-message-detail" data-message-detail="ok" data-message-id={msg.messageId}>
      <header className="km-message-detail__header">
        <button
          className="km-message-detail__back"
          type="button"
          onClick={() => router.push("/messages")}
        >
          {i18n.t("message.page.back")}
        </button>
        <h1 className="km-message-detail__title">{i18n.t("message.page.detail.title")}</h1>
      </header>

      <dl className="km-message-detail__meta">
        <div className="km-message-detail__row">
          <dt className="km-message-detail__row-label">
            {i18n.t("message.page.sender.label")}
          </dt>
          <dd className="km-message-detail__row-value">
            <code>{msg.senderPublicKeyHex}</code>
            {msg.senderOrigin ? ` (${msg.senderOrigin})` : ""}
            {msg.senderAppId ? ` (${msg.senderAppId})` : ""}
          </dd>
        </div>
        <div className="km-message-detail__row">
          <dt className="km-message-detail__row-label">
            {i18n.t("message.page.recipient.label")}
          </dt>
          <dd className="km-message-detail__row-value">
            <code>{msg.recipientPublicKeyHex}</code>
            {msg.recipientOrigin ? ` (${msg.recipientOrigin})` : ""}
            {msg.recipientAppId ? ` (${msg.recipientAppId})` : ""}
          </dd>
        </div>
        <div className="km-message-detail__row">
          <dt className="km-message-detail__row-label">
            {i18n.t("message.page.detail.meta.createdAt")}
          </dt>
          <dd className="km-message-detail__row-value">{formatTime(msg.createdAtMs)}</dd>
        </div>
        <div className="km-message-detail__row">
          <dt className="km-message-detail__row-label">
            {i18n.t("message.page.detail.meta.insertedAt")}
          </dt>
          <dd className="km-message-detail__row-value">{formatTime(msg.insertedAtMs)}</dd>
        </div>
        <div className="km-message-detail__row">
          <dt className="km-message-detail__row-label">
            {i18n.t("message.page.detail.meta.messageId")}
          </dt>
          <dd className="km-message-detail__row-value">
            <code>{msg.messageId}</code>
          </dd>
        </div>
        <div className="km-message-detail__row">
          <dt className="km-message-detail__row-label">
            {i18n.t("message.page.detail.meta.clientMessageId")}
          </dt>
          <dd className="km-message-detail__row-value">
            <code>{msg.clientMessageId}</code>
          </dd>
        </div>
      </dl>

      <h2 className="km-message-detail__section-title">
        {i18n.t("message.page.detail.body")}
      </h2>
      <pre className="km-message-detail__body">{msg.body}</pre>
    </section>
  );
}

function useCapabilityOrNull<T>(key: string): T | null {
  try {
    return useCapability<T>(key);
  } catch {
    return null;
  }
}

function formatTime(ms: number): string {
  if (!ms) return "";
  try {
    return new Date(ms).toISOString();
  } catch {
    return String(ms);
  }
}