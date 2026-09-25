// packages/plugin-background/src/BackgroundSettingsPage.tsx
// 智能调度设置页：余额快照的智能刷新说明 + 各后台任务的同步管理。
//
// 设计缘由（2026-09-20）：
//   - BSV 余额来自内存 UTXO 快照，由 WoC 空闲 2 秒的智能调度驱动，
//     不提供周期配置；页面只解释机制。
//   - 其余后台任务（P2PKH 历史、BSV-21、STAS、1Sat、联系人探测）可以
//     单独设置同步间隔：30 秒 / 1 分钟 / 5 分钟 / 关闭。
//   - 「关闭」只关闭自动同步；托盘「立即同步一次」仍然有效。
//   - 保存后不立即触发网络同步，新周期从保存时刻开始计时。
//
// 硬切换 003：使用 Resource Store 读取后台设置，跨标签同步由 resource subscribe 处理。

import { useEffect, useRef, useState } from "react";
import { useOptionalCapability } from "webloom-framework/react";
import { PageHeader } from "@keymaster/ui";
import { useI18n, useOptionalResourceSelector, usePluginHost } from "@keymaster/runtime";
import {
  BACKGROUND_MANAGED_SYNC_TASK_IDS,
  BACKGROUND_SERVICE_CAPABILITY,
  CHAIN_HEIGHT_RESOURCE_ID,
  backgroundSyncDefaultIntervalMs,
  emptyChainHeightSnapshot,
  type BackgroundSyncSettings,
  type ChainHeightSnapshot
} from "@keymaster/contracts";

/**
 * 同步管理选项：间隔毫秒 + 文案 key。0 表示关闭自动同步。
 * 顺序即展示顺序；2 分钟是区块链高度同步的缺省间隔。
 */
const INTERVAL_OPTIONS: Array<{ label: string; value: number }> = [
  { label: "background.settings.option.30s", value: 30_000 },
  { label: "background.settings.option.1min", value: 60_000 },
  { label: "background.settings.option.2min", value: 120_000 },
  { label: "background.settings.option.5min", value: 300_000 },
  { label: "background.settings.option.off", value: 0 }
];

const DEFAULT_SETTINGS: BackgroundSyncSettings = { taskIntervals: {} };

/**
 * 读取任务当前生效的间隔：未配置时使用该任务自己的缺省
 * （区块链高度 2 分钟，其余 5 分钟），而不是统一的平台缺省。
 */
function effectiveInterval(settings: BackgroundSyncSettings, taskId: string): number {
  const configured = settings.taskIntervals?.[taskId];
  return typeof configured === "number" ? configured : backgroundSyncDefaultIntervalMs(taskId);
}

export function BackgroundSettingsPage() {
  const { t } = useI18n();
  return (
    <div className="background-settings-page">
      <PageHeader
        title={t("background.settings.title", { defaultValue: "智能调度" })}
        description={t("background.settings.description", {
          defaultValue: "管理余额快照与后台任务的自动同步。"
        })}
      />
      <BackgroundSettingsContent />
    </div>
  );
}

function BackgroundSettingsContent() {
  // owner-session 在锁定过渡中会先撤销 capability；路由树卸载前若有一帧
  // 仍命中本页，不能把这个正常的 unavailable 状态升级成 React fatal。
  const backgroundService = useOptionalCapability(BACKGROUND_SERVICE_CAPABILITY);
  if (!backgroundService) {
    return <div className="background-settings" role="status">后台任务服务正在切换，请稍候。</div>;
  }
  return <AvailableBackgroundSettingsPage backgroundService={backgroundService} />;
}

/** capability 存在时才挂载 resource hook，避免资源定义已撤销时调用 ensure。 */
function AvailableBackgroundSettingsPage({ backgroundService }: { backgroundService: import("@keymaster/contracts").BackgroundService }) {
  const host = usePluginHost();
  const { t } = useI18n();
  const store = host.resourceStore;

  // 使用 Resource Store 读取同步管理设置（跨标签同步由 resource subscribe 处理）
  const settings = useOptionalResourceSelector<BackgroundSyncSettings, BackgroundSyncSettings>(
    store,
    "background.scheduleSettings",
    [],
    (snapshot) => snapshot.data ?? DEFAULT_SETTINGS,
    DEFAULT_SETTINGS
  );

  // 本地交互 state：
  //   - intervals：UI 显示值（含乐观更新，保存失败会回滚）；
  //   - pendingTaskIds：正在保存的任务；保存期间所有按钮禁用，避免并发
  //     保存用旧快照互相覆盖；
  //   - saveError：最近一次保存失败提示。
  const [pendingTaskIds, setPendingTaskIds] = useState<ReadonlySet<string>>(() => new Set());
  const [saveError, setSaveError] = useState<string | null>(null);
  const [intervals, setIntervals] = useState<Record<string, number>>({});
  const pendingRef = useRef<ReadonlySet<string>>(new Set());
  /**
   * 本页最近成功保存、但资源事件可能尚未回流的值。
   * 用途：下一次保存的合并基准，以及失败回滚值（避免回滚到旧缺省）。
   */
  const savedRef = useRef<Record<string, number>>({});

  // 当 resource 设置变化时（跨标签同步），更新表单值；正在保存的任务
  // 保留本地值，避免被尚未包含本次修改的旧快照覆盖。
  useEffect(() => {
    // 已被资源快照确认的成功保存不再需要本地补偿；尚未回流的仍保留，
    // 供下一次保存的合并基准与失败回滚使用。
    for (const [savedTaskId, savedIntervalMs] of Object.entries(savedRef.current)) {
      if (effectiveInterval(settings, savedTaskId) === savedIntervalMs) delete savedRef.current[savedTaskId];
    }
    setIntervals((previous) => {
      const next: Record<string, number> = {};
      for (const taskId of BACKGROUND_MANAGED_SYNC_TASK_IDS) {
        next[taskId] = pendingRef.current.has(taskId)
          ? previous[taskId] ?? effectiveInterval(settings, taskId)
          : effectiveInterval(settings, taskId);
      }
      return next;
    });
  }, [settings]);

  function applyInterval(taskId: string, nextIntervalMs: number) {
    // 串行保存：已有保存在途时忽略新的点击（按钮同时已禁用）。
    if (pendingRef.current.size > 0) return;
    // 以平台最近一次生效设置为基准合并本次修改：优先使用本页最近成功保存
    // 但事件尚未回流的值，避免用旧快照覆盖其它任务已经保存成功的值。
    const base = backgroundService.getScheduleSettings();
    const baseIntervals: Record<string, number> = { ...(base.taskIntervals ?? {}), ...savedRef.current };
    // 失败回滚值取合并后的实际生效值：同一任务第一次保存成功但事件尚未
    // 回流时，第二次保存失败必须回到第一次的值，而不是旧缺省。
    const previousIntervalMs = effectiveInterval({ taskIntervals: baseIntervals }, taskId);
    pendingRef.current = new Set([taskId]);
    setPendingTaskIds(pendingRef.current);
    setIntervals((previous) => ({ ...previous, [taskId]: nextIntervalMs }));
    setSaveError(null);
    void (async () => {
      try {
        const result = await backgroundService.updateScheduleSettings({
          taskIntervals: {
            ...baseIntervals,
            [taskId]: nextIntervalMs
          }
        });
        if (result.status !== "accepted") {
          throw new Error("message" in result ? result.message : t("background.settings.saveFailed", { defaultValue: "保存失败，请稍后重试。" }));
        }
        savedRef.current = { ...savedRef.current, [taskId]: nextIntervalMs };
      } catch (error: unknown) {
        // 保存失败：回滚乐观更新到实际生效值，并提示用户。
        setIntervals((previous) => ({ ...previous, [taskId]: previousIntervalMs }));
        setSaveError(error instanceof Error ? error.message : String(error));
      } finally {
        pendingRef.current = new Set();
        setPendingTaskIds(pendingRef.current);
      }
    })();
  }

  return (
    <div className="background-settings">
      <section className="background-settings__section">
        <h4 className="background-settings__section-title">
          {t("background.settings.smartTitle", { defaultValue: "BSV 余额快照（智能）" })}
        </h4>
        <p className="background-settings__hint">
          {t("background.settings.smartDesc", { defaultValue: "余额来自内存 UTXO 快照：解锁后立即刷新，之后每次 WoC 队列空闲满 2 秒自动刷新，间隔不可配置。" })}
        </p>
      </section>

      <section className="background-settings__section">
        <h4 className="background-settings__section-title">
          {t("background.settings.syncManagement", { defaultValue: "同步管理" })}
        </h4>
        <p className="background-settings__hint">
          {t("background.settings.syncManagementDesc", { defaultValue: "每个任务可以单独设置同步间隔；选择「关闭」后该任务不再自动同步，托盘的「立即同步一次」仍然可用。" })}
        </p>
        <ul className="background-settings__tasks">
          {BACKGROUND_MANAGED_SYNC_TASK_IDS.map((taskId) => {
            const active = intervals[taskId] ?? backgroundSyncDefaultIntervalMs(taskId);
            const saving = pendingTaskIds.has(taskId);
            const busy = pendingTaskIds.size > 0;
            const label = t(`background.settings.task.${taskId}`, { defaultValue: taskId });
            return (
              <li key={taskId} className="background-settings__task">
                <span className="background-settings__task-label">{label}</span>
                <div className="background-settings__intervals" role="group" aria-label={label}>
                  {INTERVAL_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={`background-settings__interval ${active === opt.value ? "is-active" : ""}`}
                      aria-pressed={active === opt.value}
                      disabled={busy}
                      aria-busy={saving}
                      onClick={() => applyInterval(taskId, opt.value)}
                    >
                      {t(opt.label, { defaultValue: opt.label })}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
      <ChainHeightReadout />
      {saveError ? <p className="background-settings__error">{saveError}</p> : null}
    </div>
  );
}

/**
 * 当前区块链高度。
 *
 * 设计缘由：这里的值来自 `chain.height` 资源，底层是 Coordinator 单点广播的
 * `chain.height` 主题；本页通过 Resource Store 订阅，等价于 ChainHeightReader
 * 的订阅/退订，因此后台同步任务每成功一次，本区块就自动重渲染一次。
 */
function ChainHeightReadout() {
  const { t } = useI18n();
  const host = usePluginHost();
  // 资源未注册时（例如 WOC 单元尚未装配）回落为空快照，不抛错。
  const chainHeight = useOptionalResourceSelector<ChainHeightSnapshot, ChainHeightSnapshot>(
    host.resourceStore,
    CHAIN_HEIGHT_RESOURCE_ID,
    [],
    (snapshot) => snapshot.data ?? emptyChainHeightSnapshot(),
    emptyChainHeightSnapshot()
  );
  return (
    <section className="background-settings__section">
      <h4 className="background-settings__section-title">
        {t("background.settings.chainHeightTitle", { defaultValue: "当前区块链高度" })}
      </h4>
      <p className="background-settings__hint">
        {chainHeight.available
          ? t("background.settings.chainHeightValue", {
              defaultValue: "主网高度 {{height}}",
              height: chainHeight.height.toLocaleString()
            })
          : t("background.settings.chainHeightPending", { defaultValue: "尚未取得节点高度：等待后台同步任务完成第一次读取。" })}
      </p>
    </section>
  );
}
