// packages/plugin-message/src/MessagePage.tsx
// 消息业务页（施工单 2026-07-04 001 硬切换）。
//
// 设计缘由：
//   - 本页**只**展示 `keymaster.message` scope 内的消息业务：
//       * 发送区（输入 publicKeyHex + 正文 → sendMessage）
//       * 搜索区（按本地已同步消息正文过滤）
//       * 列表区（点击进入单条详情）
//   - **不**展示 HubMsg 连接态、target sync 状态、在线查询按钮、全局错误
//     信息、全局统计——这些归 `plugin-appmsg` 的 `/system/appmsg` 管理页；
//   - **不**通过 props / 全局兜底路径注入；直接通过 `useCapability`
//     从平台 runtime 拿 stable message service（由 plugin-message.setup
//     provide）。
//   - **不**订阅 `subscriptionSource()` 这种"subscription token"——
//     endpoint service 内部自动迁移订阅；本组件在 `useEffect` 里**只**
//     调一次 `service.subscribeMessages(...)`，不依赖任何"client 引用
//     变化"信号。
//   - owner / provider 切换对 React 组件**完全透明**——上层 effect 不
//     需要 cleanup 旧订阅、绑定新订阅；endpoint service 自己处理。

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useCapability, useI18n, router } from "@keymaster/runtime";
import type { AppMsgMessage } from "@keymaster/contracts";
import type { MessageService } from "./messageService.js";

/**
 * plugin-message 内部 service capability key（与 manifest setup 内
 * `ctx.provide("message.service", ...)` 一致）。
 */
const MESSAGE_SERVICE_CAPABILITY = "message.service";

/**
 * 消息业务页。
 *
 * 接入方式（**唯一**允许的来源）：
 *   - 通过 `useCapability<MessageService>(MESSAGE_SERVICE_CAPABILITY)`
 *     从 capability bus 拿 plugin-message 自己 provide 的 service；
 *   - 没有 service 时（capability 缺失）显示降级空态；
 *   - **不**走任何 window 全局兜底：plugin-message 的"业务页 = 走正式
 *     注入路径"这条边界不允许偷偷绕开 capability bus；
 *   - 组件 mount 时 plugin-message 必须 enabled；disable 时 route 已被
 *     注销，本组件不会被路由。
 */
export function MessagePage(): React.ReactElement {
  const i18n = useI18n();
  const service = useCapabilityOrNull<MessageService>(MESSAGE_SERVICE_CAPABILITY);

  if (!service) {
    return (
      <section
        className="km-message-page km-message-page--missing"
        data-message-page="missing-service"
      >
        <h1 className="km-message-page__title">{i18n.t("message.page.title")}</h1>
        <p className="km-message-page__empty">{i18n.t("message.page.noClient")}</p>
      </section>
    );
  }

  return <MessagePageInner service={service} />;
}

/**
 * 兼容版 `useCapability`：capability 不存在时返回 null（**不**抛错）。
 *
 * 设计缘由：plugin-message 的 route 在 plugin enable 后才被注册；本组件
 * 一旦被路由命中，capability bus 上就一定有 `message.service`。但极端
 * host（如未通过 host 渲染）下 capability 可能没注册——这里仅做防御
 * 性兼容，**不**作为生产主路径，也**不**引入任何 window 兜底。
 */
function useCapabilityOrNull<T>(key: string): T | null {
  try {
    return useCapability<T>(key);
  } catch {
    return null;
  }
}

/**
 * 内部分离式组件：业务渲染。
 */
function MessagePageInner({ service }: { service: MessageService }): React.ReactElement {
  const i18n = useI18n();
  const [messages, setMessages] = useState<AppMsgMessage[]>([]);
  const [searchInput, setSearchInput] = useState("");
  const [recipient, setRecipient] = useState("");
  const [body, setBody] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const items = await service.listMessages({ limit: 200 });
    setMessages(items);
  }, [service]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 实时订阅：endpoint service 内部自动处理 owner / provider 切换的
  // 订阅迁移。本 effect **只**依赖 `service` 引用本身——业务层**不**
  // 关心 client 引用变化。
  useEffect(() => {
    const off = service.subscribeMessages(() => {
      void refresh();
    });
    return () => {
      off();
    };
  }, [service, refresh]);

  // 过滤（UI 本地行为）
  const filtered = useMemo(() => {
    const q = searchInput.trim().toLowerCase();
    if (!q) return messages;
    return messages.filter((m) => (m.body ?? "").toLowerCase().includes(q));
  }, [messages, searchInput]);

  const onSend = useCallback(async () => {
    setSendError(null);
    const hex = recipient.trim();
    if (!/^[0-9a-f]{66}$/i.test(hex)) {
      setSendError("invalid recipient publicKeyHex");
      return;
    }
    if (!body.trim()) {
      setSendError("body is empty");
      return;
    }
    try {
      await service.sendTextMessage({ recipientPublicKeyHex: hex, body: body.trim() });
      setBody("");
      void refresh();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    }
  }, [body, recipient, refresh, service]);

  return (
    <section className="km-message-page" data-message-page="messages">
      <h1 className="km-message-page__title">{i18n.t("message.page.title")}</h1>

      <div className="km-message-page__send">
        <h2 className="km-message-page__section-title">
          {i18n.t("message.page.send.label")}
        </h2>
        <label className="km-message-page__field">
          <span className="km-message-page__field-label">
            {i18n.t("message.page.send.recipient")}
          </span>
          <input
            className="km-message-page__input"
            type="text"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="02... (66 hex chars)"
          />
        </label>
        <label className="km-message-page__field">
          <span className="km-message-page__field-label">
            {i18n.t("message.page.send.body")}
          </span>
          <textarea
            className="km-message-page__textarea"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
          />
        </label>
        <div className="km-message-page__send-row">
          <button
            className="km-message-page__send-button"
            type="button"
            onClick={() => {
              void onSend();
            }}
          >
            {i18n.t("message.page.send.submit")}
          </button>
          {sendError ? (
            <span className="km-message-page__send-error">{sendError}</span>
          ) : null}
        </div>
      </div>

      <div className="km-message-page__search">
        <h2 className="km-message-page__section-title">
          {i18n.t("message.page.search.label")}
        </h2>
        <input
          className="km-message-page__input"
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={i18n.t("message.page.search.placeholder")}
        />
      </div>

      <div className="km-message-page__list">
        <h2 className="km-message-page__section-title">
          {i18n.t("message.page.list.label")}
        </h2>
        {filtered.length === 0 ? (
          <p className="km-message-page__empty">{i18n.t("message.page.empty")}</p>
        ) : (
          <ul className="km-message-page__list-items">
            {filtered.map((m) => (
              <li
                key={m.messageId}
                className="km-message-page__list-item"
                data-message-id={m.messageId}
                onClick={() => router.push(`/messages/${encodeURIComponent(m.messageId)}`)}
              >
                <div className="km-message-page__list-meta">
                  <span className="km-message-page__list-meta-label">
                    {i18n.t("message.page.sender.label")}
                  </span>{" "}
                  <code>{shortHex(m.senderPublicKeyHex)}</code>
                  {m.senderOrigin ? ` (${m.senderOrigin})` : ""}
                  {m.senderAppId ? ` (${m.senderAppId})` : ""}
                  {" → "}
                  <span className="km-message-page__list-meta-label">
                    {i18n.t("message.page.recipient.label")}
                  </span>{" "}
                  <code>{shortHex(m.recipientPublicKeyHex)}</code>
                  {m.recipientOrigin ? ` (${m.recipientOrigin})` : ""}
                  {m.recipientAppId ? ` (${m.recipientAppId})` : ""}
                </div>
                <div className="km-message-page__list-body">{m.body}</div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function shortHex(h: string): string {
  if (h.length <= 12) return h;
  return `${h.slice(0, 8)}…`;
}