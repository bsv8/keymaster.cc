// packages/plugin-background/src/BackgroundTray.tsx
// Topbar 后台任务托盘。
// 设计缘由：托盘只显示通用任务信息，不出现 P2PKH 专属字段。

import { useEffect, useMemo, useState } from "react";
import { Activity, AlertCircle, CheckCircle2, Pause, Play, RotateCw, Square, X } from "lucide-react";
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

  useEffect(() => {
    return service.onChange((s) => setSnapshots(s));
  }, [service]);

  const counts = useMemo(() => {
    let running = 0;
    let queued = 0;
    let failed = 0;
    for (const s of snapshots) {
      if (s.state === "running") running++;
      else if (s.state === "queued") queued++;
      else if (s.state === "failed") failed++;
    }
    return { running, queued, failed };
  }, [snapshots]);

  const trayLabel = t("background.topbar.label", { defaultValue: "后台任务" });

  return (
    <div className="background-tray">
      <button
        type="button"
        className={`background-tray__button ${counts.failed > 0 ? "is-failed" : counts.running > 0 ? "is-running" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-label={trayLabel}
        title={trayLabel}
      >
        <Activity size={16} />
        {counts.running > 0 ? <span className="background-tray__count">{counts.running}</span> : null}
        {counts.failed > 0 ? <span className="background-tray__count background-tray__count--failed">!</span> : null}
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
                  <p className="background-tray__meta">
                    {s.lastCompletedAt
                      ? `${t("background.tray.lastCompletePrefix", { defaultValue: "上次完成 " })}${timeFmt.format(new Date(s.lastCompletedAt))}`
                      : t("background.tray.neverRun", { defaultValue: "尚未运行" })}
                    {s.nextRunAt ? `${t("background.tray.nextPrefix", { defaultValue: " · 下次 " })}${timeFmt.format(new Date(s.nextRunAt))}` : ""}
                  </p>
                  {s.error ? <p className="background-tray__error">{s.error}</p> : null}
                  <div className="background-tray__actions">
                    {s.state === "running" ? (
                      <button
                        type="button"
                        onClick={() => service.cancel(s.id)}
                        title={t("background.tray.action.cancel", { defaultValue: "取消" })}
                      >
                        <Square size={14} /> {t("background.tray.action.cancel", { defaultValue: "取消" })}
                      </button>
                    ) : s.state === "failed" ? (
                      <button
                        type="button"
                        onClick={() => service.retry(s.id)}
                        title={t("background.tray.action.retry", { defaultValue: "重试" })}
                      >
                        <RotateCw size={14} /> {t("background.tray.action.retry", { defaultValue: "重试" })}
                      </button>
                    ) : null}
                    {s.enabled ? (
                      <button
                        type="button"
                        onClick={() => service.pause(s.id)}
                        title={t("background.tray.action.pause", { defaultValue: "暂停" })}
                      >
                        <Pause size={14} /> {t("background.tray.action.pause", { defaultValue: "暂停" })}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => service.resume(s.id)}
                        title={t("background.tray.action.resume", { defaultValue: "继续" })}
                      >
                        <Play size={14} /> {t("background.tray.action.resume", { defaultValue: "继续" })}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function StateBadge({ state, t }: { state: BackgroundTaskState; t: (k: string, opts?: { defaultValue?: string }) => string }) {
  if (state === "running") return (
    <span className="background-tray__badge is-running">
      <Activity size={12} /> {t("background.tray.state.running", { defaultValue: "运行中" })}
    </span>
  );
  if (state === "queued") return <span className="background-tray__badge is-queued">{t("background.tray.state.queued", { defaultValue: "排队中" })}</span>;
  if (state === "failed") return (
    <span className="background-tray__badge is-failed">
      <AlertCircle size={12} /> {t("background.tray.state.failed", { defaultValue: "失败" })}
    </span>
  );
  if (state === "paused") return <span className="background-tray__badge is-paused">{t("background.tray.state.paused", { defaultValue: "已暂停" })}</span>;
  return (
    <span className="background-tray__badge is-idle">
      <CheckCircle2 size={12} /> {t("background.tray.state.idle", { defaultValue: "空闲" })}
    </span>
  );
}
