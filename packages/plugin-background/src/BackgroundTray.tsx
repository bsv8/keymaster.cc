// packages/plugin-background/src/BackgroundTray.tsx
// Topbar 后台任务托盘。
// 设计缘由：托盘只显示通用任务信息，不出现 P2PKH 专属字段。
// 施工单 001：只渲染"立即同步一次"或"取消本次同步"，
// 没有暂停、继续、重试。失败不是稳态，显示为"上次同步失败"。

import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertCircle, CheckCircle2, Square, X, Zap } from "lucide-react";
import { useCapability, useI18n, useLocale } from "@keymaster/runtime";
import type { BackgroundService, BackgroundTaskSnapshot, BackgroundTaskState } from "@keymaster/contracts";

export function BackgroundTray() {
  const service = useCapability<BackgroundService>("background.service");
  const { t } = useI18n();
  useI18n().language();
  const locale = useLocale();
  const timeFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { timeStyle: "medium" }),
    [locale]
  );
  const [open, setOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<BackgroundTaskSnapshot[]>(service.listSnapshots());
  // runNow 跨 tab 会先转发给 leader；在收到新快照前给出明确反馈，避免
  // 用户把一次已经送出的点击误认为没有生效而重复点击。
  const pendingStartedAt = useRef(new Map<string, number>());
  const [pendingRunIds, setPendingRunIds] = useState<Set<string>>(() => new Set());
  const [commandError, setCommandError] = useState<string | null>(null);

  useEffect(() => {
    return service.onChange((s) => {
      setSnapshots(s);
      setPendingRunIds((previous) => {
        const next = new Set(previous);
        for (const id of previous) {
          const snapshot = s.find((item) => item.id === id);
          const requestedAt = pendingStartedAt.current.get(id);
          const attemptedAt = snapshot?.lastAttemptAt ? new Date(snapshot.lastAttemptAt).getTime() : 0;
          if (!snapshot || snapshot.state === "queued" || snapshot.state === "running" || snapshot.state === "blocked" || (requestedAt && attemptedAt >= requestedAt)) {
            next.delete(id);
            pendingStartedAt.current.delete(id);
          }
        }
        return next;
      });
    });
  }, [service]);

  const requestRunNow = (id: string) => {
    pendingStartedAt.current.set(id, Date.now());
    setPendingRunIds((previous) => new Set(previous).add(id));
    void service.runNow(id).then((result) => {
      if (result.status === "validation-error" || result.status === "error" || result.status === "transport-error") {
        setPendingRunIds((previous) => { const next = new Set(previous); next.delete(id); return next; });
        pendingStartedAt.current.delete(id);
        setCommandError("message" in result ? result.message : t("background.tray.requestFailed", { defaultValue: "请求失败，请稍后重试。" }));
      }
    });
  };

  const counts = useMemo(() => {
    let running = 0;
    let queued = 0;
    let blocked = 0;
    for (const s of snapshots) {
      if (s.state === "running") running++;
      else if (s.state === "queued") queued++;
      else if (s.state === "blocked") blocked++;
    }
    return { running, queued, blocked };
  }, [snapshots]);

  const trayLabel = t("background.topbar.label", { defaultValue: "后台任务" });

  return (
    <div className="background-tray">
      <button
        type="button"
        className={`background-tray__button ${counts.blocked > 0 ? "is-blocked" : counts.running > 0 ? "is-running" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-label={trayLabel}
        title={trayLabel}
      >
        <Activity size={16} />
        {counts.running > 0 ? <span className="background-tray__count">{counts.running}</span> : null}
        {counts.blocked > 0 ? <span className="background-tray__count background-tray__count--blocked">!</span> : null}
      </button>
      {open ? (
        <div className="background-tray__panel" role="dialog">
          <header className="background-tray__header">
            <h4>{t("background.tray.title", { defaultValue: "后台任务" })}</h4>
            <button
              type="button"
              className="background-tray__close"
              onClick={() => setOpen(false)}
              aria-label={t("background.tray.close", { defaultValue: "关闭" })}
            >
              <X size={14} />
            </button>
          </header>
          {commandError ? <p className="background-tray__error" role="status">{commandError}</p> : null}
          {snapshots.length === 0 ? (
            <p className="background-tray__empty">{t("background.tray.empty", { defaultValue: "没有已注册的后台任务。" })}</p>
          ) : (
            <ul className="background-tray__list">
              {snapshots.map((s) => (
                <li key={s.id} className={`background-tray__item is-${s.state}`}>
                  <div className="background-tray__item-head">
                    <span className="background-tray__name">{s.label}</span>
                    <StateBadge state={s.state} t={t} />
                  </div>
                  <TaskMeta s={s} timeFmt={timeFmt} t={t} />
                  <TaskActions s={s} service={service} pending={pendingRunIds.has(s.id)} onRunNow={requestRunNow} onCommandError={setCommandError} t={t} />
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 任务元信息：显示上次完成/尝试时间、下次自动尝试、错误信息。
 * 设计缘由：让用户理解任务状态，包括失败原因和下次尝试时间。
 */
function TaskMeta({
  s,
  timeFmt,
  t
}: {
  s: BackgroundTaskSnapshot;
  timeFmt: Intl.DateTimeFormat;
  t: (k: string, opts?: { defaultValue?: string }) => string;
}) {
  return (
    <>
      <p className="background-tray__meta">
        {s.lastCompletedAt
          ? `${t("background.tray.lastCompletePrefix", { defaultValue: "上次完成 " })}${timeFmt.format(new Date(s.lastCompletedAt))}`
          : s.lastAttemptAt
            ? `${t("background.tray.lastAttemptPrefix", { defaultValue: "上次尝试 " })}${timeFmt.format(new Date(s.lastAttemptAt))}`
            : t("background.tray.neverRun", { defaultValue: "尚未运行" })}
        {s.nextRunAt ? `${t("background.tray.nextPrefix", { defaultValue: " · 下次 " })}${timeFmt.format(new Date(s.nextRunAt))}` : ""}
      </p>
      {/* blocked 原因 */}
      {s.state === "blocked" && s.blockedReason ? (
        <p className="background-tray__blocked-reason">
          {typeof s.blockedReason === "string" ? s.blockedReason : s.blockedReason.fallback}
        </p>
      ) : null}
      {/* 上次错误信息 */}
      {s.error ? (
        <p className="background-tray__error">
          {t("background.tray.lastSyncFailed", { defaultValue: "上次同步失败：" })}{s.error}
        </p>
      ) : null}
    </>
  );
}

/**
 * 任务动作：只渲染"立即同步一次"或"取消本次同步"。
 * 设计缘由：施工单 001 要求托盘只暴露两个用户动作：
 * - idle/blocked: 立即同步一次
 * - running/queued: 取消本次同步
 * 没有暂停、继续、重试。
 */
function TaskActions({
  s,
  service,
  pending,
  onRunNow,
  onCommandError,
  t
}: {
  s: BackgroundTaskSnapshot;
  service: BackgroundService;
  pending: boolean;
  onRunNow: (id: string) => void;
  onCommandError: (message: string) => void;
  t: (k: string, opts?: { defaultValue?: string }) => string;
}) {
  // running/queued: 取消本次同步
  if (s.state === "running" || s.state === "queued") {
    return (
      <div className="background-tray__actions">
        <button
          type="button"
          onClick={() => {
            void service.cancel(s.id).then((result) => {
              if (result && result.status !== "accepted") {
                onCommandError("message" in result ? result.message : t("background.tray.cancelFailed", { defaultValue: "取消失败，请稍后重试。" }));
              }
            });
          }}
          title={t("background.tray.action.cancelCurrentSync", { defaultValue: "取消本次同步" })}
        >
          <Square size={14} /> {t("background.tray.action.cancelCurrentSync", { defaultValue: "取消本次同步" })}
        </button>
      </div>
    );
  }

  // idle/blocked: 立即同步一次
  return (
    <div className="background-tray__actions">
      <button
        type="button"
        disabled={pending}
        onClick={() => onRunNow(s.id)}
        title={pending
          ? t("background.tray.action.requesting", { defaultValue: "正在请求同步…" })
          : t("background.tray.action.runOnce", { defaultValue: "立即同步一次" })}
      >
        <Zap size={14} /> {pending
          ? t("background.tray.action.requesting", { defaultValue: "正在请求同步…" })
          : t("background.tray.action.runOnce", { defaultValue: "立即同步一次" })}
      </button>
    </div>
  );
}

function StateBadge({ state, t }: { state: BackgroundTaskState; t: (k: string, opts?: { defaultValue?: string }) => string }) {
  if (state === "running") return (
    <span className="background-tray__badge is-running">
      <Activity size={12} /> {t("background.tray.state.running", { defaultValue: "同步中" })}
    </span>
  );
  if (state === "queued") return <span className="background-tray__badge is-queued">{t("background.tray.state.queued", { defaultValue: "排队中" })}</span>;
  if (state === "blocked") return (
    <span className="background-tray__badge is-blocked">
      <AlertCircle size={12} /> {t("background.tray.state.blocked", { defaultValue: "等待条件" })}
    </span>
  );
  return (
    <span className="background-tray__badge is-idle">
      <CheckCircle2 size={12} /> {t("background.tray.state.idle", { defaultValue: "等待同步" })}
    </span>
  );
}
