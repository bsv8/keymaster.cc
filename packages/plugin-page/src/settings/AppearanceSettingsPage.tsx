import { useId } from "react";
import { usePluginI18n } from "@keymaster/runtime";
import { PageHeader, Select } from "@keymaster/ui";
import { ACCENT_IDS, THEME_MODES, type ThemeMode } from "../theme/themeStore.js";
import { useTheme } from "../theme/useTheme.js";

export function AppearanceSettingsPage() {
  const { t } = usePluginI18n();
  const { mode, setMode, accent, setAccent } = useTheme();
  const accentGroup = useId();
  return (
    <div className="system-settings-page__groups">
      <PageHeader title={t("settings.appearance.title", { defaultValue: "Appearance" })} />
      <section className="system-settings-page__group">
        <Select
          label={t("settings.appearance.mode", { defaultValue: "Theme mode" })}
          value={mode}
          options={THEME_MODES.map(value => ({ value, label: t(`shell.onboarding.theme.${value}`) }))}
          onChange={event => setMode(event.currentTarget.value as ThemeMode)}
        />
        <fieldset className="appearance-swatches">
          <legend>{t("settings.appearance.accent", { defaultValue: "Color template" })}</legend>
          <div className="appearance-swatches__options">
            {ACCENT_IDS.map(id => (
              <label key={id} className="appearance-swatch" data-swatch={id}>
                <input type="radio" name={accentGroup} checked={accent === id} onChange={() => setAccent(id)} />
                <span>{t(`settings.appearance.accent.${id}`)}</span>
                <span className="appearance-swatch__check" aria-hidden="true">✓</span>
              </label>
            ))}
          </div>
        </fieldset>
      </section>
    </div>
  );
}
