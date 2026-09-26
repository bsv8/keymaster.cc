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
// 自定义间隔（2026-09-26）：预设（30 秒 / 1 分钟 / 2 分钟 / 5 分钟 / 关闭）只是
// 方便，用户仍可在「自定义」里输入自己期望的间隔（10 秒～24 小时整秒）。

import { useEffect, useRef, useState, type RefObject } from "react";
import { useOptionalCapability } from "webloom-framework/react";
import { Button, Modal, PageHeader } from "@keymaster/ui";
import { useI18n, useOptionalResourceSelector, usePluginHost } from "@keymaster/runtime";
import {
  BACKGROUND_MANAGED_SYNC_TASK_IDS,
  BACKGROUND_SERVICE_CAPABILITY,
  BACKGROUND_SYNC_MAX_CUSTOM_SECONDS,
  BACKGROUND_SYNC_MIN_CUSTOM_INTERVAL_MS,
  BACKGROUND_SYNC_PRESET_OPTIONS_MS,
  CHAIN_HEIGHT_RESOURCE_ID,
  backgroundSyncDefaultIntervalMs,
  emptyChainHeightSnapshot,
  normalizeBackgroundSyncSecondsToMs,
  type BackgroundSyncSettings,
  type ChainHeightSnapshot
} from "@keymaster/contracts";

/**
 * 预设文案 key（key 是毫秒值）。
 * 设计缘由（2026-09-26）：间隔选项从契约常量 `BACKGROUND_SYNC_PRESET_OPTIONS_MS`
 * 派生，UI 不再自己复制一份数值表；契约新增预设但这里没有专用文案时，回落到
 * `formatIntervalMs` 的通用时长文案，而不是让用户看到一个谁都不选中的值。
 */
const INTERVAL_OPTION_LABEL_KEYS: ReadonlyMap<number, string> = new Map([
  [30_000, "background.settings.option.30s"],
  [60_000, "background.settings.option.1min"],
  [120_000, "background.settings.option.2min"],
  [300_000, "background.settings.option.5min"],
  [0, "background.settings.option.off"]
]);

/**
 * 同步管理快捷预设。顺序与 0（关闭）语义都由契约常量决定；
 * 2 分钟是区块链高度同步的缺省间隔，自定义值不在此列表里。
 */
const INTERVAL_OPTIONS: ReadonlyArray<{ value: number; labelKey: string | undefined }> =
  BACKGROUND_SYNC_PRESET_OPTIONS_MS.map((value) => ({ value, labelKey: INTERVAL_OPTION_LABEL_KEYS.get(value) }));

const DEFAULT_SETTINGS: BackgroundSyncSettings = { taskIntervals: {} };

type I18nT = (key: string, values?: { defaultValue?: string; [key: string]: string | number | boolean | null | undefined }) => string;

/** 间隔是否命中快捷预设；0（关闭）也是预设。 */
function isPresetInterval(intervalMs: number): boolean {
  return INTERVAL_OPTIONS.some((option) => option.value === intervalMs);
}

/**
 * 自定义间隔的展示文案：优先用能整除的最大单位，
 * 避免 90 秒被写成 "1.5 分钟"。
 */
function formatIntervalMs(intervalMs: number, t: I18nT): string {
  const seconds = Math.round(intervalMs / 1000);
  if (seconds !== 0 && seconds % 3600 === 0) {
    return t("background.settings.interval.hours", { defaultValue: "{{hours}} 小时", hours: seconds / 3600 });
  }
  if (seconds !== 0 && seconds % 60 === 0) {
    return t("background.settings.interval.minutes", { defaultValue: "{{minutes}} 分钟", minutes: seconds / 60 });
  }
  return t("background.settings.interval.seconds", { defaultValue: "{{seconds}} 秒", seconds });
}

function parseCustomSeconds(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  return normalizeBackgroundSyncSecondsToMs(parsed);
}

/** 输入框的错误文案；与自动锁屏的 customInputError 同构。 */
function customInputError(raw: string, t: I18nT): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return t("background.settings.custom.invalid", { defaultValue: "请输入有效的秒数。" });
  }
  const rounded = Math.round(parsed);
  const minSeconds = BACKGROUND_SYNC_MIN_CUSTOM_INTERVAL_MS / 1000;
  if (rounded < minSeconds) {
    return t("background.settings.custom.min", { defaultValue: "至少 {{seconds}} 秒，更短的间隔请选择「关闭」。", seconds: minSeconds });
  }
  if (rounded > BACKGROUND_SYNC_MAX_CUSTOM_SECONDS) {
    return t("background.settings.custom.max", { defaultValue: "最多 24 小时（{{seconds}} 秒），更长请选择「关闭」。", seconds: BACKGROUND_SYNC_MAX_CUSTOM_SECONDS });
  }
  // 走到这里必然 10 ≤ rounded ≤ 86400，毫秒值一定是安全整数，无需再判溢出。
  return null;
}

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

  async function applyInterval(taskId: string, nextIntervalMs: number): Promise<boolean> {
    // 串行保存：已有保存在途时忽略新的点击（按钮同时已禁用）。
    if (pendingRef.current.size > 0) return false;
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
      return true;
    } catch (error: unknown) {
      // 保存失败：回滚乐观更新到实际生效值，并提示用户。
      setIntervals((previous) => ({ ...previous, [taskId]: previousIntervalMs }));
      setSaveError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      pendingRef.current = new Set();
      setPendingTaskIds(pendingRef.current);
    }
  }

  // 自定义间隔编辑弹窗：正在编辑的任务 id、输入值与校验错误。
  const [customTaskId, setCustomTaskId] = useState<string | null>(null);
  const [customSeconds, setCustomSeconds] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);
  const customInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (customTaskId !== null) customInputRef.current?.focus();
  }, [customTaskId]);

  function openCustomEditor(taskId: string) {
    // 关闭态没有「当前间隔」可回填，改用该任务缺省值作为起点。
    const current = intervals[taskId] ?? backgroundSyncDefaultIntervalMs(taskId);
    setCustomTaskId(taskId);
    setCustomSeconds(current === 0 ? String(backgroundSyncDefaultIntervalMs(taskId) / 1000) : String(current / 1000));
    setCustomError(null);
    setSaveError(null);
  }

  function closeCustomEditor() {
    if (pendingRef.current.size > 0) return;
    setCustomTaskId(null);
    setCustomError(null);
  }

  async function applyCustomInterval() {
    if (customTaskId === null || pendingRef.current.size > 0) return;
    const trimmed = customSeconds.trim();
    if (trimmed === "") {
      setCustomError(t("background.settings.custom.required", { defaultValue: "请输入秒数（至少 10 秒）。" }));
      return;
    }
    const intervalMs = parseCustomSeconds(customSeconds);
    if (intervalMs === undefined) {
      setCustomError(
        customInputError(customSeconds, t) ??
          t("background.settings.custom.invalid", { defaultValue: "请输入有效的秒数。" })
      );
      return;
    }
    setCustomSeconds(String(intervalMs / 1000));
    if (await applyInterval(customTaskId, intervalMs)) setCustomTaskId(null);
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
          {t("background.settings.syncManagementDesc", { defaultValue: "每个任务可以单独设置同步间隔；「自定义」可输入 10 秒～24 小时之间的任意整秒间隔。选择「关闭」后该任务不再自动同步，托盘的「立即同步一次」仍然可用。" })}
        </p>
        <ul className="background-settings__tasks">
          {BACKGROUND_MANAGED_SYNC_TASK_IDS.map((taskId) => {
            const active = intervals[taskId] ?? backgroundSyncDefaultIntervalMs(taskId);
            const saving = pendingTaskIds.has(taskId);
            const busy = pendingTaskIds.size > 0;
            const label = t(`background.settings.task.${taskId}`, { defaultValue: taskId });
            // 命中预设时「自定义」只是入口；生效值是自定义值时按钮直接显示该值。
            const isCustomValue = active !== 0 && !isPresetInterval(active);
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
                      onClick={() => void applyInterval(taskId, opt.value)}
                    >
                      {opt.labelKey ? t(opt.labelKey, { defaultValue: opt.labelKey }) : formatIntervalMs(opt.value, t)}
                    </button>
                  ))}
                  {/* 可访问名固定为「自定义」，生效值变化只改可见文本：读屏用户
                      不会因为按钮改名而找不到同一个入口。 */}
                  <button
                    type="button"
                    className={`background-settings__interval ${isCustomValue ? "is-active" : ""}`}
                    aria-label={t("background.settings.option.custom", { defaultValue: "自定义" })}
                    aria-pressed={isCustomValue}
                    disabled={busy}
                    aria-haspopup="dialog"
                    onClick={() => openCustomEditor(taskId)}
                  >
                    {isCustomValue
                      ? formatIntervalMs(active, t)
                      : t("background.settings.option.custom", { defaultValue: "自定义" })}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
      <ChainHeightReadout />
      {/* 弹窗打开时页面级错误不可见（被遮罩挡住），错误改由弹窗内的 alert 呈现。 */}
      {saveError && customTaskId === null ? <p className="background-settings__error" role="alert">{saveError}</p> : null}
      <CustomIntervalEditor
        taskId={customTaskId}
        seconds={customSeconds}
        error={customError}
        saveError={saveError}
        busy={pendingTaskIds.size > 0}
        inputRef={customInputRef}
        onSecondsChange={(next) => {
          setCustomSeconds(next);
          setCustomError(null);
        }}
        onSubmit={() => void applyCustomInterval()}
        onCancel={closeCustomEditor}
      />
    </div>
  );
}

/**
 * 自定义同步间隔弹窗。
 *
 * 设计缘由：预设按钮只是快捷入口，真正需要的是「用户自己期望的时间」。
 * 这里的输入只接受整秒，边界由 contracts 的
 * `normalizeBackgroundSyncSecondsToMs` 统一判定，UI 不自行放宽。
 *
 * 保存失败时弹窗不关闭（用户改完可以再试），因此失败原因必须显示在弹窗内：
 * 页面级错误区在 `.ui-modal` 遮罩之下，弹窗外看不到了。
 */
function CustomIntervalEditor({
  taskId,
  seconds,
  error,
  saveError,
  busy,
  inputRef,
  onSecondsChange,
  onSubmit,
  onCancel
}: {
  taskId: string | null;
  seconds: string;
  error: string | null;
  saveError: string | null;
  busy: boolean;
  inputRef: RefObject<HTMLInputElement>;
  onSecondsChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  if (taskId === null) return null;
  const taskLabel = t(`background.settings.task.${taskId}`, { defaultValue: taskId });
  return (
    <Modal
      open
      title={t("background.settings.custom.modalTitle", { defaultValue: "自定义同步间隔：{{task}}", task: taskLabel })}
      onClose={onCancel}
      data-testid="background-custom-interval-editor"
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            {t("common.action.cancel", { defaultValue: "取消" })}
          </Button>
          {/* 不用 Button 的 loading：它会把 children 换成硬编码的
              "Loading…"，本页的「保存中…」文案就永远显示不出来。 */}
          <Button variant="primary" disabled={busy} aria-busy={busy} onClick={onSubmit}>
            {busy
              ? t("background.settings.custom.applying", { defaultValue: "保存中…" })
              : t("background.settings.custom.apply", { defaultValue: "应用" })}
          </Button>
        </>
      }
    >
      <p className="background-settings__custom-desc">
        {t("background.settings.custom.modalDescription", {
          defaultValue: "输入 10 到 86400 秒之间的整数间隔；保存后新周期从保存时刻开始计时。"
        })}
      </p>
      <label className="background-settings__custom-field">
        <span>{t("background.settings.custom.label", { defaultValue: "自定义间隔（10～86400 秒）" })}</span>
        <div className="background-settings__custom-input-row">
          <input
            ref={inputRef}
            id="background-custom-interval-seconds"
            type="number"
            min={BACKGROUND_SYNC_MIN_CUSTOM_INTERVAL_MS / 1000}
            max={BACKGROUND_SYNC_MAX_CUSTOM_SECONDS}
            step={1}
            inputMode="numeric"
            placeholder={t("background.settings.custom.placeholder", { defaultValue: "例如：45" })}
            value={seconds}
            disabled={busy}
            onChange={(event) => onSecondsChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onSubmit();
              }
            }}
          />
          <span>{t("background.settings.custom.unit", { defaultValue: "秒" })}</span>
        </div>
      </label>
      {error ?? saveError ? <p className="background-settings__error" role="alert">{error ?? saveError}</p> : null}
    </Modal>
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
