import { useRef, useState } from "react";
import { usePluginCapability } from "webloom-framework/react";
import { navigateTo } from "@keymaster/runtime";
import { AppIcon, Button } from "@keymaster/ui";
import { CONNECT_SERVICE_CAPABILITY } from "@keymaster/contracts";
import { APP_DIRECTORY_CAPABILITY, useAppDirectory, launchTarget, type AppLaunchTarget } from "./catalog.js";

/** 首页共用目录与钱包启动宿主；点击直接启动，身份验证仍由宿主完成。 */
export function AppsHomeWidget() {
  const directory = usePluginCapability(APP_DIRECTORY_CAPABILITY);
  const connect = usePluginCapability(CONNECT_SERVICE_CAPABILITY);
  const snapshot = useAppDirectory(directory);
  const launching = useRef(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const open = async (id: string, target: AppLaunchTarget) => {
    if (launching.current) return;
    launching.current = true;
    setBusy(id);
    setError(undefined);
    try {
      await connect.launchAppView({ appOrigin: new URL(target.url).origin, appUrl: target.url, expectedAppPublicKeyHex: target.expectedAppPublicKeyHex });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      launching.current = false;
      setBusy(undefined);
    }
  };

  return <section className="apps-home-widget" aria-label="应用">
    <header className="apps-home-widget__header">
      <h3>应用</h3>
      <Button variant="secondary" onClick={() => navigateTo("/apps")}>应用市场</Button>
    </header>
    {snapshot.persistError && <p role="alert">{snapshot.persistError}</p>}
    {snapshot.error && <p role="alert">市场暂时不可用，本地项仍保留。</p>}
    {error && <p role="alert" className="apps-home-widget__error">{error}</p>}
    {snapshot.loading && <p className="apps-home-widget__empty" role="status">正在读取目录…</p>}
    {!snapshot.loading && !snapshot.entries.length && !snapshot.pending.length && <p className="apps-home-widget__empty">尚未添加应用，可前往应用市场选择。</p>}
    <div className="apps-home-widget__grid" aria-busy={busy !== undefined}>
      {snapshot.entries.map(entry => {
        const target = launchTarget(entry);
        const name = entry.name || "未命名应用";
        const id = entry.appPublicKeyHex;
        return <button type="button" className="apps-home-widget__item" key={id} disabled={!target || busy !== undefined} data-entry-url={target?.url} data-testid={`apps-home-open-${id}`} onClick={() => { if (target) void open(id, target); }}>
          <AppIcon size={76} icon={entry.icon} url={target?.url ?? entry.urls[0]?.url} name={name} />
          <span className="apps-home-widget__item-name">{name}</span>
          {busy === id && <span className="apps-home-widget__item-status">正在打开…</span>}
          {!target && <span className="apps-home-widget__item-status">{entry.urls.length ? "当前入口不可用" : "需使用 CLI"}</span>}
        </button>;
      })}
      {snapshot.pending.map(pending => {
        const name = pending.name || "新应用";
        const id = pending.pendingId;
        return <div key={id}>
          <button type="button" className="apps-home-widget__item" disabled={!pending.url || busy !== undefined} data-entry-url={pending.url} data-testid={`apps-home-open-${(pending.url ?? id).replace(/[^a-z0-9]+/gi, "-")}`} onClick={() => {
            if (pending.url) void open(id, { url: pending.url, name: pending.name, pendingId: id, marketListed: false, local: true, favorite: false });
          }}>
            <AppIcon size={76} icon={pending.icon} url={pending.url} name={name} />
            <span className="apps-home-widget__item-name">{name}</span>
            <span className="apps-home-widget__item-status">{busy === id ? "正在打开…" : pending.url ? "待验证" : "待验证 · 需使用 CLI"}</span>
          </button>
          {pending.error && <p className="apps-home-widget__error" role="alert">{pending.error}</p>}
        </div>;
      })}
    </div>
  </section>;
}
