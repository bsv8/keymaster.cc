// packages/plugin-message/src/MessageDetailPage.tsx
// 会话详情页。
//
// 设计缘由：
//   - 路由参数是对端 publicKeyHex，不再是单条 messageId；
//   - 页面展示这个对端的全部会话记录，按入库时间正序；
//   - 发送入口收口到详情页；
//   - 联系人名称优先来自 contacts.service，缺失时回退短公钥。

import { useEffect, useMemo, useState } from "react";
import { useCapability, useI18n, router } from "@keymaster/runtime";
import { EmptyState, TextArea } from "@keymaster/ui";
import { useParams } from "react-router";
import type { AppMsgMessage, Contact, ContactsService, KeyspaceService } from "@keymaster/contracts";
import type { MessageService } from "./messageService.js";
import { listConversationMessages, shortPublicKeyHex } from "./messageConversation.js";
const MESSAGE_SERVICE_CAPABILITY = "message.service";
const CONTACTS_SERVICE_CAPABILITY = "contacts.service";

export function MessageDetailPage(): JSX.Element {
  const i18n = useI18n();
  const params = useParams<{ publicKeyHex?: string }>();
  const peerPublicKeyHex = typeof params.publicKeyHex === "string" ? decodeURIComponent(params.publicKeyHex) : "";
  const service = useCapabilityOrNull<MessageService>(MESSAGE_SERVICE_CAPABILITY);
  const keyspace = useCapability<KeyspaceService>("keyspace.service");
  const contacts = useCapabilityOrNull<ContactsService>(CONTACTS_SERVICE_CAPABILITY);
  const [ownerPublicKeyHex, setOwnerPublicKeyHex] = useState<string | null>(keyspace.active().activePublicKeyHex ?? null);
  const [messages, setMessages] = useState<AppMsgMessage[]>([]);
  const [contact, setContact] = useState<Contact | null>(null);
  const [sendBody, setSendBody] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    return keyspace.onActiveChange((state) => {
      setOwnerPublicKeyHex(state.activePublicKeyHex ?? null);
    });
  }, [keyspace]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      if (!service || !ownerPublicKeyHex || !peerPublicKeyHex || !service.isReady()) {
        if (!cancelled) setMessages([]);
        return;
      }
      try {
        const items = await service.listMessages({ limit: 500 });
        if (cancelled) return;
        setMessages(items);
      } catch {
        if (!cancelled) setMessages([]);
      }
    };
    void refresh();
    if (!service) return;
    const off = service.subscribeMessages(() => {
      void refresh();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [ownerPublicKeyHex, peerPublicKeyHex, service]);

  useEffect(() => {
    let cancelled = false;
    if (!contacts || !peerPublicKeyHex) {
      setContact(null);
      return;
    }
    const refresh = async () => {
      try {
        const found = await contacts.findByPublicKeyHex(peerPublicKeyHex);
        if (!cancelled) setContact(found ?? null);
      } catch {
        if (!cancelled) setContact(null);
      }
    };
    void refresh();
    const off = contacts.onChange(refresh);
    return () => {
      cancelled = true;
      off();
    };
  }, [contacts, peerPublicKeyHex]);

  const conversationMessages = useMemo(() => {
    if (!ownerPublicKeyHex || !peerPublicKeyHex) return [];
    return listConversationMessages(messages, ownerPublicKeyHex, peerPublicKeyHex);
  }, [messages, ownerPublicKeyHex, peerPublicKeyHex]);

  if (!service) {
    return (
      <section className="km-message-detail km-message-detail--missing" data-message-detail="missing-service">
        <h1 className="km-message-detail__title">{i18n.t("message.page.detail.title")}</h1>
        <p className="km-message-detail__empty">{i18n.t("message.page.noClient")}</p>
        <button className="km-message-detail__back" type="button" onClick={() => router.push("/messages")}>
          {i18n.t("message.page.back")}
        </button>
      </section>
    );
  }
  const messageService = service;

  if (!ownerPublicKeyHex) {
    return (
      <section className="km-message-detail">
        <h1 className="km-message-detail__title">{i18n.t("message.page.detail.title")}</h1>
        <EmptyState
          title={i18n.t("message.page.noOwner.title", { defaultValue: "Pick a key" })}
          description={i18n.t("message.page.noOwner.desc", { defaultValue: "Switch to an active key to view this conversation." })}
        />
      </section>
    );
  }

  if (!peerPublicKeyHex) {
    return (
      <section className="km-message-detail">
        <h1 className="km-message-detail__title">{i18n.t("message.page.detail.title")}</h1>
        <EmptyState
          title={i18n.t("message.page.detail.empty", { defaultValue: "Conversation not found." })}
          description={i18n.t("message.page.back", { defaultValue: "Back" })}
          action={
            <button className="km-message-detail__back" type="button" onClick={() => router.push("/messages")}>
              {i18n.t("message.page.back")}
            </button>
          }
        />
      </section>
    );
  }

  const title = contact?.name?.trim() ? contact.name : shortPublicKeyHex(peerPublicKeyHex);

  async function send() {
    setSendError(null);
    const body = sendBody.trim();
    if (!body) {
      setSendError(i18n.t("message.page.send.empty", { defaultValue: "Body is empty" }));
      return;
    }
    try {
      await messageService.sendTextMessage({ recipientPublicKeyHex: peerPublicKeyHex, body });
      setSendBody("");
      const items = await messageService.listMessages({ limit: 500 });
      setMessages(items);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="km-message-detail" data-message-detail="ok" data-peer-public-key-hex={peerPublicKeyHex}>
      <header className="km-message-detail__header">
        <button className="km-message-detail__back" type="button" onClick={() => router.push("/messages")}>
          {i18n.t("message.page.back")}
        </button>
        <div className="km-message-detail__headline">
          <h1 className="km-message-detail__title">{title}</h1>
          <code className="km-message-detail__key">{peerPublicKeyHex}</code>
        </div>
      </header>

      <section className="km-message-detail__composer">
        <TextArea
          label={i18n.t("message.page.detail.body")}
          value={sendBody}
          onChange={(e) => setSendBody(e.currentTarget.value)}
          rows={4}
        />
        <div className="km-message-detail__composer-row">
          <button className="km-message-detail__send" type="button" onClick={() => void send()}>
            {i18n.t("message.page.send.submit")}
          </button>
          {sendError ? <span className="km-message-detail__error">{sendError}</span> : null}
        </div>
      </section>

      {conversationMessages.length === 0 ? (
        <EmptyState
          title={i18n.t("message.page.detail.empty", { defaultValue: "No messages in this conversation." })}
          description={i18n.t("message.page.detail.empty.desc", { defaultValue: "Send a message below to start the thread." })}
        />
      ) : (
        <ul className="km-message-detail__thread">
          {conversationMessages.map((message) => {
            const fromMe = message.senderPublicKeyHex === ownerPublicKeyHex;
            return (
              <li key={message.messageId} className={`km-message-detail__message ${fromMe ? "is-me" : "is-peer"}`}>
                <div className="km-message-detail__bubble">
                  <div className="km-message-detail__message-meta">
                    <span>{fromMe ? i18n.t("message.page.detail.from.me", { defaultValue: "Me" }) : title}</span>
                    <span>{formatTime(message.insertedAtMs)}</span>
                  </div>
                  <pre className="km-message-detail__body">{message.body}</pre>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="km-message-detail__full-key">
        <strong>publicKeyHex: </strong>
        <code>{peerPublicKeyHex}</code>
      </p>
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
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}
