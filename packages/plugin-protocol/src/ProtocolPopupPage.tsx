// packages/plugin-protocol/src/ProtocolPopupPage.tsx
// 对外协议 popup 页面。
//
// 设计缘由（施工单 2026-06-27 001 硬切换：锁屏 + 多 request 并存 + 全局
// 串行执行 + 施工单 2026-06-27 002 硬切换：活请求区固定槽位 +
// 历史区分离 + 同类请求不复用卡位）：
//   - 锁屏仍是全页面：vault 处于 locked 时**只**渲染锁屏页（解锁表单 +
//     待处理概要），不渲染主 popup 页面 / 命令流 / 顶栏。
//   - unlocked 后才进入主 popup 页面（顶栏 + 站点配置 + 命令流）。
//   - 多 request 并存：每条 request 独立卡片；每张卡片内部按自己 recordId
//     渲染 confirm / cancel / 倒计时。
//   - 命令流不再是"全局当前 request"——任意多张 `confirming` / `queued` /
//     `executing` 卡片可同时存在；UI 不依赖 `snap.phase`。
//   - **002 硬切换**：命令流由 service 投影为"活请求区 + 历史区"两段
//     （活请求按 createdAt asc，历史按 updatedAt desc）；UI 渲染交给
//     `ProtocolCommandFeed`，本页面**不**再做排序 / 不做 i===0 默认展开。
//   - **002 硬切换**：顶栏"回到最新"按钮滚到活请求区标题锚点
//     `#protocol-feed-live-top`，不再盲目按总条数滚。
//   - 页面只负责渲染态 + 转交用户操作给 service；密码学 / message 收发
//     / 校验 / 签名 / 加解密一律不进组件。
//   - 顶栏 sticky：当前 origin / 站点配置 / 关闭 / 回到最新 / 进入钱包。
//   - popup 是**会话级**长存：phase 回到 waiting 时不会自动关窗；
//     `closing` 由 pagehide / beforeunload 路径发出。
//   - 文案中文；错误 message 原样显示英文。

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@keymaster/runtime";
import type {
  ProtocolConnectAuthSnapshot,
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
  const auth = service.connectAuthSnapshot();

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
    // 施工单 2026-06-29 001 硬切换：appView mode 下挂一次性 bootstrap listener。
    // listener 内部幂等：第二次调用直接忽略；endSession 时由 service 内部清。
    if (service.bootMode() === "appView") {
      service.awaitLauncherBootstrap();
    }
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
        if (!service.connectAuthSnapshot()) {
          void service.resumeAfterUnlock?.();
        }
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

  // 新命令出现时自动滚回活请求区顶部（施工单 2026-06-27 002 硬切换）。
  // jsdom 不支持 scrollIntoView；显式检测后再调，避免单测报
  // `scrollIntoView is not a function`。
  useEffect(() => {
    const anchor = document.getElementById("protocol-feed-live-top");
    if (!anchor) return;
    const maybeScroll = (anchor as HTMLElement & { scrollIntoView?: (opts?: ScrollIntoViewOptions) => void })
      .scrollIntoView;
    if (typeof maybeScroll === "function") {
      maybeScroll.call(anchor, { behavior: "smooth", block: "start" });
    }
  }, [feed.commands.length, feed.currentOrigin]);

  // auth owner 优先级高于主页面；无 auth owner 才回到锁屏 / 主页面。
  if (auth?.ownerType === "login") {
    return (
      <ConnectLoginAuthPage
        t={t}
        service={service}
        auth={auth}
      />
    );
  }
  if (auth?.ownerType === "resume") {
    return (
      <ConnectResumeAuthPage
        t={t}
        service={service}
        auth={auth}
      />
    );
  }
  // 施工单 2026-06-29 001 硬切换：appView mode 下 Session Window 在 bootstrap
  // 完成前先渲染"等待 launcher"壳层；bootstrap 成功后渲染 app show 页面，
  // 由用户手动点击打开 app。失败则渲染错误态（fail-closed）。
  // 这些壳层**只**在 appView mode 下出现；connect mode 永不渲染。
  if (service.bootMode() === "appView") {
    // 修复 issue #3：bootstrap 失败时显式渲染错误页，**不**继续等。
    if (service.bootstrapFailed()) {
      return (
        <AppViewBootstrapFailedPage
          t={t}
          reason={service.bootstrapFailureReason()}
        />
      );
    }
    const appViewContext = service.appViewContext();
    if (!appViewContext) {
      return (
        <AppViewBootstrapWaitPage t={t} />
      );
    }
    return (
      <AppViewBootstrapDonePage
        t={t}
        service={service}
        appId={appViewContext.appId}
      />
    );
  }
  // 锁屏态分支：locked 且没有 auth owner 时直接渲染锁屏页（不渲染顶栏 / 站点配置 / 命令流）。
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
            // 施工单 2026-06-27 002 硬切换：滚到活请求区顶部锚点；
            // 若活请求区为空（只有历史），则退回到顶部。
            const liveAnchor = document.getElementById("protocol-feed-live-top");
            const target: HTMLElement | null = liveAnchor ?? feedTopRef.current;
            if (target) {
              const maybeScroll = (target as HTMLElement & { scrollIntoView?: (opts?: ScrollIntoViewOptions) => void })
                .scrollIntoView;
              if (typeof maybeScroll === "function") {
                maybeScroll.call(target, { behavior: "smooth", block: "start" });
              }
            }
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

/* ============== Session Window appView 启动期壳层（施工单 2026-06-29 001） ============== */

/**
 * appView mode 下 Session Window 在 bootstrap 完成前的等待页。
 *
 * 设计缘由（施工单 2026-06-29 001 硬切换）：
 *   - 这个页面只渲染"等待 launcher"壳层；不渲染主 popup 顶栏 / 命令流。
 *   - 当 launcher 在 bootstrap 完成前关闭 / 刷新时，Session Window 仍
 *     停在这页：用户可以关闭本窗口重新从 launcher 启动 app。
 *   - 不主动探测 launcher；Session Window 由 `awaitLauncherBootstrap`
 *     内部**主动**从同源 `window.opener` 拉取 capsule
 *     （`consumeLauncherBootstrap()`），超时则走 `bootstrapFailed` 错误页。
 */
function AppViewBootstrapWaitPage({
  t
}: {
  t: (k: string, v?: { defaultValue?: string }) => string;
}) {
  return (
    <div className="protocol-popup protocol-popup--appview-wait" data-testid="appview-wait">
      <div className="protocol-popup__panel">
        <h2>
          {t("protocol.sessionWindow.appView.waiting.title", {
            defaultValue: "Waiting for launcher"
          })}
        </h2>
        <p>
          {t("protocol.sessionWindow.appView.waiting.desc", {
            defaultValue:
              "Keymaster is starting this app. Keep this window open — it will hand off the session to the app."
          })}
        </p>
      </div>
    </div>
  );
}

/**
 * appView mode 下 Session Window bootstrap 完成后的 app show 页面。
 *
 * 设计缘由：
 *   - Session Window 是常驻控制窗口，不再 bootstrap 完成后自动 open
 *     app；避免它退化成一次性跳板页。
 *   - 用户明确点击大按钮后才调用 `service.openClientApp()`；这样 launcher
 *     不被打断，Session Window 也能稳定停留。
 *   - `openClientApp()` 失败时仅在本页显示简短错误，不补复杂恢复逻辑。
 *   - `Open App` 后若 5s 内仍未收到 child app 第一条合法 request，
 *     本页显示软超时提示；迟到连接到来后提示自动消失。
 */
function AppViewBootstrapDonePage({
  t,
  service,
  appId
}: {
  t: (k: string, v?: { defaultValue?: string }) => string;
  service: ProtocolService;
  appId: string;
}) {
  const [openError, setOpenError] = useState<string | null>(null);
  const connectTimedOut = service.appClientConnectTimedOut();

  function handleOpenApp() {
    setOpenError(null);
    try {
      const opened = service.openClientApp();
      if (!opened) {
        setOpenError("Failed to open the app window.");
      }
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : "Failed to open the app window.");
    }
  }

  return (
    <div className="protocol-popup protocol-popup--appview-done" data-testid="appview-done">
      <div className="protocol-popup__panel">
        <h2>
          {t("protocol.sessionWindow.title", { defaultValue: "Session Window" })}
        </h2>
        <p>
          {t("protocol.sessionWindow.appView.ready", {
            defaultValue: "Session ready. Open the app when you want."
          })}
        </p>
        <button
          type="button"
          className="protocol-popup__open-app-button"
          data-testid="appview-open-app"
          onClick={handleOpenApp}
        >
          {t("protocol.sessionWindow.appView.openApp", {
            defaultValue: "Open App"
          })}
        </button>
        {openError ? (
          <p className="protocol-popup__appview-error" data-testid="appview-open-app-error">
            <code>{openError}</code>
          </p>
        ) : null}
        {connectTimedOut ? (
          <p className="protocol-popup__appview-error" data-testid="appview-open-app-timeout">
            <code>
              {t("protocol.sessionWindow.appView.connectTimeout.soft", {
                defaultValue:
                  "The app has not connected to this Session Window within 5 seconds after Open App. You can keep this window open and wait, or click Open App again."
              })}
            </code>
          </p>
        ) : null}
        <p className="protocol-popup__muted">{appId}</p>
      </div>
    </div>
  );
}

/**
 * appView mode 下 bootstrap 失败的错误页（修复 issue #3）。
 *
 * 设计缘由：
 *   - 旧实现失败 / 超时永远停在"等待 launcher"——用户看到的是"卡死"。
 *   - 新实现：launcher 在合理时间（如 30s）内未发 bootstrap / payload
 *     不合法 / owner runtime bootstrap 校验失败 → 立即渲染此错误页；
 *     用户可以关闭 Session Window 重新从 Keymaster 应用商店启动 app。
 *   - 错误文案按 `reason` 区分大致类别（owner runtime 缺失 / 与
 *     session 不匹配 / payload 不合法 / 其它）；详细本地 reason
 *     不暴露给用户，避免泄漏内部细节。
 *   - 施工单 2026-06-30 002 硬切换：appView mode 不再"导入 unlock
 *     runtime"；bootstrap 失败主要落在 owner runtime bootstrap 校验
 *     （hex 与 ownerPublicKeyHex 不一致 / bootstrap 缺失）。
 */
function AppViewBootstrapFailedPage({
  t,
  reason
}: {
  t: (k: string, v?: { defaultValue?: string }) => string;
  reason: string | null;
}) {
  // reason 取值约定（protocol.service 内部定）：
  //   - bootstrap_payload_invalid
  //   - bootstrap_owner_runtime_missing
  //   - bootstrap_owner_runtime_invalid
  //   - bootstrap_owner_runtime_pubkey_mismatch
  //   - bootstrap_token_missing / launcher_*
  //   - 其它：兜底"could not start the app"
  let titleKey =
    "protocol.sessionWindow.appView.failed.title";
  let descKey =
    "protocol.sessionWindow.appView.failed.desc";
  if (reason === "bootstrap_owner_runtime_missing") {
    titleKey = "protocol.sessionWindow.appView.ownerRuntimeMissing.title";
    descKey = "protocol.sessionWindow.appView.ownerRuntimeMissing.desc";
  } else if (
    reason === "bootstrap_owner_runtime_invalid" ||
    reason === "bootstrap_owner_runtime_pubkey_mismatch"
  ) {
    titleKey = "protocol.sessionWindow.appView.ownerRuntimeMismatch.title";
    descKey = "protocol.sessionWindow.appView.ownerRuntimeMismatch.desc";
  }
  return (
    <div
      className="protocol-popup protocol-popup--appview-failed"
      data-testid="appview-failed"
    >
      <div className="protocol-popup__panel">
        <h2>
          {t(titleKey, {
            defaultValue: "Could not start the app"
          })}
        </h2>
        <p>
          {t(descKey, {
            defaultValue:
              "Launcher failed to hand off the session. Please try starting the app again from the Keymaster app store."
          })}
        </p>
        {reason ? (
          <p className="protocol-popup__muted" data-testid="appview-failed-reason">
            {reason}
          </p>
        ) : null}
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

/* ============== 施工单 2026-06-28 001：connect 视图（login / resume / logout） ============== */

/**
 * `connect.login` 视图（5.5.1）。
 *
 * 用途：用户首次登录时显式选择 key。
 * 渲染条件：当前 popup 文档 unlocked + 存在 connect.login request 处于
 * `confirming` 阶段。
 */
function ConnectLoginView({
  t,
  service,
  recordId,
  availableKeys
}: {
  t: (k: string, v?: { defaultValue?: string }) => string;
  service: ProtocolService;
  recordId: string;
  availableKeys: Array<{ publicKeyHex: string; label: string }>;
}) {
  // 受控：用户当前选中的 key publicKeyHex（不写入 rec，由 confirm 时一次性传）。
  const [selected, setSelected] = useState<string>("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || busy) return;
    setBusy(true);
    try {
      await service.confirmConnectLogin(recordId, selected, "");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="protocol-connect protocol-connect--login" aria-label="connect login">
      <header className="protocol-connect__header">
        <h2 className="protocol-connect__title">
          {t("protocol.connect.login.title", { defaultValue: "选择登录身份" })}
        </h2>
        <p className="protocol-connect__desc">
          {t("protocol.connect.login.desc", {
            defaultValue:
              "该站点请求建立 connect 会话。请选择一把 key 作为本次会话的绑定身份；后续所有外部业务方法（identity.get / intent.sign / cipher.encrypt / cipher.decrypt / p2pkh.transfer / feepool.prepare / feepool.commit）都将只走这把 key，不再读取全局 active key。"
          })}
        </p>
      </header>
      <form onSubmit={submit} className="protocol-connect__form">
        {availableKeys.length === 0 ? (
          <div className="protocol-connect__empty">
            {t("protocol.connect.login.empty", {
              defaultValue:
                "当前钱包没有 ready 的 key。请先回到 Keymaster 创建或导入一把 key。"
            })}
          </div>
        ) : (
          <ul className="protocol-connect__keylist" role="radiogroup">
            {availableKeys.map((k) => {
              const checked = selected === k.publicKeyHex;
              return (
                <li key={k.publicKeyHex} className="protocol-connect__keyitem">
                  <label className="protocol-connect__keylabel">
                    <input
                      type="radio"
                      name="connect-login-key"
                      value={k.publicKeyHex}
                      checked={checked}
                      disabled={busy}
                      onChange={(e) => setSelected(e.currentTarget.value)}
                    />
                    <span className="protocol-connect__keylabel-text">{k.label}</span>
                    <code className="protocol-connect__keylabel-hex">
                      {k.publicKeyHex.slice(0, 8)}…{k.publicKeyHex.slice(-6)}
                    </code>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <div className="protocol-popup__actions">
          <button
            type="button"
            className="protocol-popup__back-top"
            disabled={busy}
            onClick={() => {
              void service.rejectConnectRequest(recordId);
            }}
          >
            {t("protocol.connect.cancel", { defaultValue: "取消" })}
          </button>
          <button
            type="submit"
            className="protocol-popup__back-top protocol-popup__back-top--primary"
            disabled={busy || !selected || availableKeys.length === 0}
          >
            {t("protocol.connect.login.confirm", { defaultValue: "用此 key 登录" })}
          </button>
        </div>
      </form>
    </section>
  );
}

/**
 * `connect.logout` 视图（5.5.3）。
 *
 * 用途：caller 主动注销。
 * 行为：
 *   - unlocked 路径**不**弹额外 UI（直接执行）；
 *   - 本组件是兜底：万一 service 把 connect.logout 推到 confirming（locked 路径解锁后），
 *     仍能正常完成收口。
 */
function ConnectLogoutView({
  t,
  service,
  recordId
}: {
  t: (k: string, v?: { defaultValue?: string }) => string;
  service: ProtocolService;
  recordId: string;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <section className="protocol-connect protocol-connect--logout" aria-label="connect logout">
      <header className="protocol-connect__header">
        <h2 className="protocol-connect__title">
          {t("protocol.connect.logout.title", { defaultValue: "注销 connect 会话" })}
        </h2>
        <p className="protocol-connect__desc">
          {t("protocol.connect.logout.desc", {
            defaultValue:
              "该站点请求注销本次 connect 会话。注销后该 sessionId 的 resume / cipher 将全部失败，需要重新 login。"
          })}
        </p>
      </header>
      <div className="protocol-popup__actions">
        <button
          type="button"
          className="protocol-popup__back-top"
          disabled={busy}
          onClick={() => {
            void service.rejectConnectRequest(recordId);
          }}
        >
          {t("protocol.connect.cancel", { defaultValue: "取消" })}
        </button>
        <button
          type="button"
          className="protocol-popup__back-top protocol-popup__back-top--primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              // 走 cancel 路径：caller 已经发了 logout，再次点确认应当
              // 让 service 主动 confirm（解锁后 service 直接走 queued
              // 不会到这里）。
              // 这里只兜底 reject；unlocked 时 service 已自行推进 executing。
              await service.rejectConnectRequest(recordId);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("protocol.connect.logout.confirm", { defaultValue: "确认注销" })}
        </button>
      </div>
    </section>
  );
}

/**
 * connect 视图容器：根据 service 当前状态渲染 login 视图（resume 不再需要
 * 确认视图，详见下文）。
 *
 * 设计缘由（施工单 2026-06-28 001 硬切换 + 反例反馈）：
 *   - connect.login：locked → waiting_unlock_manual；unlocked → confirming
 *     渲染"选 key + 确认"视图。
 *   - connect.resume：locked → waiting_unlock_manual；unlocked → 直接 queued
 *     → executing → approved（**不**经过 confirming UI）。这是施工单
 *     4.3 + 9.2/9.3 明确要求的"只补解锁，自动恢复"。resume UI 完全由锁屏
 *     页 + 锁屏摘要承担，unlocked 后**不**弹任何"恢复"按钮——避免
 *     误导用户再次确认。
 *   - connect.logout：unlocked → 直接 queued → executing；不弹 UI。
 *   - popup 顶部插入"connect 视图"区域（仅 login），**不**与命令流活卡
 *     合并——connect 视图是"会话级"语义，而命令流卡片是"单条 request"
 *     语义。两者并存，UI 不复用卡位。
 */
function ConnectSection({
  t,
  service,
  feed
}: {
  t: (k: string, v?: { defaultValue?: string }) => string;
  service: ProtocolService;
  feed: ProtocolCommandFeedState;
}) {
  // 仅在 unlocked 状态下显示 connect 视图；锁屏时走 LockScreenPage。
  if (feed.lockSummary !== null) return null;

  // connect.login：进入 confirming 后渲染"选 key"视图。
  const login = service.connectLoginRecord();
  if (login) {
    return (
      <ConnectLoginView
        t={t}
        service={service}
        recordId={login.recordId}
        availableKeys={login.availableKeys}
      />
    );
  }
  // connect.resume：unlocked 后不渲染任何视图；service 已直接执行。
  // 该 record 会进入历史区作为终态卡片，UI 自然能看到结果。
  // connect.logout：兜底视图，仅当 service 把 logout 推到 confirming 时
  // 才出现（unlocked 路径下不会出现）。
  const logoutRecordId = pickConfirmingConnectRecordId(service, "connect.logout");
  if (logoutRecordId) {
    return (
      <ConnectLogoutView
        t={t}
        service={service}
        recordId={logoutRecordId}
      />
    );
  }
  return null;
}

/**
 * 兜底 helper：通过 `feedSnapshot().commands` 找当前是否存在某种
 * connect method 的 confirming record。connect.logout 在 unlocked 时**不**
 * 经过 confirming，所以通常返回 null；保留是为了 future-proof。
 */
function pickConfirmingConnectRecordId(service: ProtocolService, method: "connect.logout"): string | null {
  const feed = service.feedSnapshot();
  for (const c of feed.commands) {
    if (c.method === method && c.phase === "confirming" && c.decision === "pending") {
      return c.id;
    }
  }
  return null;
}

/* ============== 施工单 2026-06-28 003：auth owner 全屏页 ============== */

function ConnectLoginAuthPage({
  t,
  service,
  auth
}: {
  t: (k: string, v?: { defaultValue?: string }) => string;
  service: ProtocolService;
  auth: ProtocolConnectAuthSnapshot;
}) {
  const login = auth.login;
  const [selected, setSelected] = useState<string>("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !login || !selected || !password || !auth.canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await service.confirmConnectLogin(auth.recordId!, selected, password);
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="protocol-auth protocol-auth--login">
      <section className="protocol-auth__panel">
        <header className="protocol-auth__header">
          <p className="protocol-auth__eyebrow">
            {t("protocol.auth.login.eyebrow", { defaultValue: "重新认证" })}
          </p>
          <h1 className="protocol-auth__title">
            {t("protocol.connect.login.title", { defaultValue: "重新登录并建立新会话" })}
          </h1>
          <p className="protocol-auth__desc">
            {t("protocol.connect.login.desc", {
              defaultValue:
                "该站点请求重新认证。请选择一把 key，并再次输入密码。成功后会创建新的 connect session，并吊销同 origin 的旧 session。"
            })}
          </p>
        </header>
        <form onSubmit={submit} className="protocol-auth__form">
          {login && login.availableKeys.length > 0 ? (
            <ul className="protocol-connect__keylist" role="radiogroup" aria-label="connect login keys">
              {login.availableKeys.map((k) => {
                const checked = selected === k.publicKeyHex;
                return (
                  <li key={k.publicKeyHex} className="protocol-connect__keyitem">
                    <label className="protocol-connect__keylabel">
                      <input
                        type="radio"
                        name="connect-login-key"
                        value={k.publicKeyHex}
                        checked={checked}
                        disabled={busy || auth.submitted}
                        onChange={(e) => setSelected(e.currentTarget.value)}
                      />
                      <span className="protocol-connect__keylabel-text">{k.label}</span>
                      <code className="protocol-connect__keylabel-hex">
                        {k.publicKeyHex.slice(0, 8)}…{k.publicKeyHex.slice(-6)}
                      </code>
                    </label>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="protocol-connect__empty">
              {t("protocol.connect.login.empty", {
                defaultValue: "当前钱包没有 ready 的 key。请先回到 Keymaster 创建或导入一把 key。"
              })}
            </div>
          )}
          <label className="protocol-auth__password">
            <span className="protocol-auth__label">
              {t("protocol.unlock.password", { defaultValue: "密码" })}
            </span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              disabled={busy || auth.submitted}
              onChange={(e) => setPassword(e.currentTarget.value)}
            />
          </label>
          {error ? (
            <div className="protocol-auth__error" role="alert">
              <code>{error}</code>
            </div>
          ) : null}
          <div className="protocol-popup__actions">
            <button
              type="button"
              className="protocol-popup__back-top"
              disabled={busy}
              onClick={() => {
                void service.rejectConnectRequest(auth.recordId!);
              }}
            >
              {t("protocol.connect.cancel", { defaultValue: "取消" })}
            </button>
            <button
              type="submit"
              className="protocol-popup__back-top protocol-popup__back-top--primary"
              disabled={busy || auth.submitted || !auth.canSubmit || !selected || !password}
            >
              {t("protocol.connect.login.confirm", {
                defaultValue: "重新认证并建立新会话"
              })}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function ConnectResumeAuthPage({
  t,
  service,
  auth
}: {
  t: (k: string, v?: { defaultValue?: string }) => string;
  service: ProtocolService;
  auth: ProtocolConnectAuthSnapshot;
}) {
  const resume = auth.resume;
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !resume || !password || !auth.canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await service.confirmConnectResume(auth.recordId!, password);
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Resume failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="protocol-auth protocol-auth--resume">
      <section className="protocol-auth__panel">
        <header className="protocol-auth__header">
          <p className="protocol-auth__eyebrow">
            {t("protocol.auth.resume.eyebrow", { defaultValue: "恢复会话" })}
          </p>
          <h1 className="protocol-auth__title">
            {t("protocol.connect.resume.title", { defaultValue: "恢复当前会话" })}
          </h1>
          <p className="protocol-auth__desc">
            {t("protocol.connect.resume.desc", {
              defaultValue:
                "该站点的 session 仍然有效。输入密码后即可恢复当前会话，不会重新选择 key。"
            })}
          </p>
        </header>
        {resume ? (
          <div className="protocol-auth__readonly">
            <span className="protocol-auth__label">
              {t("protocol.connect.resume.ownerLabel", { defaultValue: "绑定 key" })}
            </span>
            <div className="protocol-auth__readonly-value">
              <strong>{resume.ownerLabel}</strong>
              <code>
                {resume.ownerPublicKeyHex.slice(0, 8)}…{resume.ownerPublicKeyHex.slice(-6)}
              </code>
            </div>
          </div>
        ) : null}
        <form onSubmit={submit} className="protocol-auth__form">
          <label className="protocol-auth__password">
            <span className="protocol-auth__label">
              {t("protocol.unlock.password", { defaultValue: "密码" })}
            </span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              disabled={busy || auth.submitted}
              onChange={(e) => setPassword(e.currentTarget.value)}
            />
          </label>
          {error ? (
            <div className="protocol-auth__error" role="alert">
              <code>{error}</code>
            </div>
          ) : null}
          <div className="protocol-popup__actions">
            <button
              type="button"
              className="protocol-popup__back-top"
              disabled={busy}
              onClick={() => {
                void service.rejectConnectRequest(auth.recordId!);
              }}
            >
              {t("protocol.connect.cancel", { defaultValue: "取消" })}
            </button>
            <button
              type="submit"
              className="protocol-popup__back-top protocol-popup__back-top--primary"
              disabled={busy || auth.submitted || !auth.canSubmit || !password}
            >
              {t("protocol.connect.resume.confirm", { defaultValue: "恢复当前会话" })}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
