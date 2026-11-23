import { useAppDirectory } from "./useAppDirectory.js";
import { useConnectApps } from "./AppContext.js";
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { type AppDirectoryEntry, type AppLaunchTarget } from "./catalog.js";

/** 市场和详情共用目录、历史投影及启动宿主，不复制持久化状态。 */
export function useAppsModel() {
  const { directory, connect, host } = useConnectApps();
  const { snapshot, reload, loading, loadFailed } = useAppDirectory(directory);
  const store = useMemo(() => {
    let current = host.snapshot();
    return { snapshot: () => current, subscribe: (listener: () => void) => {
      const update = () => { current = host.snapshot(); listener(); };
      const off = host.subscribe(update); update(); return off;
    } };
  }, [host]);
  const applications = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const [busy, setBusy] = useState(false);
  const launching = useRef(false);
  const [error, setError] = useState<string>();
  const report = () => setError("操作未完成，请稍后重试。");
  const entries: AppDirectoryEntry[] = [...snapshot.entries];
  for (const app of applications.applications) {
    if (snapshot.deletedKeys.includes(app.key) || entries.some(entry => entry.appPublicKeyHex === app.key)) continue;
    entries.push({ appVersion:app.publication?.appVersion??"", appPublicKeyHex: app.key, name: app.display?.name ?? app.name, description: app.display?.description, icon: app.display?.icon, urls: app.verifiedUrl && app.display ? [{ url: app.verifiedUrl, origin: new URL(app.verifiedUrl).origin, display: app.display }] : [], files: [], favorite: snapshot.favoriteKeys.includes(app.key) });
  }
  async function open(target: AppLaunchTarget) {
    if (launching.current) return;
    launching.current = true; setBusy(true); setError(undefined);
    try { await connect.launchAppView({ appOrigin: new URL(target.url).origin, appUrl: target.url, expectedAppPublicKeyHex: target.expectedAppPublicKeyHex }); }
    catch { setError("应用未能打开，请稍后重试。"); }
    finally { launching.current = false; setBusy(false); }
  }
  return { directory, host, snapshot, reload, loading, loadFailed, applications, entries, busy, setBusy, error, setError, report, open };
}
