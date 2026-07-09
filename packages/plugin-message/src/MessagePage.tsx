// packages/plugin-message/src/MessagePage.tsx
// 消息首页：会话列表。
//
// 设计缘由：
//   - 首页只负责按对端 publicKeyHex 聚合会话；
//   - 联系人名称回填来自 contacts.service；
//   - 新增 / 编辑联系人通过 contacts.editor capability 打开，message
//     页面不复制联系人表单；
//   - 会话主入口是 /messages/:publicKeyHex，而不是单条 messageId。

import { useEffect, useMemo, useState, type ComponentType } from "react";
import { useCapability, useI18n, router } from "@keymaster/runtime";
import type { AppMsgMessage, Contact, ContactsService, KeyspaceService } from "@keymaster/contracts";
import { EmptyState, PageHeader } from "@keymaster/ui";
import type { MessageService } from "./messageService.js";
import { buildConversationSummaries, shortPublicKeyHex } from "./messageConversation.js";

interface ContactsEditorProps {
  open: boolean;
  mode: "create" | "edit";
  publicKeyHex?: string;
  contactId?: string;
  onClose: () => void;
  onSaved: (contact: Contact) => void;
}

const MESSAGE_SERVICE_CAPABILITY = "message.service";
const CONTACTS_SERVICE_CAPABILITY = "contacts.service";
const CONTACTS_EDITOR_CAPABILITY = "contacts.editor";

export function MessagePage(): JSX.Element {
  const i18n = useI18n();
  const service = useCapabilityOrNull<MessageService>(MESSAGE_SERVICE_CAPABILITY);
  if (!service) {
    return (
      <section className="km-message-page km-message-page--missing" data-message-page="missing-service">
        <h1 className="km-message-page__title">{i18n.t("message.page.title")}</h1>
        <p className="km-message-page__empty">{i18n.t("message.page.noClient")}</p>
      </section>
    );
  }
  return <MessagePageInner service={service} />;
}

function useCapabilityOrNull<T>(key: string): T | null {
  try {
    return useCapability<T>(key);
  } catch {
    return null;
  }
}

function MessagePageInner({ service }: { service: MessageService }): JSX.Element {
  const i18n = useI18n();
  const keyspace = useCapability<KeyspaceService>("keyspace.service");
  const contacts = useCapabilityOrNull<ContactsService>(CONTACTS_SERVICE_CAPABILITY);
  const ContactsEditor = useCapabilityOrNull<ComponentType<ContactsEditorProps>>(CONTACTS_EDITOR_CAPABILITY);
  const [ownerPublicKeyHex, setOwnerPublicKeyHex] = useState<string | null>(keyspace.active().activePublicKeyHex ?? null);
  const [messages, setMessages] = useState<AppMsgMessage[]>([]);
  const [contactsByHex, setContactsByHex] = useState<Record<string, Contact>>({});
  const [editorState, setEditorState] = useState<{
    open: boolean;
    mode: "create" | "edit";
    publicKeyHex?: string;
    contactId?: string;
  }>({ open: false, mode: "create" });

  useEffect(() => {
    return keyspace.onActiveChange((state) => {
      setOwnerPublicKeyHex(state.activePublicKeyHex ?? null);
    });
  }, [keyspace]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      if (!ownerPublicKeyHex || !service.isReady()) {
        if (!cancelled) setMessages([]);
        return;
      }
      try {
        const items = await service.listMessages({ limit: 500 });
        if (!cancelled) setMessages(items);
      } catch {
        if (!cancelled) setMessages([]);
      }
    };
    void refresh();
    const off = service.subscribeMessages(() => {
      void refresh();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [ownerPublicKeyHex, service]);

  const conversations = useMemo(() => {
    if (!ownerPublicKeyHex) return [];
    return buildConversationSummaries(messages, ownerPublicKeyHex);
  }, [messages, ownerPublicKeyHex]);

  const peerListKey = useMemo(
    () => conversations.map((c) => c.peerPublicKeyHex).join("|"),
    [conversations]
  );

  useEffect(() => {
    let cancelled = false;
    if (!contacts || !peerListKey) {
      setContactsByHex({});
      return;
    }
    const refreshContacts = async () => {
      try {
        const list = await contacts.findByPublicKeyHexes(conversations.map((c) => c.peerPublicKeyHex));
        if (cancelled) return;
        const next: Record<string, Contact> = {};
        for (const c of list) next[c.publicKeyHex] = c;
        setContactsByHex(next);
      } catch {
        if (!cancelled) setContactsByHex({});
      }
    };
    void refreshContacts();
    const off = contacts.onChange(refreshContacts);
    return () => {
      cancelled = true;
      off();
    };
  }, [contacts, conversations, peerListKey]);

  if (!ownerPublicKeyHex) {
    return (
      <section className="km-message-page">
        <PageHeader title={i18n.t("message.page.title")} description={i18n.t("message.page.desc")} />
        <EmptyState
          title={i18n.t("message.page.noOwner.title", { defaultValue: "Pick a key" })}
          description={i18n.t("message.page.noOwner.desc", { defaultValue: "Switch to an active key to view conversations." })}
        />
      </section>
    );
  }

  const openCreateContact = (peerPublicKeyHex: string) => {
    setEditorState({
      open: true,
      mode: "create",
      publicKeyHex: peerPublicKeyHex
    });
  };

  const openEditContact = (contact: Contact) => {
    setEditorState({
      open: true,
      mode: "edit",
      contactId: contact.id,
      publicKeyHex: contact.publicKeyHex
    });
  };

  return (
    <section className="km-message-page" data-message-page="messages">
      <PageHeader
        title={i18n.t("message.page.title")}
        description={i18n.t("message.page.desc", { defaultValue: "Conversation list grouped by peer publicKeyHex." })}
      />

      {conversations.length === 0 ? (
        <EmptyState
          title={i18n.t("message.page.empty", { defaultValue: "No local conversations yet." })}
          description={i18n.t("message.page.empty.desc", { defaultValue: "Send a message from a conversation detail page to start one." })}
        />
      ) : (
        <div className="km-message-page__conversations">
          {conversations.map((conversation) => {
            const contact = contactsByHex[conversation.peerPublicKeyHex];
            const title = contact?.name?.trim()
              ? contact.name
              : shortPublicKeyHex(conversation.peerPublicKeyHex);
            return (
              <article
                key={conversation.peerPublicKeyHex}
                className="km-message-page__conversation"
                data-peer-public-key-hex={conversation.peerPublicKeyHex}
                onClick={() => router.push(`/messages/${encodeURIComponent(conversation.peerPublicKeyHex)}`)}
              >
                <header className="km-message-page__conversation-header">
                  <div className="km-message-page__conversation-title-group">
                    <h2 className="km-message-page__conversation-title">{title}</h2>
                    <code className="km-message-page__conversation-key">{conversation.peerPublicKeyHex}</code>
                  </div>
                  <span className="km-message-page__conversation-time">
                    {formatTime(conversation.latestInsertedAtMs)}
                  </span>
                </header>
                <p className="km-message-page__conversation-preview">
                  {conversation.latestMessage.body}
                </p>
                <footer className="km-message-page__conversation-footer">
                  <span className="km-message-page__conversation-count">
                    {i18n.t("message.page.conversation.count", { defaultValue: "{{count}} messages", count: conversation.messageCount })}
                  </span>
                  {ContactsEditor ? (
                    contact ? (
                      <button
                        type="button"
                        className="km-message-page__conversation-action"
                        onClick={(e) => {
                          e.stopPropagation();
                          openEditContact(contact);
                        }}
                      >
                        {i18n.t("message.page.conversation.editContact", { defaultValue: "Edit contact" })}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="km-message-page__conversation-action"
                        onClick={(e) => {
                          e.stopPropagation();
                          openCreateContact(conversation.peerPublicKeyHex);
                        }}
                      >
                        {i18n.t("message.page.conversation.addContact", { defaultValue: "Add contact" })}
                      </button>
                    )
                  ) : null}
                </footer>
              </article>
            );
          })}
        </div>
      )}

      {ContactsEditor ? (
        <ContactsEditor
          open={editorState.open}
          mode={editorState.mode}
          publicKeyHex={editorState.publicKeyHex}
          contactId={editorState.contactId}
          onClose={() => setEditorState({ open: false, mode: "create" })}
          onSaved={() => {
            setEditorState({ open: false, mode: "create" });
          }}
        />
      ) : null}
    </section>
  );
}

function formatTime(ms: number): string {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}
