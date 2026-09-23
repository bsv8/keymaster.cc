// packages/plugin-vault/src/AutoLockSettingsSection.tsx
// 自动锁定设置区：2 / 5 / 15 分钟 + 24 小时 + 永不 + 自定义（折叠式）。
//
// 设计缘由（UE 简单简洁）：
//   - 默认只露出一行：当前状态 + 快捷选项（2 / 5 / 15 / 24小时 / 永不 /
//     自定义）；自定义输入框默认隐藏，不把页面摊开。24 小时后面就是永不。
//   - 点「自定义」后快捷选项收起，只留紧凑的一行：返回 icon + 分钟输入 +
//     应用；返回 icon 一键回到快捷选项，返回即丢弃草稿。
//   - 自定义输入点应用/回车才保存，输入过程中绝不禁用输入框、不打断 typing。自定义只能等于、不能超过 24 小时（1440 分钟）。
//   - 当前生效值若为自定义分钟，自定义按钮高亮；点开后输入框预填该值。
//   - 1 分钟起步的整数校验在本地先拦，错误就地提示；保存失败回滚到实际
//     生效值，不让 UI 停在假值上。
//   - 0 = 永不（一直不锁），与后台「0 = 关闭」一致；绝不表示立即锁定。

import { useEffect, useRef, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { useOptionalCapability } from "webloom-framework/react";
import { useI18n, useOptionalResourceSelector, usePluginHost } from "@keymaster/runtime";
import {
  AUTO_LOCK_MAX_CUSTOM_MINUTES,
  AUTO_LOCK_NEVER_TIMEOUT_MS,
  AUTO_LOCK_PRESET_OPTIONS_MS,
  AUTOLOCK_SERVICE_CAPABILITY,
  type AutoLockService,
  type AutoLockSettings,
} from "@keymaster/contracts";

const DEFAULT_SETTINGS: AutoLockSettings = { timeoutMs: 5 * 60 * 1000 };

function timeoutMsToMinutesText(timeoutMs: number): string {
  if (timeoutMs === AUTO_LOCK_NEVER_TIMEOUT_MS) return "never";
  return String(Math.round(timeoutMs / 60000));
}

/** 已有值是否命中不上候选（预设/永不）：命中不上 → 自定义。 */
function isCustomTimeout(timeoutMs: number): boolean {
  return (
    !(AUTO_LOCK_PRESET_OPTIONS_MS as readonly number[]).includes(timeoutMs) &&
    timeoutMs !== AUTO_LOCK_NEVER_TIMEOUT_MS
  );
}

/** 自定义输入解析为超时毫秒；空/非法/超过 24 小时返回 undefined（不保存）。 */
function parseCustomMinutesToMs(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  const rounded = Math.round(parsed);
  if (rounded < 1 || rounded > AUTO_LOCK_MAX_CUSTOM_MINUTES) return undefined;
  const ms = rounded * 60000;
  if (!Number.isSafeInteger(ms)) return undefined;
  return ms;
}

type I18nT = (key: string, values?: { defaultValue?: string; [k: string]: string | number | boolean | null | undefined }) => string;

/** 自定义输入的即时校验文案；空值返回 null（输入过程中不打扰，失焦/回车另行处理）。 */
function customInputError(raw: string, t: I18nT): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return t("vault.autolock.custom.invalid", { defaultValue: "请输入有效的分钟数。" });
  }
  const rounded = Math.round(parsed);
  if (rounded < 1) {
    return t("vault.autolock.custom.min", { defaultValue: "至少 1 分钟。" });
  }
  if (rounded > AUTO_LOCK_MAX_CUSTOM_MINUTES) {
    return t("vault.autolock.custom.max", { defaultValue: "最多 24 小时（1440 分钟），更长请选择「永不」。" });
  }
  if (!Number.isSafeInteger(rounded * 60000)) {
    return t("vault.autolock.custom.tooLarge", { defaultValue: "数值过大，请缩小后重试。" });
  }
  return null;
}

export function AutoLockSettingsSection() {
  const service = useOptionalCapability(AUTOLOCK_SERVICE_CAPABILITY);
  if (!service) {
    return <div className="autolock-settings" role="status">自动锁服务正在切换，请稍候。</div>;
  }
  return <AvailableAutoLockSettingsSection service={service} />;
}

function AvailableAutoLockSettingsSection({ service }: { service: AutoLockService }) {
  const host = usePluginHost();
  const { t } = useI18n();
  const store = host.resourceStore;

  const settings = useOptionalResourceSelector<AutoLockSettings, AutoLockSettings>(
    store,
    "vault.autoLockSettings",
    [],
    (snapshot) => snapshot.data ?? DEFAULT_SETTINGS,
    DEFAULT_SETTINGS
  );

  const effectiveTimeoutMs = settings.timeoutMs;
  const isNever = effectiveTimeoutMs === AUTO_LOCK_NEVER_TIMEOUT_MS;
  const activePreset = (AUTO_LOCK_PRESET_OPTIONS_MS as readonly number[]).includes(effectiveTimeoutMs)
    ? effectiveTimeoutMs
    : undefined;
  const isCustomValue = isCustomTimeout(effectiveTimeoutMs);
  // 整小时的值用小时展示（如 24 小时），其余用分钟。
  const effectiveMinutes = Math.round(effectiveTimeoutMs / 60000);
  const wholeHours =
    !isNever && effectiveMinutes >= 60 && effectiveMinutes % 60 === 0
      ? effectiveMinutes / 60
      : undefined;
  const isWholeHours = wholeHours !== undefined;

  const [pending, setPending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 折叠态：false = 快捷选项行；true = 自定义输入行（快捷选项收起）。
  // 显示时先比对已有值：命中预设/永不 → 快捷行；命中不上 → 直接进自定义行。
  // 懒初始化避免首屏闪一下快捷行；effect 只处理异步到达/跨 tab 收敛。
  const [customOpen, setCustomOpen] = useState(() => isCustomTimeout(settings.timeoutMs));
  // 自定义输入框的文本值；打开时预填当前值，保存中不被跨 tab 快照覆盖。
  const [customMinutes, setCustomMinutes] = useState<string>(() =>
    settings.timeoutMs === AUTO_LOCK_NEVER_TIMEOUT_MS
      ? ""
      : String(Math.round(settings.timeoutMs / 60000))
  );
  const [customError, setCustomError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const savedRef = useRef<number | null>(null);
  const customInputRef = useRef<HTMLInputElement>(null);

  // 生效值为自定义分钟时自动展开自定义行（首屏 / 跨 tab 收敛），
  // 其它情况不强行收起——用户正在输入时不丢草稿。
  useEffect(() => {
    if (savedRef.current !== null && savedRef.current === effectiveTimeoutMs) {
      savedRef.current = null;
    }
    if (pendingRef.current) return;
    if (isCustomValue) {
      setCustomOpen(true);
      setCustomMinutes(String(Math.round(effectiveTimeoutMs / 60000)));
      setCustomError(null);
    }
  }, [effectiveTimeoutMs, isCustomValue]);

  // 展开自定义行后自动聚焦输入框，方便直接 typing。
  useEffect(() => {
    if (customOpen) customInputRef.current?.focus();
  }, [customOpen]);

  function openCustom() {
    setCustomMinutes(isNever ? "" : String(Math.round(effectiveTimeoutMs / 60000)));
    setCustomError(null);
    setSaveError(null);
    setCustomOpen(true);
  }

  function closeCustom() {
    setCustomOpen(false);
    setCustomError(null);
  }

  async function applyTimeoutMs(nextTimeoutMs: number) {
    if (pendingRef.current) return;
    if (nextTimeoutMs === effectiveTimeoutMs) {
      setCustomError(null);
      return;
    }
    const previousTimeoutMs = service.getSettings().timeoutMs;
    pendingRef.current = true;
    setPending(true);
    setSaveError(null);
    setCustomError(null);
    try {
      const result = await service.updateSettings({ timeoutMs: nextTimeoutMs });
      if (result.status !== "accepted") {
        throw new Error(
          "message" in result ? result.message : t("vault.autolock.saveFailed", { defaultValue: "保存失败，请稍后重试。" })
        );
      }
      savedRef.current = nextTimeoutMs;
      // 自定义值若命中预设/永不，自动收回到快捷选项行，保持界面简洁。
      if (
        (AUTO_LOCK_PRESET_OPTIONS_MS as readonly number[]).includes(nextTimeoutMs) ||
        nextTimeoutMs === AUTO_LOCK_NEVER_TIMEOUT_MS
      ) {
        setCustomOpen(false);
      }
    } catch (error: unknown) {
      setSaveError(error instanceof Error ? error.message : String(error));
      // 回滚自定义输入框到实际生效值，避免停留在未生效的假值上。
      setCustomMinutes(
        previousTimeoutMs === AUTO_LOCK_NEVER_TIMEOUT_MS ? "" : timeoutMsToMinutesText(previousTimeoutMs)
      );
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  function applyPreset(presetMs: number) {
    void applyTimeoutMs(presetMs);
  }

  function applyNever() {
    void applyTimeoutMs(AUTO_LOCK_NEVER_TIMEOUT_MS);
  }

  /** 提交自定义输入：点应用或回车才保存，输入过程中绝不打断。 */
  function applyCustom() {
    if (pendingRef.current) return;
    const trimmed = customMinutes.trim();
    if (trimmed === "") {
      setCustomError(t("vault.autolock.custom.required", { defaultValue: "请输入分钟数（至少 1 分钟）。" }));
      return;
    }
    const timeoutMs = parseCustomMinutesToMs(customMinutes);
    if (timeoutMs === undefined) {
      setCustomError(
        customInputError(customMinutes, t) ??
          t("vault.autolock.custom.invalid", { defaultValue: "请输入有效的分钟数。" })
      );
      return;
    }
    setCustomMinutes(String(Math.round(timeoutMs / 60000)));
    void applyTimeoutMs(timeoutMs);
  }

  /** 失焦只做校验提示，不提交。 */
  function handleCustomBlur() {
    if (pendingRef.current) return;
    if (customMinutes.trim() === "") {
      setCustomError(t("vault.autolock.custom.required", { defaultValue: "请输入分钟数（至少 1 分钟）。" }));
      return;
    }
    const err = customInputError(customMinutes, t);
    if (err) setCustomError(err);
  }

  return (
    <div className="autolock-settings">
      <p className="autolock-settings__current" role="status">
        {isNever
          ? t("vault.autolock.current.never", { defaultValue: "当前：永不自动锁定（一直不锁）。" })
          : isWholeHours ? (
            t("vault.autolock.current.timeoutHours", {
              defaultValue: "当前：无操作 {{hours}} 小时后自动锁定。",
              hours: wholeHours,
            })
          ) : (
            t("vault.autolock.current.timeout", {
              defaultValue: "当前：无操作 {{minutes}} 分钟后自动锁定。",
              minutes: Math.round(effectiveTimeoutMs / 60000),
            })
          )}
      </p>

      {customOpen ? (
        <div className="autolock-settings__custom">
          <div className="autolock-settings__custom-row">
            <button
              type="button"
              className="autolock-settings__back"
              disabled={pending}
              onClick={closeCustom}
              aria-label={t("vault.autolock.back.label", { defaultValue: "返回快捷选项" })}
              title={t("vault.autolock.back.label", { defaultValue: "返回快捷选项" })}
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
            <input
              ref={customInputRef}
              id="autolock-custom-minutes"
              className="autolock-settings__custom-input"
              type="number"
              min={1}
              max={AUTO_LOCK_MAX_CUSTOM_MINUTES}
              step={1}
              inputMode="numeric"
              aria-label={t("vault.autolock.custom.label", { defaultValue: "自定义分钟数（1～1440 分钟）" })}
              placeholder={t("vault.autolock.custom.placeholder", { defaultValue: "例如：10" })}
              value={customMinutes}
              disabled={pending}
              onChange={(e) => {
                setCustomMinutes(e.currentTarget.value);
                setCustomError(null);
              }}
              onBlur={handleCustomBlur}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  applyCustom();
                }
              }}
            />
            <span className="autolock-settings__custom-unit">
              {t("vault.autolock.custom.unit", { defaultValue: "分钟" })}
            </span>
            <button
              type="button"
              className="autolock-settings__custom-apply"
              disabled={pending}
              onClick={applyCustom}
            >
              {pending
                ? t("vault.autolock.custom.applying", { defaultValue: "保存中…" })
                : t("vault.autolock.custom.apply", { defaultValue: "应用" })}
            </button>
          </div>
          {customError ? <p className="autolock-settings__error">{customError}</p> : null}
        </div>
      ) : (
        <div
          className="autolock-settings__presets"
          role="group"
          aria-label={t("vault.autolock.presets.label", { defaultValue: "快捷时长" })}
        >
          {(AUTO_LOCK_PRESET_OPTIONS_MS as readonly number[]).map((presetMs) => {
            const presetMinutes = Math.round(presetMs / 60000);
            const presetHours =
              presetMinutes >= 60 && presetMinutes % 60 === 0 ? presetMinutes / 60 : undefined;
            const active = activePreset === presetMs;
            return (
              <button
                key={presetMs}
                type="button"
                className={`autolock-settings__preset ${active ? "is-active" : ""}`}
                aria-pressed={active}
                disabled={pending}
                onClick={() => applyPreset(presetMs)}
              >
                {presetHours !== undefined
                  ? t("vault.autolock.preset.hours", { defaultValue: "{{hours}}小时", hours: presetHours })
                  : t("vault.autolock.preset.minutes", { defaultValue: "{{minutes}} 分钟", minutes: presetMinutes })}
              </button>
            );
          })}
          <button
            type="button"
            className={`autolock-settings__preset autolock-settings__preset--never ${isNever ? "is-active" : ""}`}
            aria-pressed={isNever}
            disabled={pending}
            onClick={applyNever}
          >
            {t("vault.autolock.preset.never", { defaultValue: "永不" })}
          </button>
          <button
            type="button"
            className={`autolock-settings__preset autolock-settings__preset--custom ${isCustomValue ? "is-active" : ""}`}
            aria-pressed={isCustomValue}
            disabled={pending}
            onClick={openCustom}
          >
            {t("vault.autolock.preset.custom", { defaultValue: "自定义" })}
          </button>
        </div>
      )}

      {saveError ? <p className="autolock-settings__error">{saveError}</p> : null}
    </div>
  );
}
