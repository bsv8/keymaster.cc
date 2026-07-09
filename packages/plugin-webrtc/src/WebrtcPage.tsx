// packages/plugin-webrtc/src/WebrtcPage.tsx
// WebRTC 工作台页面（施工单 2026-07-04 002 硬切换）。
//
// 设计缘由：
//   - 本页面**只**展示 `plugin-webrtc` 内部 service 的会话状态：
//       * 输入对方 publicKeyHex → 选择 audio / video → 拨号（先通过
//         online 前置门禁）；
//       * 入站来电卡片：accept / decline；
//       * 当前会话状态 + 远端提示（fallback / reject / busy）；
//       * 本地 / 远端媒体流区域（通过 `service.attachToVideo(...)` 绑流）。
//   - **不**展示 HubMsg / AppMsg 连接态、provider 列表、统计；这些归
//     `plugin-appmsg` 的 `/system/appmsg` 管理页；
//   - 直接通过 `useCapability(WebrtcService)` 从 capability bus 拿 service；
//     业务组件**不**接触 `appmsg.core` 全库接口。
//   - 错误映射走 i18n key，不再硬编码英文；service 的 `lastError` 现在
//     是稳定枚举（`WebrtcBlockReason`），UI 直接 `t(key)` 拿展示文案。

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useCapability, useI18n } from "@keymaster/runtime";
import { PageHeader } from "@keymaster/ui";
import { formatShortPublicKey } from "@keymaster/contracts";
import { WEBRTC_SERVICE_CAPABILITY } from "./constants.js";
import type {
  WebrtcRemoteNotice,
  WebrtcService,
  WebrtcSessionSnapshot,
  WebrtcBlockReason,
  WebrtcMode
} from "./webrtcService.js";

export function WebrtcPage(): React.ReactElement {
  const { t } = useI18n();
  const service = useCapabilityOrNull<WebrtcService>(WEBRTC_SERVICE_CAPABILITY);
  if (!service) {
    return (
      <section
        className="km-webrtc-page"
        data-webrtc-page="missing-service"
      >
        <PageHeader
          title={t("webrtc.page.workbench.title", { defaultValue: "WebRTC" })}
          description={t("webrtc.page.workbench.desc", {
            defaultValue: "webrtc service is not available."
          })}
        />
      </section>
    );
  }
  return <WebrtcPageInner service={service} />;
}

function useCapabilityOrNull<T>(key: string): T | null {
  try {
    return useCapability<T>(key);
  } catch {
    return null;
  }
}

interface WebrtcPageInnerProps {
  service: WebrtcService;
}

/**
 * service.lastError → i18n key 映射。所有用户可见的失败提示都从这里出，
 * 不允许在页面层重新硬编码英文字符串。
 */
const ERROR_KEY: Record<WebrtcBlockReason, string> = {
  service_not_ready: "webrtc.page.workbench.block.service_not_ready",
  invalid_target: "webrtc.page.workbench.block.invalid_target",
  target_offline: "webrtc.page.workbench.block.target_offline",
  target_unknown: "webrtc.page.workbench.block.target_unknown",
  busy_local: "webrtc.page.workbench.block.busy_local",
  device_unavailable: "webrtc.page.workbench.block.device_unavailable",
  send_invite_failed: "webrtc.page.workbench.block.send_invite_failed",
  create_offer_failed: "webrtc.page.workbench.block.create_offer_failed",
  invalid_state: "webrtc.page.workbench.block.invalid_state"
};

function WebrtcPageInner({ service }: WebrtcPageInnerProps): React.ReactElement {
  const { t } = useI18n();
  const [snap, setSnap] = useState<WebrtcSessionSnapshot>(() => service.snapshot());
  const [target, setTarget] = useState("");
  const [errorKey, setErrorKey] = useState<WebrtcBlockReason | null>(null);
  const [busy, setBusy] = useState(false);

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);

  // 订阅 service snapshot。
  useEffect(() => {
    const off = service.subscribe((s) => setSnap(s));
    return () => off();
  }, [service]);

  /**
   * 媒体绑定：本地 / 远端 video 元素分别绑到 service 暴露的真值。
   * `direction` 与 `service.attachToVideo(direction)` 一一对应；
   * `snap.hasLocalStream` / `hasRemoteStream` 变化时重新绑定。
   *
   * 返回的清理函数把 srcObject 解绑——通话清场 / 卸载时 UI 必须走这里。
   */
  useEffect(() => {
    const localEl = localVideoRef.current;
    const remoteEl = remoteVideoRef.current;
    if (!localEl || !remoteEl) return;
    const offLocal = service.attachToVideo("local", localEl);
    const offRemote = service.attachToVideo("remote", remoteEl);
    return () => {
      offLocal();
      offRemote();
    };
  }, [service, snap.hasLocalStream, snap.hasRemoteStream, snap.direction, snap.phase]);

  // service 抛出 → 通过 lastError 同步到 UI；服务会自己 emit。
  // 因此我们让 service.lastError 直接驱动 errorKey，不在 try/catch 里手动管理。
  useEffect(() => {
    if (snap.lastError) {
      setErrorKey(snap.lastError);
    }
  }, [snap.lastError]);

  const onDismissNotice = useCallback(() => {
    service.consumeRemoteNotice();
  }, [service]);

  const startCallGuarded = useCallback(
    async (mode: WebrtcMode) => {
      setErrorKey(null);
      const trimmed = target.trim();
      if (!/^[0-9a-f]{66}$/i.test(trimmed)) {
        setErrorKey("invalid_target");
        return;
      }
      setBusy(true);
      try {
        await service.startCall({ targetPublicKeyHex: trimmed, mode });
      } catch (err) {
        // service 已经把错误映射到 lastError；这里再读一次拿到最新即可。
        const latest = service.snapshot();
        if (latest.lastError) {
          setErrorKey(latest.lastError);
        } else {
          // 极端兜底：service 把错误抛出去了但没设置 lastError（不会发生在
          // 当前实现里，但保持 UI 不白屏）。
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("target_offline")) setErrorKey("target_offline");
          else if (msg.includes("target_unknown")) setErrorKey("target_unknown");
          else if (msg.includes("busy_local")) setErrorKey("busy_local");
          else if (msg.includes("service_not_ready")) setErrorKey("service_not_ready");
          else if (msg.startsWith("send_invite_failed")) setErrorKey("send_invite_failed");
          else if (msg.startsWith("create_offer_failed")) setErrorKey("create_offer_failed");
          else if (msg.startsWith("device_unavailable")) setErrorKey("device_unavailable");
        }
      } finally {
        setBusy(false);
      }
    },
    [service, target]
  );

  const onAccept = useCallback(async () => {
    setErrorKey(null);
    setBusy(true);
    try {
      await service.acceptIncoming();
    } catch {
      // service 已把错误推到 lastError，UI 通过订阅自然可见。
    } finally {
      setBusy(false);
    }
  }, [service]);

  const onReject = useCallback(async () => {
    setErrorKey(null);
    setBusy(true);
    try {
      await service.rejectIncoming();
    } catch {
      // ignore
    } finally {
      setBusy(false);
    }
  }, [service]);

  const onHangup = useCallback(async () => {
    setErrorKey(null);
    setBusy(true);
    try {
      await service.hangup();
    } catch {
      // ignore
    } finally {
      setBusy(false);
    }
  }, [service]);

  const phaseLabel = t(`webrtc.page.workbench.phase.${snap.phase}`, {
    defaultValue: snap.phase
  });

  const directionLabel = snap.direction === "outgoing"
    ? t("webrtc.page.workbench.direction.outgoing", { defaultValue: "outgoing" })
    : snap.direction === "incoming"
      ? t("webrtc.page.workbench.direction.incoming", { defaultValue: "incoming" })
      : "";

  return (
    <section className="km-webrtc-page" data-webrtc-page="workbench">
      <PageHeader
        title={t("webrtc.page.workbench.title", { defaultValue: "WebRTC" })}
        description={t("webrtc.page.workbench.desc", {
          defaultValue:
            "Real-time audio / video chat over STUN-only WebRTC."
        })}
      />

      {!snap.serviceReady ? (
        <div className="km-webrtc-page__error">
          {t("webrtc.page.workbench.block.service_not_ready", {
            defaultValue: "webrtc service not ready"
          })}
        </div>
      ) : null}

      {errorKey ? (
        <div className="km-webrtc-page__error" data-webrtc-error={errorKey}>
          {t(ERROR_KEY[errorKey], { defaultValue: errorKey })}
        </div>
      ) : null}

      {snap.remoteNotice ? (
        <RemoteNoticeBanner
          notice={snap.remoteNotice}
          onDismiss={onDismissNotice}
        />
      ) : null}

      <div className="km-webrtc-page__status" data-webrtc-phase={snap.phase}>
        <strong>phase:</strong> {phaseLabel}
        {directionLabel ? ` (${directionLabel})` : ""}
        {snap.mode ? ` mode=${snap.mode}` : ""}
        {snap.remotePublicKeyHex ? ` remote=${shortHex(snap.remotePublicKeyHex)}` : ""}
      </div>

      <div>
        <h2 style={{ margin: "0 0 8px 0", fontSize: 16 }}>
          {t("webrtc.page.workbench.target.label", { defaultValue: "Recipient" })}
        </h2>
        <label className="km-webrtc-page__field">
          <span className="km-webrtc-page__field-label">
            {t("webrtc.page.workbench.target.label", { defaultValue: "Recipient" })}
          </span>
          <input
            className="km-webrtc-page__input"
            type="text"
            value={target}
            onChange={(e) => setTarget(e.currentTarget.value)}
            placeholder={t("webrtc.page.workbench.target.placeholder", {
              defaultValue: "02... (66 hex chars)"
            })}
            disabled={snap.direction !== null || busy || !snap.serviceReady}
          />
        </label>
        <div className="km-webrtc-page__row" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="km-webrtc-page__button"
            disabled={snap.direction !== null || busy || !snap.serviceReady}
            onClick={() => {
              void startCallGuarded("audio");
            }}
            data-webrtc-action="start-audio"
          >
            {t("webrtc.page.workbench.target.mode.audio", {
              defaultValue: "Audio"
            })}
          </button>
          <button
            type="button"
            className="km-webrtc-page__button"
            disabled={snap.direction !== null || busy || !snap.serviceReady}
            onClick={() => {
              void startCallGuarded("video");
            }}
            data-webrtc-action="start-video"
          >
            {t("webrtc.page.workbench.target.mode.video", {
              defaultValue: "Video"
            })}
          </button>
        </div>
      </div>

      {snap.phase === "incoming" ? (
        <div className="km-webrtc-page__status" data-webrtc-incoming>
          <strong>{t("webrtc.page.workbench.phase.incoming", { defaultValue: "incoming" })}</strong>{" "}
          {snap.remotePublicKeyHex ? shortHex(snap.remotePublicKeyHex) : ""}
          <div className="km-webrtc-page__row" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="km-webrtc-page__button km-webrtc-page__button--primary"
              onClick={() => void onAccept()}
              disabled={busy}
              data-webrtc-action="accept"
            >
              {t("webrtc.page.workbench.actions.accept", { defaultValue: "Accept" })}
            </button>
            <button
              type="button"
              className="km-webrtc-page__button"
              onClick={() => void onReject()}
              disabled={busy}
              data-webrtc-action="reject"
            >
              {t("webrtc.page.workbench.actions.reject", { defaultValue: "Decline" })}
            </button>
          </div>
        </div>
      ) : null}

      {snap.direction !== null ? (
        <div className="km-webrtc-page__row">
          <button
            type="button"
            className="km-webrtc-page__button km-webrtc-page__button--danger"
            onClick={() => void onHangup()}
            disabled={busy}
            data-webrtc-action="hangup"
          >
            {t("webrtc.page.workbench.actions.hangup", { defaultValue: "Hang up" })}
          </button>
        </div>
      ) : null}

      <div className="km-webrtc-page__media">
        <div className="km-webrtc-page__media-tile">
          <video
            ref={localVideoRef}
            className="km-webrtc-page__video"
            autoPlay
            playsInline
            muted
            data-webrtc-video="local"
          />
          <span className="km-webrtc-page__media-tile-label">local</span>
        </div>
        <div className="km-webrtc-page__media-tile">
          <video
            ref={remoteVideoRef}
            className="km-webrtc-page__video"
            autoPlay
            playsInline
            data-webrtc-video="remote"
          />
          <span className="km-webrtc-page__media-tile-label">remote</span>
        </div>
      </div>
    </section>
  );
}

function RemoteNoticeBanner({
  notice,
  onDismiss
}: {
  notice: WebrtcRemoteNotice;
  onDismiss: () => void;
}): React.ReactElement {
  const { t } = useI18n();
  let key: string;
  switch (notice.kind) {
    case "fallback_suggested":
      key = "webrtc.page.workbench.notice.fallback_suggested";
      break;
    case "busy":
      key = "webrtc.page.workbench.notice.busy";
      break;
    default:
      key = "webrtc.page.workbench.notice.rejected";
  }
  return (
    <div className="km-webrtc-page__notice">
      <span>{t(key, { defaultValue: notice.message })}</span>
      <button
        type="button"
        className="km-webrtc-page__button"
        onClick={onDismiss}
      >
        {t("webrtc.page.workbench.notice.dismiss", { defaultValue: "dismiss" })}
      </button>
    </div>
  );
}

function shortHex(h: string): string {
  return formatShortPublicKey(h);
}
