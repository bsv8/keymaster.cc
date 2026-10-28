import { useWalletState } from "@keymaster/runtime";
import { useMessageResources } from "./MessageResourceContext.js";
// packages/plugin-message/src/MessagePage.tsx
// 消息首页：会话列表，按对端 publicKeyHex 聚合展示。

import { useEffect, useMemo, useState } from "react";
import { useOptionalPluginCapability } from "webloom-framework/react";
import { usePluginI18n, useResourceViewSelector, router } from "@keymaster/runtime";
import { VAULT_WALLET_STATE_CAPABILITY, MESSAGE_SERVICE_CAPABILITY } from "@keymaster/contracts";
import { Button, EmptyState, Modal, PageHeader, TextInput } from "@keymaster/ui";
import type { MessageService } from "./messageService.js";
import type { MessageConversationsData } from "./manifest.js";
import { buildConversationSummaries, shortPublicKeyHex } from "./messageConversation.js";

const PUBLIC_KEY_HEX_PATTERN = /^[0-9a-f]{66}$/;
const EMPTY_CONVERSATIONS_DATA: MessageConversationsData = { messages: [] };

export function MessagePage(): JSX.Element {
  const i18n = usePluginI18n();
  const service = useOptionalPluginCapability(MESSAGE_SERVICE_CAPABILITY);
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

function MessagePageInner(): JSX.Element {
  const i18n = usePluginI18n();
  const store = useMessageResources();
  const walletState = useWalletState();
  const ownerPublicKeyHex = walletState.snapshot().activePublicKeyHex ?? null;

  const conversationsData = useResourceViewSelector<MessageConversationsData, MessageConversationsData>(
    store,
    "message.conversations",
    [],
    (snapshot) => snapshot.data ?? EMPTY_CONVERSATIONS_DATA
  );

  useEffect(() => {
    if (!ownerPublicKeyHex) return;
    const snapshot = store.read<MessageConversationsData>("message.conversations", []);
    if (!snapshot || snapshot.status === "pending") return;
    store.invalidate("message.conversations", []);
  }, [ownerPublicKeyHex, store]);

  const conversations = useMemo(() => {
    if (!ownerPublicKeyHex) return [];
    return buildConversationSummaries(conversationsData.messages, ownerPublicKeyHex);
  }, [conversationsData.messages, ownerPublicKeyHex]);

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
            const title = shortPublicKeyHex(conversation.peerPublicKeyHex);
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
                </footer>
              </article>
            );
          })}
        </div>
      )}

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

function normalizePublicKeyHex(input: string): string {
  return input.trim().toLowerCase();
}

function isValidPublicKeyHex(publicKeyHex: string): boolean {
  return PUBLIC_KEY_HEX_PATTERN.test(publicKeyHex);
}
