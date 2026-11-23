import { useAppDirectory } from "./useAppDirectory.js";
import { useConnectApps } from "./AppContext.js";
import { useRef, useState } from "react";
import { navigateTo } from "@keymaster/runtime";
import { AppIcon, Button } from "@keymaster/ui";
import { launchTarget, type AppLaunchTarget } from "./catalog.js";

/** 首页共用目录与钱包启动宿主；点击直接启动，身份验证仍由宿主完成。 */
export function AppsHomeWidget() {
  const { directory, connect } = useConnectApps();
  const { snapshot } = useAppDirectory(directory);
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
    {error && <p role="alert" className="apps-home-widget__error">{error}</p>}
    {snapshot.loading && <p className="apps-home-widget__empty" role="status">正在读取目录…</p>}
    {!snapshot.loading && !snapshot.entries.length && <p className="apps-home-widget__empty">尚未添加应用，可前往应用市场选择。</p>}
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
    </div>
  </section>;
}
