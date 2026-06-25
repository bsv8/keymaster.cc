// packages/plugin-protocol/src/ProtocolPopupPage.tsx
// 对外协议 popup 页面。
//
// 设计缘由（施工单 002 硬切换：popup 复用与命令流 + p2pkh/feepool）：
//   - 页面只负责渲染态 + 转交用户操作给 service；密码学 / message 收发
//     / 校验 / 签名 / 加解密一律不进组件。
//   - 页面挂载时 startSession() 一次；之后通过 subscribe 拿到 snapshot
//     驱动渲染。
//   - popup 是**会话级**长存：单条 request 完成后 phase 回到 waiting，
//     不会自动关窗；`closing` 由 pagehide / beforeunload 路径发出。
//   - 顶部 sticky 顶栏：当前 origin / 当前 phase / 站点配置按钮 / 关闭 / 回到最新。
//   - 中间是命令流 feed：最新命令展开，历史命令默认折叠。
//   - `confirming` / `unlocking` / `executing` 时当前请求以浮层形式出现
//     （feed 顶部占位）。`p2pkh.transfer` auto-approve 命中时不显示
//     ConfirmView（`currentRequestAutoApproved()` 为 true 时跳过 overlay）。
//   - 收到第一条 request 时按 exact origin 载入历史。
//   - 文案中文；错误 message 原样显示英文。

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, PageHeader, TextInput } from "@keymaster/ui";
import { useCapability, useI18n } from "@keymaster/runtime";
import type {
  CipherDecryptParams,
  CipherEncryptParams,
  FeepoolCommitParams,
  FeepoolPrepareParams,
  IdentityGetParams,
  IntentSignParams,
  MethodParams,
  P2pkhTransferParams,
  ProtocolCommandFeedState,
  ProtocolMethod,
  ProtocolService,
  ProtocolSessionSnapshot
} from "@keymaster/contracts";
import { PROTOCOL_SERVICE_CAPABILITY } from "@keymaster/contracts";
import { ProtocolCommandFeed } from "./ProtocolCommandFeed.js";
import { OriginSettingsTrayInline } from "./OriginSettingsTray.js";

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

  // p2pkh.transfer auto-approve 命中时 popup **不**显示 ConfirmView；
  // service 在 `tryAcceptFirstRequest` 里已经把 phase 推到 executing
  // 并启动内联执行；这里直接跳过 overlay，只让 feed 显示最新卡片。
  const showConfirmingOverlay =
    !service.currentRequestAutoApproved?.() &&
    (snap.phase === "confirming" || snap.phase === "unlocking" || snap.phase === "executing");

  return (
    <div className="protocol-popup">
      <div className="protocol-popup__topbar" ref={feedTopRef}>
        <span className="protocol-popup__topbar-item protocol-popup__topbar-item--origin">
          <strong>{t("protocol.topbar.origin", { defaultValue: "当前站点" })}:</strong>{" "}
          <code>{feed.currentOrigin ?? t("protocol.topbar.origin.none", { defaultValue: "未绑定" })}</code>
        </span>
        <span className="protocol-popup__topbar-item">
          <strong>{t("protocol.topbar.status", { defaultValue: "状态" })}:</strong>{" "}
          {phaseLabel(t, snap.phase)}
        </span>
        <span className="protocol-popup__topbar-spacer" />
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
        {snap.phase === "error" ? <ErrorView t={t} message={t("protocol.error")} /> : null}
        {showConfirmingOverlay ? (
          <CurrentRequestPanel t={t} service={service} snap={snap} request={request} />
        ) : null}
        <ProtocolCommandFeed t={t} feed={feed} />
      </div>
    </div>
  );
}

function phaseLabel(
  t: (k: string, v?: { defaultValue?: string }) => string,
  phase: ProtocolSessionSnapshot["phase"]
): string {
  switch (phase) {
    case "waiting":
      return t("protocol.phase.waiting", { defaultValue: "等待下一条请求" });
    case "unlocking":
      return t("protocol.phase.unlocking", { defaultValue: "等待解锁" });
    case "confirming":
      return t("protocol.phase.confirming", { defaultValue: "等待确认" });
    case "executing":
      return t("protocol.phase.executing", { defaultValue: "处理中" });
    case "closing":
      return t("protocol.phase.closing", { defaultValue: "收尾" });
    case "error":
      return t("protocol.phase.error", { defaultValue: "错误" });
  }
}

/* ============== 当前进行中的命令 ============== */

function CurrentRequestPanel({
  t,
  service,
  snap,
  request
}: {
  t: (k: string, v?: { defaultValue?: string }) => string;
  service: ProtocolService;
  snap: ProtocolSessionSnapshot;
  request: { id: string; method: ProtocolMethod; params: MethodParams<ProtocolMethod> } | null;
}) {
  if (snap.phase === "unlocking") {
    return <UnlockView t={t} service={service} />;
  }
  if (snap.phase === "executing") {
    return <ExecutingView t={t} />;
  }
  if (snap.phase === "closing") {
    return <DoneView t={t} />;
  }
  // confirming
  if (!request) {
    return null;
  }
  return <ConfirmView t={t} service={service} request={request} />;
}

function UnlockView({
  t,
  service
}: {
  t: (k: string, v?: { defaultValue?: string }) => string;
  service: ProtocolService;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const vault = useCapability<{
    status(): "booting" | "uninitialized" | "locked" | "unlocked";
    onStatusChange(handler: (s: "booting" | "uninitialized" | "locked" | "unlocked") => void): () => void;
    unlock(password: string): Promise<void>;
  }>("vault.service");
  useEffect(() => {
    return vault.onStatusChange((s) => {
      if (s === "unlocked") {
        (service as unknown as { resumeAfterUnlock?: () => void }).resumeAfterUnlock?.();
      }
    });
  }, [vault, service]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await vault.unlock(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("protocol.unlock.err.failed", { defaultValue: "解锁失败" }));
    } finally {
      setBusy(false);
      setPassword("");
    }
  }
  async function cancel() {
    await service.rejectByUser();
  }
  return (
    <div className="protocol-popup protocol-popup--unlock">
      <PageHeader
        title={t("protocol.unlock.title", { defaultValue: "解锁后继续" })}
        description={t("protocol.unlock.desc", {
          defaultValue: "此协议请求需要先解锁本地 Vault。解锁成功后请求会自动继续。"
        })}
      />
      <form onSubmit={submit} className="protocol-popup__form">
        <TextInput
          label={t("protocol.unlock.password", { defaultValue: "密码" })}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          error={error ?? undefined}
        />
        <div className="protocol-popup__actions">
          <Button type="submit" loading={busy} disabled={!password}>
            {t("protocol.unlock.submit", { defaultValue: "解锁" })}
          </Button>
          <Button variant="ghost" onClick={cancel} disabled={busy}>
            {t("protocol.unlock.cancel", { defaultValue: "取消" })}
          </Button>
        </div>
      </form>
    </div>
  );
}

function ConfirmView({
  t,
  service,
  request
}: {
  t: (k: string, v?: { defaultValue?: string }) => string;
  service: ProtocolService;
  request: { id: string; method: ProtocolMethod; params: MethodParams<ProtocolMethod> };
}) {
  const methodKey = `protocol.confirm.method.${request.method}`;
  const methodLabel = t(methodKey, { defaultValue: request.method });
  const identity = request.method === "identity.get" ? (request.params as IdentityGetParams) : null;
  const sign = request.method === "intent.sign" ? (request.params as IntentSignParams) : null;
  const enc = request.method === "cipher.encrypt" ? (request.params as CipherEncryptParams) : null;
  const dec = request.method === "cipher.decrypt" ? (request.params as CipherDecryptParams) : null;
  const p2pkh = request.method === "p2pkh.transfer" ? (request.params as P2pkhTransferParams) : null;
  const feepoolPrepare =
    request.method === "feepool.prepare" ? (request.params as FeepoolPrepareParams) : null;
  const feepoolCommit =
    request.method === "feepool.commit" ? (request.params as FeepoolCommitParams) : null;
  const aud = identity?.aud ?? sign?.aud ?? null;
  const text = identity?.text ?? sign?.text ?? enc?.text ?? dec?.text ?? "";
  const claims = identity?.claims ?? [];
  const iat = identity?.iat ?? sign?.iat;
  const exp = identity?.exp ?? sign?.exp;
  const contentType = sign?.contentType ?? enc?.contentType;
  const contentBytes =
    sign?.content?.bytes.byteLength ?? enc?.content?.bytes.byteLength ?? dec?.cipherbytes?.bytes.byteLength ?? 0;
  return (
    <div className="protocol-popup protocol-popup--confirm">
      <PageHeader
        title={t("protocol.confirm.title", { defaultValue: "确认请求" })}
        description={methodLabel}
      />
      <dl className="protocol-popup__list">
        {aud ? (
          <>
            <dt>{t("protocol.confirm.origin", { defaultValue: "来源站点" })}</dt>
            <dd>
              <code>{aud}</code>
            </dd>
          </>
        ) : null}
        {text ? (
          <>
            <dt>{t("protocol.confirm.text", { defaultValue: "提示文案" })}</dt>
            <dd>{text}</dd>
          </>
        ) : null}
        {claims.length > 0 ? (
          <>
            <dt>{t("protocol.confirm.claims", { defaultValue: "请求的 claims" })}</dt>
            <dd>
              <ul>
                {claims.map((c) => (
                  <li key={c}>
                    <code>{c}</code>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
        {contentType ? (
          <>
            <dt>{t("protocol.confirm.contentType", { defaultValue: "内容类型" })}</dt>
            <dd>
              <code>{contentType}</code>（{contentBytes} bytes）
            </dd>
          </>
        ) : null}
        {iat !== undefined && exp !== undefined ? (
          <>
            <dt>{t("protocol.confirm.window", { defaultValue: "有效期" })}</dt>
            <dd>
              <code>
                {iat} → {exp}
              </code>
            </dd>
          </>
        ) : null}
        {/* ============== 施工单 002 硬切换：p2pkh.transfer ============== */}
        {p2pkh ? (
          <>
            <dt>{t("protocol.confirm.p2pkh.recipient", { defaultValue: "收款地址" })}</dt>
            <dd>
              <code>{p2pkh.recipientAddress}</code>
            </dd>
            <dt>{t("protocol.confirm.p2pkh.amount", { defaultValue: "金额" })}</dt>
            <dd>
              <code>{p2pkh.amountSatoshis}</code> sats
            </dd>
            {p2pkh.feeRateSatoshisPerKb ? (
              <>
                <dt>{t("protocol.confirm.p2pkh.feeRate", { defaultValue: "费率 (sat/kB)" })}</dt>
                <dd>
                  <code>{p2pkh.feeRateSatoshisPerKb}</code>
                </dd>
              </>
            ) : null}
          </>
        ) : null}
        {/* ============== 施工单 002 硬切换：feepool.prepare ============== */}
        {feepoolPrepare ? (
          <>
            <dt>{t("protocol.confirm.feepool.counterparty", { defaultValue: "对端公钥" })}</dt>
            <dd>
              <code>{shortHex(feepoolPrepare.counterpartyPublicKeyHex, 12)}</code>
            </dd>
            <dt>{t("protocol.confirm.feepool.amount", { defaultValue: "金额" })}</dt>
            <dd>
              <code>{feepoolPrepare.amountSatoshis}</code> sats
            </dd>
          </>
        ) : null}
        {/* ============== 施工单 002 硬切换：feepool.commit ============== */}
        {feepoolCommit ? (
          <>
            <dt>{t("protocol.confirm.feepool.operationId", { defaultValue: "操作 id" })}</dt>
            <dd>
              <code>{feepoolCommit.operationId}</code>
            </dd>
            <dt>{t("protocol.confirm.feepool.counterparty", { defaultValue: "对端公钥" })}</dt>
            <dd>
              <code>{shortHex(feepoolCommit.counterpartyPublicKeyHex, 12)}</code>
            </dd>
          </>
        ) : null}
      </dl>
      <div className="protocol-popup__actions">
        <Button onClick={() => service.confirmByUser()}>
          {t("protocol.confirm.confirm", { defaultValue: "确认" })}
        </Button>
        <Button
          variant="ghost"
          onClick={async () => {
            await service.rejectByUser();
          }}
        >
          {t("protocol.confirm.cancel", { defaultValue: "取消" })}
        </Button>
      </div>
    </div>
  );
}

/** 截短 hex 显示（feepool 公钥 66 字符太长）。 */
function shortHex(hex: string, head: number): string {
  if (hex.length <= head * 2 + 3) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-head)}`;
}

function ExecutingView({ t }: { t: (k: string, v?: { defaultValue?: string }) => string }) {
  return (
    <div className="protocol-popup protocol-popup--executing">
      <PageHeader
        title={t("protocol.confirm.title", { defaultValue: "确认请求" })}
        description={t("protocol.executing", { defaultValue: "处理中…" })}
      />
    </div>
  );
}

function DoneView({ t }: { t: (k: string, v?: { defaultValue?: string }) => string }) {
  // 兼容旧 phase 名字的极端情形：当前 V1 不再进入 closing，
  // 但若以后 phase 名字又扩，这里仍允许渲染一个静态收尾提示。
  return (
    <div className="protocol-popup protocol-popup--done">
      <PageHeader
        title={t("protocol.done.title", { defaultValue: "结果已回传" })}
        description={t("protocol.done", { defaultValue: "请求已完成并回传给外部站点。" })}
      />
    </div>
  );
}

function ErrorView({ t, message }: { t: (k: string, v?: { defaultValue?: string }) => string; message: string }) {
  return (
    <div className="protocol-popup protocol-popup--error">
      <PageHeader
        title={t("protocol.error", { defaultValue: "请求失败" })}
        description={`${message}。请回到外部 demo 查看控制台日志，定位失败步骤。`}
      />
    </div>
  );
}
