import { useEffect, useState } from "react";
import { usePluginCapability } from "webloom-framework/react";
import { usePluginI18n } from "@keymaster/runtime";
import { APPLICATION_CONNECTIONS_CAPABILITY, type ApplicationOpenMode } from "@keymaster/contracts";
import { useApplicationReminders } from "./applicationReminders.js";
import { PageHeader, Select } from "@keymaster/ui";

/** 钱包统一的打开方式；落盘成功后才更新界面，不迁移已打开应用。 */
export function ApplicationDisplaySettings() {
  const { controller: reminders, sound, notification } = useApplicationReminders();
  const host = usePluginCapability(APPLICATION_CONNECTIONS_CAPABILITY);
  const { t } = usePluginI18n();
  const [mode, setMode] = useState<ApplicationOpenMode>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const read = () => { try { setMode(host.applicationOpenMode()); } catch (failure) { setError(failure instanceof Error ? failure.message : "Application settings unavailable"); } };
    read();
    return host.subscribe(read);
  }, [host]);
  async function save(next: ApplicationOpenMode) {
    if (busy || next === mode) return;
    setBusy(true); setError("");
    try { await host.setApplicationOpenMode(next); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Could not save application settings"); }
    finally { setBusy(false); }
  }
  return <section className="application-display-settings">
    <PageHeader title={t("protocol.applicationDisplay.title", { defaultValue: "Application settings" })} description={t("protocol.applicationDisplay.description", { defaultValue: "Manage application opening, reminder sounds and system notifications." })}/>
    <h2>{t("protocol.applicationDisplay.opening", { defaultValue: "Application opening" })}</h2>
    <Select label={t("protocol.applicationDisplay.mode", { defaultValue: "Open applications in" })} value={mode ?? "iframe"} disabled={busy || mode === undefined} onChange={event => void save(event.currentTarget.value as ApplicationOpenMode)} options={[
      { value: "iframe", label: t("protocol.applicationDisplay.iframe", { defaultValue: "Embedded iframe (default)" }) },
      { value: "popup", label: t("protocol.applicationDisplay.popup", { defaultValue: "New window" }) },
    ]}/>
    <p>{t("protocol.applicationDisplay.note", { defaultValue: "Only applies to applications opened next. Existing applications stay where they are. Apps can still open the wallet directly." })}</p>
    <h2>提示音</h2>
    <button type="button" onClick={() => void reminders.enableSound()}>{sound === "off" ? "启用 / 试听提示音" : sound === "failed" ? "声音未启用 · 重试" : "试听提示音"}</button>
    <p role="status">{sound === "off" ? "提示音未开启" : sound === "failed" ? "提示音未播放" : "提示音已启用"}</p>
    <h2>系统通知</h2>
    <button type="button" onClick={() => void reminders.enableNotifications()}>开启系统通知</button>
    <p role="status">系统通知：{notification}</p>
    <p>浏览器可能限制后台发声和系统通知；静音、勿扰与挂起无法绕过。</p>
    {error && <p role="alert">{error}</p>}
  </section>;
}
