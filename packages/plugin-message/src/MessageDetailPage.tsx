// 会话详情页。
//
// 设计缘由：
//   - 路由参数是对端 publicKeyHex；
//   - 文本消息与 WebRTC 历史分开存储、合并展示；
//   - 发送动作保留文本输入，并在发送按钮后挂载 WebRTC 动作区；
//   - 在线状态每 3 秒探测一次，离开页面立即停止。

import { useEffect, useMemo, useRef, useState } from "react";
import { useCapability, useCurrentPath, useI18n, router } from "@keymaster/runtime";
import { EmptyState, TextArea } from "@keymaster/ui";
import type { AppMsgMessage, Contact, ContactsService, KeyspaceService } from "@keymaster/contracts";
import type { MessageService } from "./messageService.js";
import { buildMessageTimeline, type MessageTimelineItem } from "./messageTimeline.js";
import { shortPublicKeyHex } from "./messageConversation.js";
import type { WebrtcHistoryItem, WebrtcService } from "@keymaster/plugin-webrtc";

const MESSAGE_SERVICE_CAPABILITY = "message.service";
const CONTACTS_SERVICE_CAPABILITY = "contacts.service";
const WEBRTC_SERVICE_CAPABILITY = "webrtc.service";
const MESSAGE_READ_WINDOW = 10_000;
const DEFAULT_VISIBLE_MESSAGE_COUNT = 20;
const MESSAGE_ERROR_KEYS: Record<string, string> = {
  service_not_ready: "message.page.detail.error.service_not_ready",
  invalid_target: "message.page.detail.error.invalid_target",
  target_offline: "message.page.detail.error.target_offline",
  target_unknown: "message.page.detail.error.target_unknown",
  device_unavailable: "message.page.detail.error.device_unavailable",
  send_invite_failed: "message.page.detail.error.send_invite_failed",
  create_offer_failed: "message.page.detail.error.create_offer_failed",
  invalid_state: "message.page.detail.error.invalid_state",
  transfer_too_large: "message.page.detail.error.transfer_too_large",
  busy_local: "message.page.detail.error.busy_local",
  transfer_protocol_unavailable: "message.page.detail.error.transfer_protocol_unavailable",
  transfer_timeout: "message.page.detail.error.transfer_timeout",
  transfer_connection_failed: "message.page.detail.error.transfer_connection_failed",
  transfer_invite_failed: "message.page.detail.error.transfer_invite_failed",
  local_blob_unavailable: "message.page.detail.error.local_blob_unavailable",
  "local blob unavailable": "message.page.detail.error.local_blob_unavailable"
};
const CALL_STATUS_KEYS: Record<string, string> = {
  completed: "message.page.detail.timeline.call.status.completed",
  missed: "message.page.detail.timeline.call.status.missed",
  rejected: "message.page.detail.timeline.call.status.rejected",
  failed: "message.page.detail.timeline.call.status.failed"
};

export function MessageDetailPage(): JSX.Element {
  const i18n = useI18n();
  const currentPath = useCurrentPath();
  const peerPublicKeyHex = parsePeerPublicKeyHexFromPath(currentPath);
  const messageService = useCapabilityOrNull<MessageService>(MESSAGE_SERVICE_CAPABILITY);
  const keyspace = useCapability<KeyspaceService>("keyspace.service");
  const contacts = useCapabilityOrNull<ContactsService>(CONTACTS_SERVICE_CAPABILITY);
  const webrtc = useCapabilityOrNull<WebrtcService>(WEBRTC_SERVICE_CAPABILITY);
  const [ownerPublicKeyHex, setOwnerPublicKeyHex] = useState<string | null>(keyspace.active().activePublicKeyHex ?? null);
  const [messages, setMessages] = useState<AppMsgMessage[]>([]);
  const [history, setHistory] = useState<WebrtcHistoryItem[]>([]);
  const [contact, setContact] = useState<Contact | null>(null);
  const [sendBody, setSendBody] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(DEFAULT_VISIBLE_MESSAGE_COUNT);
  const [onlineStatus, setOnlineStatus] = useState<"online" | "offline" | "unknown">("unknown");
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const service = messageService;

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
        const items = await service.listMessages({ limit: MESSAGE_READ_WINDOW });
        if (!cancelled) setMessages(items);
      } catch {
        if (!cancelled) setMessages([]);
      }
    };
    void refresh();
    const off = service?.subscribeMessages(() => {
      void refresh();
    }) ?? (() => undefined);
    return () => {
      cancelled = true;
      off();
    };
  }, [service, ownerPublicKeyHex, peerPublicKeyHex]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      if (!webrtc || !ownerPublicKeyHex || !peerPublicKeyHex) {
        if (!cancelled) setHistory([]);
        return;
      }
      try {
        const items = await webrtc.listHistoryForPeer(peerPublicKeyHex);
        if (!cancelled) setHistory(items);
      } catch {
        if (!cancelled) setHistory([]);
      }
    };
    void refresh();
    const off = webrtc?.subscribe(() => {
      void refresh();
    }) ?? (() => undefined);
    return () => {
      cancelled = true;
      off();
    };
  }, [ownerPublicKeyHex, peerPublicKeyHex, webrtc]);

  useEffect(() => {
    let cancelled = false;
    if (!webrtc || !peerPublicKeyHex) {
      setOnlineStatus("unknown");
      return;
    }
    const refresh = async () => {
      const status = await webrtc.checkPeerOnline(peerPublicKeyHex);
      if (!cancelled) setOnlineStatus(status);
    };
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [peerPublicKeyHex, webrtc]);

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

  useEffect(() => {
    setVisibleCount(DEFAULT_VISIBLE_MESSAGE_COUNT);
  }, [ownerPublicKeyHex, peerPublicKeyHex]);

  const timeline = useMemo(() => {
    if (!ownerPublicKeyHex || !peerPublicKeyHex) return [];
    return buildMessageTimeline({
      messages,
      history,
      ownerPublicKeyHex,
      peerPublicKeyHex
    });
  }, [history, messages, ownerPublicKeyHex, peerPublicKeyHex]);

  const visibleItems = useMemo(() => timeline.slice(0, visibleCount), [timeline, visibleCount]);
  const hasMoreItems = timeline.length > visibleItems.length;

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

  const title = contact?.name?.trim() ? contact.name : shortPublicKeyHex(peerPublicKeyHex);
  const actionsDisabled = onlineStatus !== "online";

  async function sendText() {
    setSendError(null);
    const body = sendBody.trim();
    if (!body) {
      setSendError(i18n.t("message.page.send.empty"));
      return;
    }
    try {
      await service!.sendTextMessage({ recipientPublicKeyHex: peerPublicKeyHex, body });
      setSendBody("");
      const items = await service!.listMessages({ limit: MESSAGE_READ_WINDOW });
      setMessages(items);
    } catch (err) {
      setSendError(formatMessageDetailError(i18n, err));
    }
  }

  async function startCall(mode: "audio" | "video") {
    if (!webrtc) return;
    if (actionsDisabled) {
      setSendError(i18n.t("message.page.detail.offline"));
      return;
    }
    try {
      await webrtc.startCall({ targetPublicKeyHex: peerPublicKeyHex, mode });
    } catch (err) {
      setSendError(formatMessageDetailError(i18n, err));
    }
  }

  async function sendAttachment(kind: "image" | "file", file: File) {
    if (!webrtc) return;
    if (actionsDisabled) {
      setSendError(i18n.t("message.page.detail.offline"));
      return;
    }
    try {
      if (kind === "image") {
        await webrtc.sendImage({ targetPublicKeyHex: peerPublicKeyHex, file });
      } else {
        await webrtc.sendFile({ targetPublicKeyHex: peerPublicKeyHex, file });
      }
      const items = await webrtc.listHistoryForPeer(peerPublicKeyHex);
      setHistory(items);
    } catch (err) {
      setSendError(formatMessageDetailError(i18n, err));
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
          <span className="km-message-detail__key">
            {shortPublicKeyHex(peerPublicKeyHex)}
          </span>
            <span className="km-message-detail__status" data-online-status={onlineStatus}>
            {onlineStatus === "online"
              ? i18n.t("message.page.detail.online")
              : onlineStatus === "offline"
                ? i18n.t("message.page.detail.offline")
                : i18n.t("message.page.detail.unknown")}
          </span>
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
          <button className="km-message-detail__send" type="button" onClick={() => void sendText()}>
            {i18n.t("message.page.send.submit")}
          </button>
          <span className="km-message-detail__divider" aria-hidden="true">|</span>
          <button
            className="km-message-detail__action"
            type="button"
            disabled={actionsDisabled}
            onClick={() => void startCall("video")}
          >
            {i18n.t("message.page.detail.video")}
          </button>
          <button
            className="km-message-detail__action"
            type="button"
            disabled={actionsDisabled}
            onClick={() => void startCall("audio")}
          >
            {i18n.t("message.page.detail.audio")}
          </button>
          <button
            className="km-message-detail__action"
            type="button"
            disabled={actionsDisabled}
            onClick={() => imageInputRef.current?.click()}
          >
            {i18n.t("message.page.detail.image")}
          </button>
          <button
            className="km-message-detail__action"
            type="button"
            disabled={actionsDisabled}
            onClick={() => fileInputRef.current?.click()}
          >
            {i18n.t("message.page.detail.file")}
          </button>
          {sendError ? <span className="km-message-detail__error">{sendError}</span> : null}
        </div>
        <input
          ref={imageInputRef}
          className="km-message-detail__hidden-input"
          type="file"
          accept="image/*"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (file) {
              void sendAttachment("image", file);
            }
          }}
        />
        <input
          ref={fileInputRef}
          className="km-message-detail__hidden-input"
          type="file"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (file) {
              void sendAttachment("file", file);
            }
          }}
        />
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
                onClick={() => {
                  setVisibleCount((current) => current + DEFAULT_VISIBLE_MESSAGE_COUNT);
                }}
              >
                {i18n.t("message.page.detail.loadMore")}
              </button>
            </div>
          ) : null}
          <ul className="km-message-detail__thread">
            {visibleItems.map((item) => (
                <li key={describeTimelineItem(item)} className="km-message-detail__timeline-item">
                {renderTimelineItem(item, {
                  i18n,
                  ownerPublicKeyHex,
                  peerPublicKeyHex,
                  title,
                  loadBlob: async (blobKey) => {
                    if (!webrtc) return null;
                    return webrtc.getTransferBlob(blobKey);
                  },
                  onPreview: async (blobKey) => {
                    if (!webrtc) return;
                    try {
                      const blob = await webrtc.getTransferBlob(blobKey);
                      if (!blob) throw new Error("local blob unavailable");
                      const url = URL.createObjectURL(blob);
                      window.open(url, "_blank", "noopener,noreferrer");
                      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
                    } catch (err) {
                      setSendError(formatMessageDetailError(i18n, err));
                    }
                  },
                  onDownload: async (blobKey, fileName) => {
                    if (!webrtc) return;
                    try {
                      const blob = await webrtc.getTransferBlob(blobKey);
                      if (!blob) throw new Error("local blob unavailable");
                      const url = URL.createObjectURL(blob);
                      const link = document.createElement("a");
                      link.href = url;
                      link.download = fileName ?? "download";
                      link.click();
                      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
                    } catch (err) {
                      setSendError(formatMessageDetailError(i18n, err));
                    }
                  }
                })}
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
    i18n: ReturnType<typeof useI18n>;
    ownerPublicKeyHex: string;
    peerPublicKeyHex: string;
    title: string;
    loadBlob(blobKey: string): Promise<Blob | null>;
    onPreview(blobKey: string): Promise<void>;
    onDownload(blobKey: string, fileName?: string): Promise<void>;
  }
) {
  switch (item.kind) {
    case "text_message": {
      const fromMe = item.message.senderPublicKeyHex === handlers.ownerPublicKeyHex;
      return (
        <div className={`km-message-detail__bubble ${fromMe ? "is-me" : "is-peer"}`}>
          <div className="km-message-detail__message-meta">
            <span>{fromMe ? handlers.i18n.t("message.page.detail.from.me") : handlers.title}</span>
            <span>{formatTime(item.message.insertedAtMs)}</span>
          </div>
          <pre className="km-message-detail__body">{item.message.body}</pre>
        </div>
      );
    }
    case "webrtc_call_record": {
      const record = item.record;
      return (
        <div className="km-message-detail__system">
          <div className="km-message-detail__message-meta">
            <span>
              {record.kind === "audio_call"
                ? handlers.i18n.t("message.page.detail.timeline.call.audio")
                : handlers.i18n.t("message.page.detail.timeline.call.video")}
            </span>
            <span>{formatTime(record.endedAtMs ?? record.startedAtMs)}</span>
          </div>
          <div className="km-message-detail__system-line">
            {record.direction === "outgoing"
              ? handlers.i18n.t("message.page.detail.timeline.call.outgoing")
              : handlers.i18n.t("message.page.detail.timeline.call.incoming")}{" "}
            {formatCallStatus(handlers.i18n, record.status)} {handlers.i18n.t("message.page.detail.timeline.call.label")}
          </div>
        </div>
      );
    }
    case "webrtc_image_record": {
      const record = item.record;
      return (
        <AttachmentRecord
          kind="image"
          fromMe={record.direction === "outgoing"}
          i18n={handlers.i18n}
          record={record}
          loadBlob={handlers.loadBlob}
          onPreview={handlers.onPreview}
          onDownload={handlers.onDownload}
        />
      );
    }
    case "webrtc_file_record": {
      const record = item.record;
      return (
        <AttachmentRecord
          kind="file"
          fromMe={record.direction === "outgoing"}
          i18n={handlers.i18n}
          record={record}
          loadBlob={handlers.loadBlob}
          onPreview={handlers.onPreview}
          onDownload={handlers.onDownload}
        />
      );
    }
  }
}

function AttachmentRecord(props: {
  kind: "image" | "file";
  fromMe: boolean;
  i18n: ReturnType<typeof useI18n>;
  record: Extract<WebrtcHistoryItem, { itemType: "transfer" }>;
  loadBlob(blobKey: string): Promise<Blob | null>;
  onPreview(blobKey: string): Promise<void>;
  onDownload(blobKey: string, fileName?: string): Promise<void>;
}) {
  const { kind, fromMe, i18n, record, loadBlob, onPreview, onDownload } = props;
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    let revoked = false;
    let currentUrl: string | null = null;
    async function load() {
      if (kind !== "image" || !record.blobKey) return;
      setPreviewUrl(null);
      try {
        const blob = await loadBlob(record.blobKey);
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        currentUrl = url;
        if (!revoked) setPreviewUrl(url);
        else URL.revokeObjectURL(url);
      } catch {
        if (!revoked) setPreviewUrl(null);
      }
    }
    void load();
    return () => {
      revoked = true;
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [loadBlob, record.blobKey]);

  if (kind === "image") {
    return (
      <div className={`km-message-detail__attachment km-message-detail__attachment--image ${fromMe ? "is-me" : "is-peer"}`}>
        <div className="km-message-detail__message-meta">
          <span>{record.fileName ?? i18n.t("message.page.detail.timeline.attachment.image")}</span>
          <span>{formatTime(record.endedAtMs ?? record.startedAtMs)}</span>
        </div>
        <button
          className="km-message-detail__thumbnail-button"
          type="button"
          disabled={!record.blobKey}
          onClick={() => {
            if (record.blobKey) {
              void onPreview(record.blobKey);
            }
          }}
        >
          {previewUrl ? (
            <img
              className="km-message-detail__thumbnail"
              src={previewUrl}
              alt={record.fileName ?? i18n.t("message.page.detail.timeline.attachment.image")}
            />
          ) : (
            <span>{i18n.t("message.page.detail.timeline.previewUnavailable")}</span>
          )}
        </button>
        {record.blobKey ? (
          <button
            className="km-message-detail__attachment-action"
            type="button"
            onClick={() => {
              void onDownload(record.blobKey!, record.fileName);
            }}
          >
            {i18n.t("message.page.detail.timeline.download")}
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <div className={`km-message-detail__attachment km-message-detail__attachment--file ${fromMe ? "is-me" : "is-peer"}`}>
      <div className="km-message-detail__message-meta">
        <span>{record.fileName ?? i18n.t("message.page.detail.timeline.attachment.file")}</span>
        <span>{formatBytes(record.byteLength ?? 0)}</span>
      </div>
      <div className="km-message-detail__system-line">{record.fileName ?? i18n.t("message.page.detail.timeline.attachment.file")}</div>
      {record.blobKey ? (
        <button
          className="km-message-detail__attachment-action"
          type="button"
          onClick={() => {
            void onDownload(record.blobKey!, record.fileName);
          }}
        >
          {i18n.t("message.page.detail.timeline.download")}
        </button>
      ) : null}
    </div>
  );
}

function describeTimelineItem(item: MessageTimelineItem): string {
  if (item.kind === "text_message") return item.message.messageId;
  return item.record.recordId;
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

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatMessageDetailError(
  i18n: ReturnType<typeof useI18n>,
  err: unknown
): string {
  const raw = err instanceof Error ? err.message : String(err);
  const key = resolveMessageDetailErrorKey(raw);
  return i18n.t(key ?? "message.page.detail.error.unknown");
}

/**
 * 将内部错误字符串收口成稳定 i18n key，避免把英文实现细节直接露给用户。
 */
function resolveMessageDetailErrorKey(raw: string): string | null {
  const direct = MESSAGE_ERROR_KEYS[raw];
  if (direct) return direct;
  if (raw.startsWith("transfer_reject:")) {
    const reason = raw.slice("transfer_reject:".length).trim();
    if (reason) {
      const mapped = MESSAGE_ERROR_KEYS[`transfer_reject_${reason}`];
      if (mapped) return mapped;
    }
    return "message.page.detail.error.transfer_reject";
  }
  if (raw.startsWith("device_unavailable:")) {
    return "message.page.detail.error.device_unavailable";
  }
  if (raw.startsWith("send_invite_failed:")) {
    return "message.page.detail.error.send_invite_failed";
  }
  if (raw.startsWith("create_offer_failed:")) {
    return "message.page.detail.error.create_offer_failed";
  }
  if (raw.startsWith("transfer_invite_failed:")) {
    return "message.page.detail.error.transfer_invite_failed";
  }
  return null;
}

/**
 * 通话状态只允许显示稳定文案，不直接暴露底层历史枚举值。
 */
function formatCallStatus(i18n: ReturnType<typeof useI18n>, status: string): string {
  const key = CALL_STATUS_KEYS[status];
  return key ? i18n.t(key) : i18n.t("message.page.detail.timeline.call.status.unknown");
}

function parsePeerPublicKeyHexFromPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (segments.length !== 2) {
    return "";
  }
  if (segments[0] !== "messages" && segments[0] !== "message") {
    return "";
  }
  try {
    return decodeURIComponent(segments[1] ?? "");
  } catch {
    return segments[1] ?? "";
  }
}
