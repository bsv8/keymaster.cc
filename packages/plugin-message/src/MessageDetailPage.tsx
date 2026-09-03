// 会话详情页。
//
// 设计缘由：
//   - 路由参数是对端 publicKeyHex；
//   - 文本消息与 WebRTC 历史分开存储、合并展示；
//   - 发送动作保留文本输入，并在正文区下方直接承载当前 peer 的通话面板；
//   - 不在页面轮询对端在线状态；消息和 WebRTC 都直接执行，失败由协议结果反馈。
//
// 硬切换 003：消息和联系人数据使用 Resource Store。
// WebRTC 会话快照是实时状态，保留为本地订阅。

import { useEffect, useMemo, useRef, useState } from "react";
import { useCapability, useCurrentPath, useI18n, usePluginHost, useResource, useResourceSelector, router } from "@keymaster/runtime";
import { EmptyState, TextArea } from "@keymaster/ui";
import { WEBRTC_SERVICE_CAPABILITY, type KeyspaceService, type WebrtcHistoryItem, type WebrtcMessageService, type WebrtcSessionSnapshot } from "@keymaster/contracts";
import type { MessageService } from "./messageService.js";
import type { MessageDetailData } from "./manifest.js";
import { buildMessageTimeline, type MessageTimelineItem } from "./messageTimeline.js";
import { shortPublicKeyHex } from "./messageConversation.js";

const MESSAGE_SERVICE_CAPABILITY = "message.service";
const MESSAGE_READ_WINDOW = 10_000;
const DEFAULT_VISIBLE_MESSAGE_COUNT = 20;
const MESSAGE_ERROR_KEYS: Record<string, string> = {
  service_not_ready: "message.page.detail.error.service_not_ready",
  invalid_target: "message.page.detail.error.invalid_target",
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
  const normalizedPeerPublicKeyHex = normalizePublicKeyHexForMatch(peerPublicKeyHex);
  const messageService = useCapabilityOrNull<MessageService>(MESSAGE_SERVICE_CAPABILITY);
  const keyspace = useCapability<KeyspaceService>("keyspace.service");
  const webrtc = useCapabilityOrNull<WebrtcMessageService>(WEBRTC_SERVICE_CAPABILITY);
  const host = usePluginHost();
  const store = host.resourceStore;
  const ownerPublicKeyHex = keyspace.active().activePublicKeyHex ?? null;

  // 使用 Resource Store 读取消息和联系人数据
  const detailData = useResourceSelector<MessageDetailData, MessageDetailData>(
    store,
    "message.detail",
    [normalizedPeerPublicKeyHex],
    (snapshot) => snapshot.data ?? { messages: [], contact: null },
    (a, b) => {
      if (a.messages.length !== b.messages.length) return false;
      if (a.contact?.id !== b.contact?.id) return false;
      return true;
    }
  );
  const messages = detailData.messages;
  const contact = detailData.contact;

  // WebRTC 相关状态（实时状态，保留为本地订阅）
  const historyResource = useResource<WebrtcHistoryItem[]>(host.resourceStore, "webrtc.peer-history", [normalizedPeerPublicKeyHex]);
  const history = historyResource.data ?? [];
  const [sendBody, setSendBody] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendBusy, setSendBusy] = useState(false);
  const webrtcResource = useResource<WebrtcSessionSnapshot>(host.resourceStore, "webrtc.session", []);
  const webrtcSnapshot = webrtcResource.data ?? (webrtc?.snapshot() ?? null);
  const [callActionBusy, setCallActionBusy] = useState(false);
  const [isLocalPrimary, setIsLocalPrimary] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(DEFAULT_VISIBLE_MESSAGE_COUNT);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const callPanelRef = useRef<HTMLElement | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const sendInFlightRef = useRef(false);
  const service = messageService;

  useEffect(() => {
    setVisibleCount(DEFAULT_VISIBLE_MESSAGE_COUNT);
  }, [ownerPublicKeyHex, normalizedPeerPublicKeyHex]);

  const activeCallForCurrentPeer =
    webrtcSnapshot &&
    normalizePublicKeyHexForMatch(webrtcSnapshot.remotePublicKeyHex) === normalizedPeerPublicKeyHex &&
    webrtcSnapshot.phase !== "idle" &&
    webrtcSnapshot.phase !== "ended"
      ? webrtcSnapshot
      : null;
  const isVideoSessionForCurrentPeer = activeCallForCurrentPeer?.mode === "video";
  const hasAnyActiveWebrtcSession =
    !!webrtcSnapshot && webrtcSnapshot.phase !== "idle" && webrtcSnapshot.phase !== "ended";
  const activeCallTitleKey = isVideoSessionForCurrentPeer
    ? "message.page.detail.call.title.video"
    : "message.page.detail.call.title.audio";
  const activeCallModeLabel = activeCallForCurrentPeer
    ? i18n.t(`message.page.detail.call.mode.${activeCallForCurrentPeer.mode}`)
    : "";
  const activeCallPhaseLabel = activeCallForCurrentPeer
    ? i18n.t(`message.page.detail.call.phase.${activeCallForCurrentPeer.phase}`, {
        defaultValue: activeCallForCurrentPeer.phase
      })
    : "";

  const timeline = useMemo(() => {
    if (!ownerPublicKeyHex || !normalizedPeerPublicKeyHex) return [];
    return buildMessageTimeline({
      messages,
      history,
      ownerPublicKeyHex,
      peerPublicKeyHex: normalizedPeerPublicKeyHex
    });
  }, [history, messages, ownerPublicKeyHex, normalizedPeerPublicKeyHex]);

  const visibleItems = useMemo(() => timeline.slice(0, visibleCount), [timeline, visibleCount]);
  const hasMoreItems = timeline.length > visibleItems.length;

  useEffect(() => {
    if (!isVideoSessionForCurrentPeer) {
      setIsLocalPrimary(false);
      setIsFullscreen(false);
    }
  }, [isVideoSessionForCurrentPeer, normalizedPeerPublicKeyHex]);

  useEffect(() => {
    if (!isVideoSessionForCurrentPeer) return;
    const syncFullscreen = () => {
      setIsFullscreen(document.fullscreenElement === callPanelRef.current);
    };
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreen);
    };
  }, [isVideoSessionForCurrentPeer]);

  useEffect(() => {
    if (!isVideoSessionForCurrentPeer) return;
    const panel = callPanelRef.current;
    const localEl = localVideoRef.current;
    const remoteEl = remoteVideoRef.current;
    if (!panel || !localEl || !remoteEl || !webrtc) return;
    const offLocal = webrtc.attachToVideo("local", localEl);
    const offRemote = webrtc.attachToVideo("remote", remoteEl);
    return () => {
      offLocal();
      offRemote();
    };
  }, [
    isVideoSessionForCurrentPeer,
    isLocalPrimary,
    webrtc,
    activeCallForCurrentPeer?.hasLocalStream,
    activeCallForCurrentPeer?.hasRemoteStream,
    activeCallForCurrentPeer?.phase,
    activeCallForCurrentPeer?.mode
  ]);

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
  const actionsDisabled = !webrtc;
  const dialButtonsDisabled = actionsDisabled || hasAnyActiveWebrtcSession;

  async function sendText() {
    if (sendInFlightRef.current) return;
    setSendError(null);
    const body = sendBody.trim();
    if (!body) {
      setSendError(i18n.t("message.page.send.empty"));
      return;
    }
    sendInFlightRef.current = true;
    setSendBusy(true);
    try {
      await service!.sendTextMessage({ recipientPublicKeyHex: normalizedPeerPublicKeyHex, body });
      setSendBody("");
      // mutation 主动失效，避免页面刷新依赖 provider 是否回推发送侧消息。
      store.invalidate("message.detail", [normalizedPeerPublicKeyHex]);
      store.invalidate("message.conversations", []);
    } catch (err) {
      setSendError(formatMessageDetailError(i18n, err, "message.page.detail.error.send_unknown"));
    } finally {
      sendInFlightRef.current = false;
      setSendBusy(false);
    }
  }

  async function startCall(mode: "audio" | "video") {
    if (!webrtc) return;
    if (hasAnyActiveWebrtcSession) {
      setSendError(i18n.t("message.page.detail.error.busy_local"));
      return;
    }
    try {
      await webrtc.startCall({ targetPublicKeyHex: normalizedPeerPublicKeyHex, mode });
    } catch (err) {
      setSendError(formatMessageDetailError(i18n, err));
    }
  }

  async function sendAttachment(kind: "image" | "file", file: File) {
    if (!webrtc) return;
    try {
      if (kind === "image") {
        await webrtc.sendImage({ targetPublicKeyHex: normalizedPeerPublicKeyHex, file });
      } else {
        await webrtc.sendFile({ targetPublicKeyHex: normalizedPeerPublicKeyHex, file });
      }
      host.resourceStore.invalidate("webrtc.peer-history", [normalizedPeerPublicKeyHex]);
    } catch (err) {
      setSendError(formatMessageDetailError(i18n, err));
    }
  }

  async function runCallAction(action: () => Promise<void>) {
    if (!webrtc) return;
    setSendError(null);
    setCallActionBusy(true);
    try {
      await action();
    } catch (err) {
      setSendError(formatMessageDetailError(i18n, err));
    } finally {
      setCallActionBusy(false);
    }
  }

  async function toggleFullscreen() {
    const panel = callPanelRef.current;
    if (!panel) return;
    if (document.fullscreenElement === panel) {
      if (typeof document.exitFullscreen !== "function") return;
      try {
        await document.exitFullscreen();
        setIsFullscreen(false);
      } catch {
        return;
      }
      return;
    }
    if (typeof panel.requestFullscreen !== "function") return;
    try {
      await panel.requestFullscreen();
      setIsFullscreen(true);
    } catch {
      return;
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
          <span className="km-message-detail__key">
            {shortPublicKeyHex(peerPublicKeyHex)}
          </span>
        </div>
      </header>

      {activeCallForCurrentPeer ? (
        <section
          className={`km-message-detail__call-panel ${
            isVideoSessionForCurrentPeer
              ? "km-message-detail__call-panel--video"
              : "km-message-detail__call-panel--audio"
          } ${isFullscreen ? "is-fullscreen" : ""}`}
          ref={callPanelRef}
          data-call-mode={activeCallForCurrentPeer.mode}
          data-call-phase={activeCallForCurrentPeer.phase}
        >
          <header className="km-message-detail__call-panel-header">
            <div className="km-message-detail__call-panel-headline">
              <h2 className="km-message-detail__call-panel-title">
                {i18n.t(activeCallTitleKey)}
              </h2>
              <div className="km-message-detail__call-panel-meta">
                <span>
                  {i18n.t("message.page.detail.call.peer")}: {shortPublicKeyHex(peerPublicKeyHex)}
                </span>
                <span>
                  {i18n.t("message.page.detail.call.phase")}: {activeCallPhaseLabel}
                </span>
                <span>
                  {i18n.t("message.page.detail.call.mode")}: {activeCallModeLabel}
                </span>
              </div>
            </div>
            <span className="km-message-detail__call-panel-direction">
              {activeCallForCurrentPeer.direction === "incoming"
                ? i18n.t("message.page.detail.call.direction.incoming")
                : i18n.t("message.page.detail.call.direction.outgoing")}
            </span>
          </header>

          {isVideoSessionForCurrentPeer ? (
            <div
              className={`km-message-detail__video-stage ${
                isLocalPrimary
                  ? "km-message-detail__video-stage--local-primary"
                  : "km-message-detail__video-stage--remote-primary"
              }`}
            >
              <section
                className={`km-message-detail__video-tile km-message-detail__video-tile--primary ${
                  isLocalPrimary ? "is-local" : "is-remote"
                }`}
              >
                <span className="km-message-detail__video-tile-label">
                  {isLocalPrimary
                    ? i18n.t("message.page.detail.call.local")
                    : i18n.t("message.page.detail.call.remote")}
                </span>
                {isLocalPrimary ? (
                  activeCallForCurrentPeer.hasLocalStream ? (
                    <video
                      ref={localVideoRef}
                      className="km-message-detail__video"
                      autoPlay
                      playsInline
                      muted
                    />
                  ) : (
                    <div className="km-message-detail__video-placeholder">
                      {i18n.t("message.page.detail.call.waitingLocal")}
                    </div>
                  )
                ) : activeCallForCurrentPeer.hasRemoteStream ? (
                  <video
                    ref={remoteVideoRef}
                    className="km-message-detail__video"
                    autoPlay
                    playsInline
                  />
                ) : (
                  <div className="km-message-detail__video-placeholder">
                    {i18n.t("message.page.detail.call.waitingRemote")}
                  </div>
                )}
              </section>
              <section
                className={`km-message-detail__video-tile km-message-detail__video-tile--secondary ${
                  isLocalPrimary ? "is-remote" : "is-local"
                }`}
              >
                <span className="km-message-detail__video-tile-label">
                  {isLocalPrimary
                    ? i18n.t("message.page.detail.call.remote")
                    : i18n.t("message.page.detail.call.local")}
                </span>
                {isLocalPrimary ? (
                  activeCallForCurrentPeer.hasRemoteStream ? (
                    <video
                      ref={remoteVideoRef}
                      className="km-message-detail__video"
                      autoPlay
                      playsInline
                    />
                  ) : (
                    <div className="km-message-detail__video-placeholder">
                      {i18n.t("message.page.detail.call.waitingRemote")}
                    </div>
                  )
                ) : activeCallForCurrentPeer.hasLocalStream ? (
                  <video
                    ref={localVideoRef}
                    className="km-message-detail__video"
                    autoPlay
                    playsInline
                    muted
                  />
                ) : (
                  <div className="km-message-detail__video-placeholder">
                    {i18n.t("message.page.detail.call.waitingLocal")}
                  </div>
                )}
              </section>
            </div>
          ) : (
            <div className="km-message-detail__audio-panel">
              <div className="km-message-detail__audio-line">
                {i18n.t("message.page.detail.call.peer")}: {shortPublicKeyHex(peerPublicKeyHex)}
              </div>
              <div className="km-message-detail__audio-line">
                {i18n.t("message.page.detail.call.phase")}: {activeCallPhaseLabel}
              </div>
              <div className="km-message-detail__audio-line">
                {i18n.t("message.page.detail.call.mode")}: {activeCallModeLabel}
              </div>
            </div>
          )}

          <div className="km-message-detail__call-panel-actions">
            {activeCallForCurrentPeer.phase === "incoming" ? (
              <>
                <button
                  className="km-message-detail__call-action km-message-detail__call-action--primary"
                  type="button"
                  disabled={callActionBusy}
                  onClick={() => void runCallAction(() => webrtc!.acceptIncoming())}
                >
                  {i18n.t("message.page.detail.call.accept")}
                </button>
                <button
                  className="km-message-detail__call-action"
                  type="button"
                  disabled={callActionBusy}
                  onClick={() => void runCallAction(() => webrtc!.rejectIncoming())}
                >
                  {i18n.t("message.page.detail.call.reject")}
                </button>
              </>
            ) : (
              <button
                className="km-message-detail__call-action km-message-detail__call-action--danger"
                type="button"
                disabled={callActionBusy}
                onClick={() => void runCallAction(() => webrtc!.hangup())}
              >
                {i18n.t("message.page.detail.call.hangup")}
              </button>
            )}
            {isVideoSessionForCurrentPeer ? (
              <>
                <button
                  className="km-message-detail__call-action"
                  type="button"
                  onClick={() => setIsLocalPrimary((current) => !current)}
                >
                  {i18n.t("message.page.detail.call.swap")}
                </button>
                <button
                  className="km-message-detail__call-action"
                  type="button"
                  onClick={() => {
                    void toggleFullscreen();
                  }}
                >
                  {isFullscreen
                    ? i18n.t("message.page.detail.call.exitFullscreen")
                    : i18n.t("message.page.detail.call.fullscreen")}
                </button>
              </>
            ) : null}
          </div>
        </section>
      ) : null}

      <section className="km-message-detail__composer">
        <TextArea
          label={i18n.t("message.page.detail.body")}
          value={sendBody}
          onChange={(e) => setSendBody(e.currentTarget.value)}
          rows={4}
        />
        <div className="km-message-detail__composer-row">
          <button
            className="km-message-detail__send"
            type="button"
            disabled={sendBusy}
            aria-busy={sendBusy}
            onClick={() => void sendText()}
          >
            {sendBusy
              ? i18n.t("message.page.send.sending")
              : i18n.t("message.page.send.submit")}
          </button>
          <span className="km-message-detail__divider" aria-hidden="true">|</span>
          <button
            className="km-message-detail__action"
            type="button"
            disabled={dialButtonsDisabled}
            onClick={() => void startCall("video")}
          >
            {i18n.t("message.page.detail.video")}
          </button>
          <button
            className="km-message-detail__action"
            type="button"
            disabled={dialButtonsDisabled}
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
          {sendError ? (
            <span className="km-message-detail__error" role="alert">
              {sendError}
            </span>
          ) : null}
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
        <div className={`km-message-detail__system ${record.direction === "outgoing" ? "is-me" : "is-peer"}`}>
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
  err: unknown,
  fallbackKey = "message.page.detail.error.unknown"
): string {
  const raw = err instanceof Error ? err.message : String(err);
  const key = resolveMessageDetailErrorKey(raw);
  return i18n.t(key ?? fallbackKey);
}

/**
 * 将内部错误字符串收口成稳定 i18n key，避免把英文实现细节直接露给用户。
 */
function resolveMessageDetailErrorKey(raw: string): string | null {
  const normalized = raw.toLowerCase();
  if (
    normalized.includes("not_ready") ||
    normalized.includes("not bound") ||
    normalized.includes("socket closed") ||
    normalized.includes("session_key_mismatch") ||
    normalized.includes("session has been revoked") ||
    normalized.includes("coordinator crypto rpc unavailable") ||
    normalized.includes("invalid_sender")
  ) {
    return "message.page.detail.error.service_not_ready";
  }
  if (
    normalized.includes("invalid_target") ||
    normalized.includes("invalid_recipient") ||
    normalized.includes("invalid hex") ||
    normalized.includes("bad point") ||
    normalized.includes("point is not on curve") ||
    normalized.includes("public key must be 33 bytes")
  ) {
    return "message.page.detail.error.invalid_target";
  }
  if (normalized.includes("request timeout") || normalized.includes("timed out")) {
    return "message.page.detail.error.send_timeout";
  }
  if (normalized.includes("invalid_signature")) {
    return "message.page.detail.error.signature_failed";
  }
  if (normalized.includes("idempotency_clash")) {
    return "message.page.detail.error.duplicate_message";
  }
  if (normalized.includes("seal failed") || normalized.includes("unexpected result type")) {
    return "message.page.detail.error.seal_failed";
  }
  if (normalized.startsWith("internal:") || normalized.includes("store:")) {
    return "message.page.detail.error.server_unavailable";
  }
  if (
    normalized.includes("bad_request") ||
    normalized.includes("invalid_endpoint") ||
    normalized.includes("unsupported_envelope") ||
    normalized.includes("unsupported_seal") ||
    normalized.includes("malformed message.send")
  ) {
    return "message.page.detail.error.send_rejected";
  }
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

/**
 * 仅用于页面内匹配与 service 调用的最小规整，不做合法性校验。
 */
function normalizePublicKeyHexForMatch(publicKeyHex: string | null | undefined): string {
  return (publicKeyHex ?? "").trim().toLowerCase();
}
