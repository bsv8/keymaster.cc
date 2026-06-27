// packages/plugin-protocol/src/ProtocolPopupPage.tsx
// 对外协议 popup 页面。
//
// 设计缘由（施工单 2026-06-27 001 硬切换：锁屏 + 多 request 并存 + 全局
// 串行执行）：
//   - 锁屏仍是全页面：vault 处于 locked 时**只**渲染锁屏页（解锁表单 +
//     待处理概要），不渲染主 popup 页面 / 命令流 / 顶栏。
//   - unlocked 后才进入主 popup 页面（顶栏 + 站点配置 + 命令流）。
//   - 多 request 并存：每条 request 独立卡片；每张卡片内部按自己 recordId
//     渲染 confirm / cancel / 倒计时。
//   - 命令流不再是"全局当前 request"——任意多张 `confirming` / `queued` /
//     `executing` 卡片可同时存在；UI 不依赖 `snap.phase`。
//   - 页面只负责渲染态 + 转交用户操作给 service；密码学 / message 收发
//     / 校验 / 签名 / 加解密一律不进组件。
//   - 顶栏 sticky：当前 origin / 站点配置 / 关闭 / 回到最新 / 进入钱包。
//   - popup 是**会话级**长存：phase 回到 waiting 时不会自动关窗；
//     `closing` 由 pagehide / beforeunload 路径发出。
//   - 文案中文；错误 message 原样显示英文。

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@keymaster/runtime";
import type {
  MethodParams,
  ProtocolCommandFeedState,
  ProtocolCommandRecord,
  ProtocolLockSummary,
  ProtocolMethod,
  ProtocolService,
  ProtocolSessionSnapshot,
  VaultService
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
  const [originSettingsOpen, setOriginSettingsOpen] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());
  const feedTopRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    console.info("[protocol-popup] mounted", {
      pathname: window.location.pathname,
      hasOpener: Boolean(window.opener)
    });
  }, []);

  // 挂载时先装 message 监听，再启动会话；卸载时反向拆。
  useEffect(() => {
    const offSnap = service.subscribe((next) => {
      console.debug("[protocol-popup] snapshot", {
        phase: next.phase,
        method: next.method,
        requestId: next.requestId,
        boundOrigin: next.boundOrigin,
        lockState: next.lockState
      });
      setSnap(next);
    });
    const offFeed = service.subscribeFeed((next) => {
      console.debug("[protocol-popup] feed", {
        currentOrigin: next.currentOrigin,
        commandCount: next.commands.length,
        historyAvailable: next.historyAvailable,
        lockSummary: next.lockSummary
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
    function onPageHide() {
      console.info("[protocol-popup] pagehide -> best-effort closing");
      service.pageUnloading?.();
    }
    function onBeforeUnload() {
      console.info("[protocol-popup] beforeunload -> best-effort closing");
      service.pageUnloading?.();
    }
    window.addEventListener("message", onMessage);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onBeforeUnload);
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

  /**
   * vault 锁状态监听挂在父组件（施工单 2026-06-27 001 反馈修复）：
   *
   * 旧实现把监听放在 `LockScreenPage` 子组件里；解锁后切到主 popup 时
   * `LockScreenPage` 卸载 → 监听消失 → 主页面状态下重新锁定时
   * `setVaultLockState(true)` 不会再被调用 → `confirming -> waiting_unlock_manual`
   * 的硬收口不会发生，也不会切回全页面锁屏。
   *
   * 现在监听挂在 `ProtocolPopupPage`，跨越 locked / unlocked 视图切换仍生效。
   * LockScreenPage 里旧的 `useEffect(() => vault.onStatusChange(...))` 已
   * 删除（避免重复监听）。
   */
  useEffect(() => {
    const vault = (service as unknown as { getVaultService?: () => VaultService }).getVaultService?.();
    if (!vault) return;
    return vault.onStatusChange((s) => {
      if (s === "unlocked") {
        (service as unknown as { setVaultLockState?: (locked: boolean) => void }).setVaultLockState?.(false);
        void service.resumeAfterUnlock?.();
      } else if (s === "locked") {
        (service as unknown as { setVaultLockState?: (locked: boolean) => void }).setVaultLockState?.(true);
      }
    });
  }, [service]);

  // 倒计时：每秒触发一次 re-render，让确认卡内的"剩余秒数"自然滚动。
  // setInterval 仅用于 re-render 触发，**不**用作超时触发器——超时真值
  // 在 service 内部用 wall-clock 比较 deadline。
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

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

  // 锁屏态分支：locked 时直接渲染锁屏页（不渲染顶栏 / 站点配置 / 命令流）。
  if (snap.lockState === "locked") {
    return (
      <LockScreenPage
        t={t}
        service={service}
        summary={feed.lockSummary}
        now={now}
      />
    );
  }

  return (
    <div className="protocol-popup">
      <div className="protocol-popup__topbar" ref={feedTopRef}>
        <span className="protocol-popup__topbar-item protocol-popup__topbar-item--origin">
          <strong>{t("protocol.topbar.origin", { defaultValue: "当前站点" })}:</strong>{" "}
          <code>{feed.currentOrigin ?? t("protocol.topbar.origin.none", { defaultValue: "未绑定" })}</code>
        </span>
        <span className="protocol-popup__topbar-spacer" />
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
          now={now}
        />
      </div>
    </div>
  );
}

/* ============== 锁屏页（施工单 2026-06-27 001 硬切换：全页面锁屏） ============== */

/**
 * 全页面锁屏：解锁表单 + 待处理概要。
 *
 * 设计缘由：
 *   - 锁屏页**只**展示聚合信息（总数 / method 聚合 / 分类计数）。
 *   - 不允许直接对具体 request 点确认 / 取消。
 *   - 解锁成功后 service 自动批量推进所有 `waiting_unlock_*` request。
 *   - 不显示命令流；命令流真值保留在 service 内存里，解锁后主页面直接渲染。
 */
function LockScreenPage({
  t,
  service,
  summary,
  now
}: {
  t: (k: string, v?: { defaultValue?: string; seconds?: number }) => string;
  service: ProtocolService;
  summary: ProtocolLockSummary | null;
  now: number;
}) {
  const vault = useCapability<{
    status(): "booting" | "uninitialized" | "locked" | "unlocked";
    onStatusChange(handler: (s: "booting" | "uninitialized" | "locked" | "unlocked") => void): () => void;
    unlock(password: string): Promise<void>;
  }>("vault.service");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 关键：vault.onStatusChange 监听统一挂在父组件 `ProtocolPopupPage`，
  // 这里**不**再重复挂监听——否则会双调用 setVaultLockState / resumeAfterUnlock，
  // 旧实现下还会导致主页面状态下 relock 监听丢失。

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await vault.unlock(password);
      // resumeAfterUnlock 由父组件的 vault.onStatusChange 触发；这里不显式调。
    } catch (err) {
      setError(err instanceof Error ? err.message : t("protocol.unlock.err.failed", { defaultValue: "解锁失败" }));
    } finally {
      setBusy(false);
      setPassword("");
    }
  }

  const total = summary?.pendingTotal ?? 0;
  return (
    <div className="protocol-popup protocol-popup--locked">
      <div className="protocol-lockscreen">
        <header className="protocol-lockscreen__header">
          <h1 className="protocol-lockscreen__title">
            {t("protocol.lockscreen.title", { defaultValue: "解锁后继续" })}
          </h1>
          <p className="protocol-lockscreen__desc">
            {t("protocol.lockscreen.desc", {
              defaultValue:
                "Keymaster 正在锁定状态。当前站点已发出请求；解锁后会自动继续处理。"
            })}
          </p>
        </header>
        {summary ? (
          <LockSummaryView t={t} summary={summary} now={now} />
        ) : null}
        <form onSubmit={submit} className="protocol-popup__form protocol-lockscreen__form">
          <label className="origin-settings-panel__field">
            <span className="origin-settings-panel__field-label">
              {t("protocol.unlock.password", { defaultValue: "密码" })}
            </span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              style={{ padding: "0.4rem 0.55rem", border: "1px solid var(--border-card, #e4e4e7)", borderRadius: 4 }}
            />
          </label>
          {error ? (
            <div className="origin-settings-panel__error">
              <code>{error}</code>
            </div>
          ) : null}
          <div className="protocol-popup__actions">
            <button
              type="submit"
              className="protocol-popup__back-top"
              disabled={busy || !password}
            >
              {t("protocol.unlock.submit", { defaultValue: "解锁" })}
            </button>
          </div>
        </form>
        <p className="protocol-lockscreen__hint">
          {(() => {
            const fallback = `解锁后，${total} 条待处理请求会自动进入确认 / 执行流程。`;
            // i18n mock 不识别 `total` 字段；模板里有 {{total}} 占位符时
            // 通过 defaultValue 注入数字（mock 的 t 会用 defaultValue）。
            return t("protocol.lockscreen.unlockHint", {
              defaultValue: fallback
            });
          })()}
        </p>
      </div>
    </div>
  );
}

/**
 * 锁屏页的待处理概要视图。从 `ProtocolLockSummary` 派生展示。
 */
function LockSummaryView({
  t,
  summary,
  now
}: {
  t: (k: string, v?: { defaultValue?: string; seconds?: number }) => string;
  summary: ProtocolLockSummary;
  now: number;
}) {
  void now;
  return (
    <div className="protocol-lockscreen__summary" role="region" aria-label="待处理概要">
      <div className="protocol-lockscreen__summary-total">
        <strong>{summary.pendingTotal}</strong>{" "}
        <span>{t("protocol.lockscreen.pendingTotal", { defaultValue: "条待处理" })}</span>
      </div>
      <ul className="protocol-lockscreen__summary-list">
        <li>
          {t("protocol.lockscreen.manual", { defaultValue: "待解锁后人工确认" })}：{" "}
          <code>{summary.waitingUnlockManual}</code>
        </li>
        <li>
          {t("protocol.lockscreen.auto", { defaultValue: "解锁后自动执行" })}：{" "}
          <code>{summary.waitingUnlockAuto}</code>
        </li>
        <li>
          {t("protocol.lockscreen.queued", { defaultValue: "已确认待执行" })}：{" "}
          <code>{summary.queued}</code>
        </li>
        <li>
          {t("protocol.lockscreen.executing", { defaultValue: "执行中" })}：{" "}
          <code>{summary.executing}</code>
        </li>
      </ul>
      {summary.byMethod.length > 0 ? (
        <div className="protocol-lockscreen__summary-methods">
          <h2 className="protocol-lockscreen__summary-methods-title">
            {t("protocol.lockscreen.byMethod", { defaultValue: "按 method 聚合" })}
          </h2>
          <ul className="protocol-lockscreen__summary-methods-list">
            {summary.byMethod.map((m) => (
              <li key={m.method}>
                <code>{m.method}</code> × <code>{m.count}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/* ============== 会话级错误（不属于"当前请求" overlay） ============== */

/**
 * popup 启动时如果 opener 缺失 / 不可用，service 会把 phase 推到 `error`。
 * 这不是某条 request 的错误，而是 session 级错误。
 *
 * 本组件只是 feed 上方一个紧凑的 banner，**不**是全页遮罩。
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