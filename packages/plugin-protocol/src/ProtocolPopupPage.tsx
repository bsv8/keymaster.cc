// packages/plugin-protocol/src/ProtocolPopupPage.tsx
// 对外协议 popup 页面。
//
// 设计缘由（施工单 003 硬切换：confirm 收口到历史卡 + 外部 cancel + 超时）：
//   - 页面**只**渲染顶栏 / 站点配置面板 / 命令流；不再保留独立全页
//     确认 overlay。
//   - 当前请求的交互（解锁表单 / 确认按钮 / 取消按钮 / 倒计时）全部
//     收口到命令流最新卡片里（`ProtocolCommandFeed.CommandCard`
//     内部按 phase 渲染交互体）。
//   - 历史卡片保持只读 summary；不允许出现第二套"当前请求" UI。
//   - 页面只负责渲染态 + 转交用户操作给 service；密码学 / message 收发
//     / 校验 / 签名 / 加解密一律不进组件。
//   - 顶栏 sticky：当前 origin / 站点配置按钮 / 关闭 / 回到最新 / 进入钱包。
//   - popup 是**会话级**长存：单条 request 完成后 phase 回到 waiting，
//     不会自动关窗；`closing` 由 pagehide / beforeunload 路径发出。
//   - 文案中文；错误 message 原样显示英文。

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@keymaster/runtime";
import type {
  MethodParams,
  ProtocolCommandFeedState,
  ProtocolMethod,
  ProtocolService,
  ProtocolSessionSnapshot
} from "@keymaster/contracts";
import { PROTOCOL_SERVICE_CAPABILITY } from "@keymaster/contracts";
import { useCapability } from "@keymaster/runtime";
import { ProtocolCommandFeed } from "./ProtocolCommandFeed.js";
import { OriginSettingsTrayInline } from "./OriginSettingsTray.js";

/** 钱包首页 URL：硬编码，"进入钱包"按钮的固定目标。 */
const WALLET_HOMEPAGE_URL = "https://keymaster.cc";

/**
 * 顶栏"进入钱包"按钮的 onClick handler。
 *
 * best-effort：window.open 失败不报错、不弹提示。
 * 设计缘由（施工单 001）：钱包是外部站点，service 不持有它的会话；
 * 扩展失败恢复协议会让 popup 自己也跳走，违反"popup 是会话级长存"。
 * 失败就让用户点不到，不影响 popup 主流程。
 */
function openWalletHomepage(): void {
  try {
    window.open(WALLET_HOMEPAGE_URL, "_blank", "noopener,noreferrer");
  } catch (err) {
    console.warn("[protocol-popup] openWalletHomepage failed", err);
  }
}

export function ProtocolPopupPage() {
  const service = useCapability<ProtocolService>(PROTOCOL_SERVICE_CAPABILITY);
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  useI18n().language();
  const [snap, setSnap] = useState<ProtocolSessionSnapshot>(() => service.snapshot());
  const [feed, setFeed] = useState<ProtocolCommandFeedState>(() => service.feedSnapshot());
  const [request, setRequest] = useState<ReturnType<NonNullable<ProtocolService["currentRequest"]>>>(() =>
    service.currentRequest()
  );
  const [originSettingsOpen, setOriginSettingsOpen] = useState(false);
  const [confirmDeadlineMs, setConfirmDeadlineMs] = useState<number | null>(() =>
    service.confirmDeadlineMs()
  );
  const feedTopRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    console.info("[protocol-popup] mounted", {
      pathname: window.location.pathname,
      hasOpener: Boolean(window.opener)
    });
  }, []);

  // 挂载时先装 message 监听，再启动会话；卸载时反向拆。
  //
  // 时序约束（施工单 001 公共语义）：
  //   `ready` 必须只在 popup 监听安装完成后发出。否则 opener 收到 `ready`
  //   立刻回 `request` 时，popup 还没开始监听，首条请求会丢。
  //   因此这里坚持 "addEventListener → service.startSession()" 的顺序，
  //   绝不能在监听未挂好前先 startSession（startSession 内部会立刻发 ready）。
  useEffect(() => {
    const offSnap = service.subscribe((next) => {
      console.debug("[protocol-popup] snapshot", {
        phase: next.phase,
        method: next.method,
        requestId: next.requestId,
        boundOrigin: next.boundOrigin
      });
      setSnap(next);
      setRequest(service.currentRequest());
      setConfirmDeadlineMs(service.confirmDeadlineMs());
    });
    const offFeed = service.subscribeFeed((next) => {
      console.debug("[protocol-popup] feed", {
        currentOrigin: next.currentOrigin,
        commandCount: next.commands.length,
        historyAvailable: next.historyAvailable
      });
      setFeed(next);
    });
    function onMessage(event: MessageEvent) {
      console.debug("[protocol-popup] message", {
        origin: event.origin,
        hasSource: Boolean(event.source),
        dataType: event.data && typeof event.data === "object" ? (event.data as { type?: unknown }).type : typeof event.data
      });
      service.handleMessage(event);
    }
    // 卸载 / 手工关闭 / 刷新路径上 best-effort 触发 `closing`，
    // service 内部走幂等门禁。
    function onPageHide() {
      console.info("[protocol-popup] pagehide -> best-effort closing");
      service.pageUnloading?.();
    }
    function onBeforeUnload() {
      console.info("[protocol-popup] beforeunload -> best-effort closing");
      service.pageUnloading?.();
    }
    // 1. 先装 message 监听，再装 pagehide / beforeunload。
    window.addEventListener("message", onMessage);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    // 2. 监听装好后再启动会话：startSession 内部会立刻 post `ready`，
    //    现在 opener 收到的任何 `request` 都能被本监听捕获。
    service.startSession();
    return () => {
      console.info("[protocol-popup] unmount");
      window.removeEventListener("message", onMessage);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
      offSnap();
      offFeed();
      service.endSession();
    };
  }, [service]);

  // 倒计时：只要 confirmDeadlineMs 非 null，就每秒触发一次 re-render 让
  // UI 重新算"剩余秒数"。setInterval 仅用于 re-render 触发，**不**用作
  // 超时触发器——超时真值在 service 内部用 wall-clock 比较 deadline。
  useEffect(() => {
    if (confirmDeadlineMs === null) return;
    const id = setInterval(() => {
      setConfirmDeadlineMs(service.confirmDeadlineMs());
    }, 1000);
    return () => clearInterval(id);
  }, [confirmDeadlineMs, service]);

  // 新命令出现时自动滚回顶部。jsdom 不支持 scrollIntoView；显式检测
  // 后再调，避免单测报 `scrollIntoView is not a function`。
  useEffect(() => {
    const el = feedTopRef.current;
    if (!el) return;
    const maybeScroll = (el as HTMLElement & { scrollIntoView?: (opts?: ScrollIntoViewOptions) => void })
      .scrollIntoView;
    if (typeof maybeScroll === "function") {
      maybeScroll.call(el, { behavior: "smooth", block: "start" });
    }
  }, [feed.commands.length, feed.currentOrigin]);

  // 计算剩余秒数。clamp 到 >= 0；deadline 已过但 service 还在做 timeout
  // 收尾的窗口期内 UI 仍能稳定显示 0。
  const remainingSeconds = useMemo(() => {
    if (confirmDeadlineMs === null) return null;
    return Math.max(0, Math.ceil((confirmDeadlineMs - Date.now()) / 1000));
  }, [confirmDeadlineMs]);

  return (
    <div className="protocol-popup">
      <div className="protocol-popup__topbar" ref={feedTopRef}>
        <span className="protocol-popup__topbar-item protocol-popup__topbar-item--origin">
          <strong>{t("protocol.topbar.origin", { defaultValue: "当前站点" })}:</strong>{" "}
          <code>{feed.currentOrigin ?? t("protocol.topbar.origin.none", { defaultValue: "未绑定" })}</code>
        </span>
        <span className="protocol-popup__topbar-spacer" />
        {/* ============== 施工单 001：钱包入口（独立新窗口跳转，不破坏 popup 会话） ============== */}
        <button
          type="button"
          className="protocol-popup__back-top"
          onClick={openWalletHomepage}
        >
          {t("protocol.topbar.wallet", { defaultValue: "进入钱包" })}
        </button>
        <button
          type="button"
          className="protocol-popup__back-top"
          disabled={!feed.currentOrigin}
          onClick={() => setOriginSettingsOpen((v) => !v)}
          aria-expanded={originSettingsOpen}
        >
          {t("protocol.topbar.originSettings", { defaultValue: "站点配置" })}
        </button>
        <button
          type="button"
          className="protocol-popup__back-top"
          onClick={() => {
            const el = feedTopRef.current;
            if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
        >
          {t("protocol.topbar.backToTop", { defaultValue: "回到最新" })}
        </button>
        <button
          type="button"
          className="protocol-popup__back-top"
          onClick={() => {
            service.pageUnloading?.();
            window.close();
          }}
        >
          {t("protocol.topbar.close", { defaultValue: "关闭" })}
        </button>
      </div>
      {originSettingsOpen && feed.currentOrigin ? (
        <OriginSettingsTrayInline
          origin={feed.currentOrigin}
          onClose={() => setOriginSettingsOpen(false)}
        />
      ) : null}
      <div className="protocol-popup__content">
        {snap.phase === "error" ? <SessionErrorBanner t={t} /> : null}
        <ProtocolCommandFeed
          t={t}
          feed={feed}
          service={service}
          snap={snap}
          request={request}
          remainingSeconds={remainingSeconds}
        />
      </div>
    </div>
  );
}

/* ============== 会话级错误（不属于"当前请求" overlay） ============== */

/**
 * popup 启动时如果 opener 缺失 / 不可用，service 会把 phase 推到 `error`。
 * 这不是某条 request 的错误，而是 session 级错误。
 *
 * 施工单 003 收口：popup 主体**不再保留**独立的"当前请求全页 overlay"，
 * 但 session-level 错误与 request-level 错误是两件事。本组件只是 feed
 * 上方一个紧凑的 banner，**不**是全页遮罩。
 */
function SessionErrorBanner({
  t
}: {
  t: (k: string, v?: { defaultValue?: string }) => string;
}) {
  return (
    <div className="protocol-popup__session-error" role="alert">
      {t("protocol.sessionError.banner", {
        defaultValue: "无法连接到外部站点。请回到来源站点查看控制台日志。"
      })}
    </div>
  );
}