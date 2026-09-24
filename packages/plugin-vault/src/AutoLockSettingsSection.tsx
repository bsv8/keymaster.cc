import { useEffect, useRef, useState } from "react";
import { Check, Clock3, Infinity as InfinityIcon, SlidersHorizontal, Timer } from "lucide-react";
import { Button, Modal, PageHeader } from "@keymaster/ui";
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

function isCustomTimeout(timeoutMs: number): boolean {
  return (
    !(AUTO_LOCK_PRESET_OPTIONS_MS as readonly number[]).includes(timeoutMs) &&
    timeoutMs !== AUTO_LOCK_NEVER_TIMEOUT_MS
  );
}

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

type I18nT = (key: string, values?: { defaultValue?: string; [key: string]: string | number | boolean | null | undefined }) => string;

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

export function AutoLockSettingsPage() {
  const { t } = useI18n();
  return (
    <div className="autolock-settings-page">
      <PageHeader
        title={t("vault.autolock.page.title", { defaultValue: "自动锁屏" })}
        description={t("vault.autolock.page.description", {
          defaultValue: "无操作一段时间后自动锁屏，修改立即生效。"
        })}
      />
      <AutoLockSettingsSection />
    </div>
  );
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
  const isCustomValue = isCustomTimeout(effectiveTimeoutMs);
  const effectiveMinutes = Math.round(effectiveTimeoutMs / 60000);
  const wholeHours = !isNever && effectiveMinutes >= 60 && effectiveMinutes % 60 === 0
    ? effectiveMinutes / 60
    : undefined;

  const [pending, setPending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customMinutes, setCustomMinutes] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const customInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (customOpen) customInputRef.current?.focus();
  }, [customOpen]);

  function durationLabel(timeoutMs: number): string {
    if (timeoutMs === AUTO_LOCK_NEVER_TIMEOUT_MS) {
      return t("vault.autolock.preset.never", { defaultValue: "永不" });
    }
    const minutes = Math.round(timeoutMs / 60000);
    const hours = minutes >= 60 && minutes % 60 === 0 ? minutes / 60 : undefined;
    return hours !== undefined
      ? t("vault.autolock.preset.hours", { defaultValue: "{{hours}} 小时", hours })
      : t("vault.autolock.preset.minutes", { defaultValue: "{{minutes}} 分钟", minutes });
  }

  function openCustom() {
    if (pending) return;
    setCustomMinutes(isNever ? "" : String(Math.round(effectiveTimeoutMs / 60000)));
    setCustomError(null);
    setSaveError(null);
    setCustomOpen(true);
  }

  function closeCustom() {
    if (pending) return;
    setCustomOpen(false);
    setCustomError(null);
  }

  async function applyTimeoutMs(nextTimeoutMs: number): Promise<boolean> {
    if (pendingRef.current) return false;
    if (nextTimeoutMs === effectiveTimeoutMs) return true;
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
      return true;
    } catch (error: unknown) {
      setSaveError(error instanceof Error ? error.message : String(error));
      setCustomMinutes(
        previousTimeoutMs === AUTO_LOCK_NEVER_TIMEOUT_MS ? "" : timeoutMsToMinutesText(previousTimeoutMs)
      );
      return false;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  async function applyCustom() {
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
    if (await applyTimeoutMs(timeoutMs)) closeCustom();
  }

  const currentDescription = isNever
    ? t("vault.autolock.current.never", { defaultValue: "当前：永不自动锁定（一直不锁）。" })
    : wholeHours !== undefined
      ? t("vault.autolock.current.timeoutHours", {
          defaultValue: "当前：无操作 {{hours}} 小时后自动锁定。",
          hours: wholeHours,
        })
      : t("vault.autolock.current.timeout", {
          defaultValue: "当前：无操作 {{minutes}} 分钟后自动锁定。",
          minutes: effectiveMinutes,
        });

  return (
    <div className="autolock-settings">
      <section className="autolock-summary" aria-labelledby="autolock-summary-title">
        <div className="autolock-summary__icon" aria-hidden="true"><Timer size={22} /></div>
        <div className="autolock-summary__content">
          <span id="autolock-summary-title">{t("vault.autolock.summary.title", { defaultValue: "当前策略" })}</span>
          <strong>{durationLabel(effectiveTimeoutMs)}</strong>
          <p role="status">{currentDescription}</p>
        </div>
        <span className={`autolock-summary__badge ${isNever ? "is-off" : "is-on"}`}>
          {isNever
            ? t("vault.autolock.summary.disabled", { defaultValue: "已关闭" })
            : t("vault.autolock.summary.enabled", { defaultValue: "已启用" })}
        </span>
      </section>

      <section className="autolock-duration" aria-labelledby="autolock-duration-title">
        <div className="autolock-duration__header">
          <h2 id="autolock-duration-title">{t("vault.autolock.presets.title", { defaultValue: "无操作后锁定" })}</h2>
          <p>{t("vault.autolock.presets.description", { defaultValue: "选择钱包保持解锁的时长，设置会立即生效。" })}</p>
        </div>
        <div
          className="autolock-duration__options"
          role="group"
          aria-label={t("vault.autolock.presets.label", { defaultValue: "锁定时长" })}
        >
          {(AUTO_LOCK_PRESET_OPTIONS_MS as readonly number[]).map((presetMs) => {
            const active = effectiveTimeoutMs === presetMs;
            const label = durationLabel(presetMs);
            return (
              <Button
                key={presetMs}
                className={`autolock-option ${active ? "is-active" : ""}`}
                variant={active ? "primary" : "secondary"}
                aria-label={label}
                aria-pressed={active}
                disabled={pending}
                onClick={() => void applyTimeoutMs(presetMs)}
              >
                <span className="autolock-option__content">
                  <span className="autolock-option__value">
                    {presetMs === 24 * 60 * 60 * 1000
                      ? <Clock3 size={16} aria-hidden="true" />
                      : <Timer size={16} aria-hidden="true" />}
                    <strong>{label}</strong>
                    {active ? <Check size={15} aria-hidden="true" /> : null}
                  </span>
                  <small>{t("vault.autolock.presets.optionHint", { defaultValue: "无操作后" })}</small>
                </span>
              </Button>
            );
          })}
          <Button
            className={`autolock-option ${isNever ? "is-active" : ""}`}
            variant={isNever ? "primary" : "secondary"}
            aria-label={t("vault.autolock.preset.never", { defaultValue: "永不" })}
            aria-pressed={isNever}
            disabled={pending}
            onClick={() => void applyTimeoutMs(AUTO_LOCK_NEVER_TIMEOUT_MS)}
          >
            <span className="autolock-option__content">
              <span className="autolock-option__value">
                <InfinityIcon size={16} aria-hidden="true" />
                <strong>{t("vault.autolock.preset.never", { defaultValue: "永不" })}</strong>
                {isNever ? <Check size={15} aria-hidden="true" /> : null}
              </span>
              <small>{t("vault.autolock.presets.neverHint", { defaultValue: "一直保持解锁" })}</small>
            </span>
          </Button>
          <Button
            className={`autolock-option ${isCustomValue ? "is-active" : ""}`}
            variant={isCustomValue ? "primary" : "secondary"}
            aria-label={t("vault.autolock.preset.custom", { defaultValue: "自定义" })}
            aria-pressed={isCustomValue}
            disabled={pending}
            onClick={openCustom}
          >
            <span className="autolock-option__content">
              <span className="autolock-option__value">
                <SlidersHorizontal size={16} aria-hidden="true" />
                <strong>{isCustomValue ? durationLabel(effectiveTimeoutMs) : t("vault.autolock.preset.custom", { defaultValue: "自定义" })}</strong>
                {isCustomValue ? <Check size={15} aria-hidden="true" /> : null}
              </span>
              <small>{t("vault.autolock.presets.customHint", { defaultValue: "输入精确时长" })}</small>
            </span>
          </Button>
        </div>
      </section>

      {saveError && !customOpen ? <p className="autolock-settings__error" role="alert">{saveError}</p> : null}

      <Modal
        open={customOpen}
        title={t("vault.autolock.custom.modalTitle", { defaultValue: "自定义自动锁屏" })}
        onClose={closeCustom}
        data-testid="autolock-custom-editor"
        footer={
          <>
            <Button variant="ghost" disabled={pending} onClick={closeCustom}>
              {t("common.action.cancel", { defaultValue: "取消" })}
            </Button>
            <Button loading={pending} onClick={() => void applyCustom()}>
              {pending
                ? t("vault.autolock.custom.applying", { defaultValue: "保存中…" })
                : t("vault.autolock.custom.apply", { defaultValue: "应用" })}
            </Button>
          </>
        }
      >
        <p className="autolock-custom-editor__description">
          {t("vault.autolock.custom.modalDescription", {
            defaultValue: "输入 1 到 1440 分钟之间的整数时长。"
          })}
        </p>
        <label className="autolock-custom-editor__field">
          <span>{t("vault.autolock.custom.label", { defaultValue: "自定义分钟数（1～1440 分钟）" })}</span>
          <div className="autolock-custom-editor__input-row">
            <input
              ref={customInputRef}
              id="autolock-custom-minutes"
              type="number"
              min={1}
              max={AUTO_LOCK_MAX_CUSTOM_MINUTES}
              step={1}
              inputMode="numeric"
              placeholder={t("vault.autolock.custom.placeholder", { defaultValue: "例如：10" })}
              value={customMinutes}
              disabled={pending}
              onChange={(event) => {
                setCustomMinutes(event.currentTarget.value);
                setCustomError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void applyCustom();
                }
              }}
            />
            <span>{t("vault.autolock.custom.unit", { defaultValue: "分钟" })}</span>
          </div>
        </label>
        {customError || saveError ? (
          <p className="autolock-custom-editor__error" role="alert">{customError ?? saveError}</p>
        ) : null}
      </Modal>
    </div>
  );
}
