import { useAppsModel } from "./useAppsModel.js";
import { useConnectApps } from "./AppContext.js";
import { useEffect, useState } from "react";
import { usePluginI18n } from "@keymaster/runtime";
import { type ApplicationOpenMode } from "@keymaster/contracts";
import { useApplicationReminders } from "./applicationReminders.js";
import { PageHeader, Select } from "@keymaster/ui";

/** 钱包统一的打开方式；落盘成功后才更新界面，不迁移已打开应用。 */
export function ApplicationDisplaySettings() {
  const { controller: reminders, sound, notification } = useApplicationReminders();
  const { host } = useConnectApps();
  const { directory, entries } = useAppsModel();
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
    <PageHeader title={t("connect.applicationDisplay.title", { defaultValue: "Application settings" })} description={t("connect.applicationDisplay.description", { defaultValue: "Manage application opening, reminder sounds and system notifications." })}/>
    <h2>{t("connect.applicationDisplay.opening", { defaultValue: "Application opening" })}</h2>
    <Select label={t("connect.applicationDisplay.mode", { defaultValue: "Open applications in" })} value={mode ?? "iframe"} disabled={busy || mode === undefined} onChange={event => void save(event.currentTarget.value as ApplicationOpenMode)} options={[
      { value: "iframe", label: t("connect.applicationDisplay.iframe", { defaultValue: "Embedded iframe (default)" }) },
      { value: "popup", label: t("connect.applicationDisplay.popup", { defaultValue: "New window" }) },
    ]}/>
    <p>{t("connect.applicationDisplay.note", { defaultValue: "Only applies to applications opened next. Existing applications stay where they are. Apps can still open the wallet directly." })}</p>
    <h2>提示音</h2>
    <button type="button" onClick={() => void reminders.enableSound()}>{sound === "off" ? "启用 / 试听提示音" : sound === "failed" ? "声音未启用 · 重试" : "试听提示音"}</button>
    <p role="status">{sound === "off" ? "提示音未开启" : sound === "failed" ? "提示音未播放" : "提示音已启用"}</p>
    <h2>系统通知</h2>
    <button type="button" onClick={() => void reminders.enableNotifications()}>开启系统通知</button>
    <p role="status">系统通知：{notification}</p>
    <p>浏览器可能限制后台发声和系统通知；静音、勿扰与挂起无法绕过。</p>
    <h2>应用管理</h2>
    <p>删除应用会取消收藏和永久许可，并断开当前连接。已执行操作及资金责任记录保留。</p>
    {entries.map(app => <div className="app-details__row" key={app.appPublicKeyHex}>
      <span>{app.name || "未命名应用"}</span>
      <button type="button" disabled={busy} onClick={async () => {
        setBusy(true); setError("");
        try { await directory.deleteApp(app.appPublicKeyHex); }
        catch { setError("删除应用失败，请重试。"); }
        finally { setBusy(false); }
      }}>删除应用</button>
    </div>)}
    {error && <p role="alert">{error}</p>}
  </section>;
}
