// packages/plugin-message/src/MessagePage.tsx
// 消息首页：会话列表。
//
// 设计缘由：
//   - 首页只负责按对端 publicKeyHex 聚合会话；
//   - 联系人名称回填来自 contacts.service；
//   - 新增 / 编辑联系人通过 contacts.editor capability 打开，message
//     页面不复制联系人表单；
//   - 会话详情主入口是 /message/:publicKeyHex，/messages/:publicKeyHex 仅作兼容别名；
//
// 硬切换 003：使用 Resource Store 读取消息和联系人数据。
// 跨标签同步、请求去重、失效批处理由 resource 处理。

import { useMemo, useState, type ComponentType } from "react";
import { useCapability, useI18n, usePluginHost, useResourceSelector, router } from "@keymaster/runtime";
import type { Contact, KeyspaceService } from "@keymaster/contracts";
import { Button, EmptyState, Modal, PageHeader, TextInput } from "@keymaster/ui";
import type { MessageService } from "./messageService.js";
import type { MessageConversationsData } from "./manifest.js";
import { buildConversationSummaries, shortPublicKeyHex } from "./messageConversation.js";

interface ContactsEditorProps {
  open: boolean;
  mode: "create" | "edit";
  publicKeyHex?: string;
  contactId?: string;
  onClose: () => void;
  onSaved: (contact: Contact) => void;
}

const CONTACTS_EDITOR_CAPABILITY = "contacts.editor";
const PUBLIC_KEY_HEX_PATTERN = /^[0-9a-f]{66}$/;
const EMPTY_CONVERSATIONS_DATA: MessageConversationsData = { messages: [], contactsByPeer: {} };

export function MessagePage(): JSX.Element {
  const i18n = useI18n();
  const service = useCapabilityOrNull<MessageService>("message.service");
  if (!service) {
    return (
      <section className="km-message-page km-message-page--missing" data-message-page="missing-service">
        <h1 className="km-message-page__title">{i18n.t("message.page.title")}</h1>
        <p className="km-message-page__empty">{i18n.t("message.page.noClient")}</p>
      </section>
    );
  }
  return <MessagePageInner />;
}

function useCapabilityOrNull<T>(key: string): T | null {
  try {
    return useCapability<T>(key);
  } catch {
    return null;
  }
}

function MessagePageInner(): JSX.Element {
  const i18n = useI18n();
  const host = usePluginHost();
  const keyspace = useCapability<KeyspaceService>("keyspace.service");
  const ContactsEditor = useCapabilityOrNull<ComponentType<ContactsEditorProps>>(CONTACTS_EDITOR_CAPABILITY);
  const store = host.resourceStore;
  const ownerPublicKeyHex = keyspace.active().activePublicKeyHex ?? null;

  // 使用 Resource Store 读取消息和联系人数据
  const conversationsData = useResourceSelector<MessageConversationsData, MessageConversationsData>(
    store,
    "message.conversations",
    [],
    (snapshot) => snapshot.data ?? EMPTY_CONVERSATIONS_DATA,
    (a, b) => {
      if (a.messages.length !== b.messages.length) return false;
      if (Object.keys(a.contactsByPeer).length !== Object.keys(b.contactsByPeer).length) return false;
      return true;
    }
  );

  // 从消息派生会话摘要
  const conversations = useMemo(() => {
    if (!ownerPublicKeyHex) return [];
    return buildConversationSummaries(conversationsData.messages, ownerPublicKeyHex);
  }, [conversationsData.messages, ownerPublicKeyHex]);

  // 本地交互 state
  const [editorState, setEditorState] = useState<{
    open: boolean;
    mode: "create" | "edit";
    publicKeyHex?: string;
    contactId?: string;
  }>({ open: false, mode: "create" });
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newChatPublicKeyHex, setNewChatPublicKeyHex] = useState("");
  const [newChatError, setNewChatError] = useState<string | null>(null);

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

  const openNewChatDialog = () => {
    setNewChatError(null);
    setNewChatPublicKeyHex("");
    setNewChatOpen(true);
  };

  const closeNewChatDialog = () => {
    setNewChatOpen(false);
    setNewChatError(null);
    setNewChatPublicKeyHex("");
  };

  const submitNewChat = () => {
    const normalized = normalizePublicKeyHex(newChatPublicKeyHex);
    if (!isValidPublicKeyHex(normalized)) {
      setNewChatError(
        i18n.t("message.page.newChat.error.invalid", {
          defaultValue: "Invalid publicKeyHex. Expected 66 hex characters."
        })
      );
      return;
    }
    closeNewChatDialog();
    router.push(`/message/${encodeURIComponent(normalized)}`);
  };

  return (
    <section className="km-message-page" data-message-page="messages">
      <PageHeader
        title={i18n.t("message.page.title")}
        description={i18n.t("message.page.desc", { defaultValue: "Conversation list grouped by peer publicKeyHex." })}
        actions={
          <Button
            variant="ghost"
            size="sm"
            className="km-message-page__new-chat"
            aria-label={i18n.t("message.page.newChat.open", { defaultValue: "Start a new chat" })}
            title={i18n.t("message.page.newChat.open", { defaultValue: "Start a new chat" })}
            onClick={openNewChatDialog}
          >
            +
          </Button>
        }
      />

      {conversations.length === 0 ? (
        <EmptyState
          title={i18n.t("message.page.empty", { defaultValue: "No local conversations yet." })}
          description={i18n.t("message.page.empty.desc", { defaultValue: "Send a message from a conversation detail page to start one." })}
        />
      ) : (
        <div className="km-message-page__conversations">
          {conversations.map((conversation) => {
            const contact = conversationsData.contactsByPeer[conversation.peerPublicKeyHex];
            const contactName = contact?.name?.trim() ?? "";
            const title = contactName || shortPublicKeyHex(conversation.peerPublicKeyHex);
            return (
              <article
                key={conversation.peerPublicKeyHex}
                className="km-message-page__conversation"
                data-peer-public-key-hex={conversation.peerPublicKeyHex}
                onClick={() => router.push(`/message/${encodeURIComponent(conversation.peerPublicKeyHex)}`)}
              >
                <header className="km-message-page__conversation-header">
                  <div className="km-message-page__conversation-title-group">
                    <h2 className="km-message-page__conversation-title">{title}</h2>
                    {contactName ? (
                      <code className="km-message-page__conversation-key">
                        {shortPublicKeyHex(conversation.peerPublicKeyHex)}
                      </code>
                    ) : null}
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

      <Modal
        open={newChatOpen}
        title={i18n.t("message.page.newChat.title", { defaultValue: "Start a new chat" })}
        onClose={closeNewChatDialog}
        footer={
          <>
            <Button variant="ghost" onClick={closeNewChatDialog}>
              {i18n.t("message.page.newChat.cancel", { defaultValue: "Cancel" })}
            </Button>
            <Button onClick={() => void submitNewChat()}>
              {i18n.t("message.page.newChat.submit", { defaultValue: "Go to chat" })}
            </Button>
          </>
        }
      >
        <TextInput
          label={i18n.t("message.page.newChat.label", { defaultValue: "publicKeyHex" })}
          value={newChatPublicKeyHex}
          onChange={(e) => {
            setNewChatPublicKeyHex(e.currentTarget.value);
            if (newChatError) setNewChatError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submitNewChat();
            }
          }}
          placeholder={i18n.t("message.page.newChat.placeholder", { defaultValue: "66 hex characters" })}
          error={newChatError ?? undefined}
          autoFocus
        />
      </Modal>
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

/**
 * 把用户输入规整成可校验的 publicKeyHex。
 *
 * 设计缘由：
 *   - 这里不做复杂容错，只允许去掉首尾空白并统一小写；
 *   - 用户输入一旦不是 66 位 hex，就直接报错，不做隐式修复；
 *   - 这样弹窗提交逻辑简单，失败时用户能明确看到输入问题。
 */
function normalizePublicKeyHex(input: string): string {
  return input.trim().toLowerCase();
}

/**
 * 校验压缩公钥 hex 是否可用于直接跳转到会话页。
 *
 * 设计缘由：
 *   - 只接受 66 位 hex，避免把明显错误输入推到路由层后再失败；
 *   - 错误必须在本地表单内拦住，避免列表页跳转到无意义的空页面。
 */
function isValidPublicKeyHex(publicKeyHex: string): boolean {
  return PUBLIC_KEY_HEX_PATTERN.test(publicKeyHex);
}
