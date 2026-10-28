import { useWalletState } from "@keymaster/runtime";
import { useMessageResources } from "./MessageResourceContext.js";
// 会话详情页（纯文本消息，无联系人/在线状态/WebRTC）。

import { useEffect, useMemo, useRef, useState } from "react";
import { useOptionalPluginCapability } from "webloom-framework/react";
import { usePluginI18n, useResourceViewSelector, router } from "@keymaster/runtime";
import { EmptyState, TextArea } from "@keymaster/ui";
import { MESSAGE_SERVICE_CAPABILITY, type PageUiLocation } from "@keymaster/contracts";
import type { MessageService } from "./messageService.js";
import type { MessageDetailData } from "./manifest.js";
import { buildMessageTimeline, type MessageTimelineItem } from "./messageTimeline.js";
import { shortPublicKeyHex } from "./messageConversation.js";

const DEFAULT_VISIBLE_MESSAGE_COUNT = 20;
const MESSAGE_ERROR_KEYS: Record<string, string> = {
  service_not_ready: "message.page.detail.error.service_not_ready",
  invalid_target: "message.page.detail.error.invalid_target",
};

export function MessageDetailPage({ location }: { location: PageUiLocation }): JSX.Element {
  const i18n = usePluginI18n();
  const peerPublicKeyHex = location.params.publicKeyHex ?? "";
  const normalizedPeerPublicKeyHex = normalizePublicKeyHexForMatch(peerPublicKeyHex);
  const messageService = useOptionalPluginCapability(MESSAGE_SERVICE_CAPABILITY);
  const walletState = useWalletState();
  const store = useMessageResources();
  const ownerPublicKeyHex = walletState.snapshot().activePublicKeyHex ?? null;

  const detailData = useResourceViewSelector<MessageDetailData, MessageDetailData>(
    store,
    "message.detail",
    [normalizedPeerPublicKeyHex],
    (snapshot) => snapshot.data ?? { messages: [] },
    (a, b) => a.messages === b.messages
  );
  const messages = detailData.messages;

  const [sendBody, setSendBody] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendBusy, setSendBusy] = useState(false);
  const [visibleCount, setVisibleCount] = useState(DEFAULT_VISIBLE_MESSAGE_COUNT);
  const sendInFlightRef = useRef(false);
  const operationGeneration = useRef(0);
  useEffect(() => {
    operationGeneration.current += 1;
    sendInFlightRef.current = false;
    setSendBody("");
    setSendError(null);
    setSendBusy(false);
    return () => { operationGeneration.current += 1; };
  }, [ownerPublicKeyHex, normalizedPeerPublicKeyHex, messageService]);

  useEffect(() => {
    setVisibleCount(DEFAULT_VISIBLE_MESSAGE_COUNT);
  }, [ownerPublicKeyHex, normalizedPeerPublicKeyHex]);

  const timeline = useMemo(() => {
    if (!ownerPublicKeyHex || !normalizedPeerPublicKeyHex) return [];
    return buildMessageTimeline({
      messages,
      ownerPublicKeyHex,
      peerPublicKeyHex: normalizedPeerPublicKeyHex
    });
  }, [messages, ownerPublicKeyHex, normalizedPeerPublicKeyHex]);

  const visibleItems = useMemo(() => timeline.slice(0, visibleCount), [timeline, visibleCount]);
  const hasMoreItems = timeline.length > visibleItems.length;

  const service = messageService;

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

  if (!ownerPublicKeyHex) {
    return (
      <section className="km-message-detail">
        <h1 className="km-message-detail__title">{i18n.t("message.page.detail.title")}</h1>
        <EmptyState
          title={i18n.t("message.page.noOwner.title")}
          description={i18n.t("message.page.noOwner.desc")}
        />
      </section>
    );
  }

  if (!peerPublicKeyHex) {
    return (
      <section className="km-message-detail">
        <h1 className="km-message-detail__title">{i18n.t("message.page.detail.title")}</h1>
        <EmptyState
          title={i18n.t("message.page.detail.noConversation")}
          description={i18n.t("message.page.back")}
          action={
            <button className="km-message-detail__back" type="button" onClick={() => router.push("/messages")}>
              {i18n.t("message.page.back")}
            </button>
          }
        />
      </section>
    );
  }

  const title = shortPublicKeyHex(peerPublicKeyHex);

  async function sendText() {
    if (sendInFlightRef.current) return;
    setSendError(null);
    const body = sendBody.trim();
    if (!body) {
      setSendError(i18n.t("message.page.send.empty"));
      return;
    }
    const generation = operationGeneration.current;
    sendInFlightRef.current = true;
    setSendBusy(true);
    try {
      await service!.sendTextMessage({ recipientPublicKeyHex: normalizedPeerPublicKeyHex, body });
      if (generation !== operationGeneration.current) return;
      setSendBody("");
      store.invalidate("message.detail", [normalizedPeerPublicKeyHex]);
      store.invalidate("message.conversations", []);
    } catch (err) {
      if (generation !== operationGeneration.current) return;
      setSendError(formatMessageDetailError(i18n, err, "message.page.detail.error.send_unknown"));
    } finally {
      if (generation === operationGeneration.current) {
        sendInFlightRef.current = false;
        setSendBusy(false);
      }
    }
  }

  return (
    <section className="km-message-detail" data-message-detail="ok" data-peer-public-key-hex={normalizedPeerPublicKeyHex}>
      <header className="km-message-detail__header">
        <button className="km-message-detail__back" type="button" onClick={() => router.push("/messages")}>
          {i18n.t("message.page.back")}
        </button>
        <div className="km-message-detail__headline">
          <h1 className="km-message-detail__title">{title}</h1>
          <span className="km-message-detail__key">{peerPublicKeyHex}</span>
        </div>
      </header>

      <section className="km-message-detail__composer">
        <TextArea
          label={i18n.t("message.page.detail.body")}
          value={sendBody}
          onChange={(e) => setSendBody(e.currentTarget.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void sendText();
            }
          }}
        />
        <div className="km-message-detail__composer-actions">
          <button
            className="km-message-detail__send"
            type="button"
            disabled={sendBusy}
            onClick={() => void sendText()}
          >
            {sendBusy ? i18n.t("message.page.send.sending") : i18n.t("message.page.send.submit")}
          </button>
          {sendError ? (
            <span className="km-message-detail__error" role="alert">{sendError}</span>
          ) : null}
        </div>
      </section>

      {timeline.length === 0 ? (
        <EmptyState
          title={i18n.t("message.page.detail.empty")}
          description={i18n.t("message.page.detail.empty.desc")}
        />
      ) : (
        <>
          {hasMoreItems ? (
            <div className="km-message-detail__pager">
              <button
                className="km-message-detail__load-more"
                type="button"
                onClick={() => setVisibleCount((current) => current + DEFAULT_VISIBLE_MESSAGE_COUNT)}
              >
                {i18n.t("message.page.detail.loadMore")}
              </button>
            </div>
          ) : null}
          <ul className="km-message-detail__thread">
            {visibleItems.map((item) => (
              <li key={describeTimelineItem(item)} className="km-message-detail__timeline-item">
                {renderTimelineItem(item, { i18n, ownerPublicKeyHex, title })}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function renderTimelineItem(
  item: MessageTimelineItem,
  handlers: {
    i18n: ReturnType<typeof usePluginI18n>;
    ownerPublicKeyHex: string;
    title: string;
  }
) {
  const fromMe = item.message.senderPublicKeyHex === handlers.ownerPublicKeyHex;
  return (
    <div className={`km-message-detail__bubble ${fromMe ? "is-me" : "is-peer"}`}>
      <div className="km-message-detail__message-meta">
        <span>{fromMe ? handlers.i18n.t("message.page.detail.from.me") : handlers.title}</span>
        <span>{formatTime(item.message.insertedAtMs)}</span>
      </div>
      {item.message.rawMissing ? (
        <p className="km-message-detail__missing">{handlers.i18n.t("message.page.detail.rawMissing")}</p>
      ) : (
        <pre className="km-message-detail__body">{item.message.body}</pre>
      )}
    </div>
  );
}

function describeTimelineItem(item: MessageTimelineItem): string {
  return `text:${item.message.messageId}`;
}

function formatTime(ms: number): string {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

function formatMessageDetailError(i18n: ReturnType<typeof usePluginI18n>, err: unknown, fallbackKey = "message.page.detail.error.unknown"): string {
  if (err instanceof Error) {
    const raw = err.message.trim().toLowerCase();
    const direct = MESSAGE_ERROR_KEYS[raw];
    if (direct) return i18n.t(direct);
    return `${i18n.t(fallbackKey)} (${err.message})`;
  }
  return i18n.t(fallbackKey);
}

function normalizePublicKeyHexForMatch(publicKeyHex: string | null | undefined): string {
  return (publicKeyHex ?? "").trim().toLowerCase();
}
