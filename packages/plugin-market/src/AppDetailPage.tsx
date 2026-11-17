import { navigateTo } from "@keymaster/runtime";
import { AppIcon, Button, PageHeader } from "@keymaster/ui";
import { launchTarget } from "./catalog.js";
import { useAppsModel } from "./useAppsModel.js";
import { FavoriteButton } from "./FavoriteButton.js";
import { AppDetails } from "./AppDetails.js";

/** 路由身份稳定绑定当前 App；待验证项使用单独命名空间，不认领应用公钥。 */
export function AppDetailPage({ appId }: { appId: string }) {
  const { directory, host, snapshot, applications, entries, busy, error, report, open } = useAppsModel();
  const detail = entries.find(entry => entry.appPublicKeyHex === appId);
  const pending = appId.startsWith("pending-") ? snapshot.pending.find(entry => entry.pendingId === appId.slice(8)) : undefined;
  const back = () => navigateTo("/apps");
  const target = detail ? launchTarget(detail) : null;
  const validId = /^(02|03)[0-9a-f]{64}$/i.test(appId) || appId.startsWith("pending-");
  return <div className="apps-page apps-market app-detail-page" data-testid="app-detail-page">
    <PageHeader title={detail?.name || pending?.name || "应用详情"} actions={<Button variant="ghost" onClick={back}>返回应用市场</Button>} />
    {error && <p role="alert">{error}</p>}
    {detail ? <>
      <div className="apps-card__header"><AppIcon icon={detail.icon} url={target?.url ?? applications.applications.find(app => app.key === detail.appPublicKeyHex)?.origin} name={detail.name || "应用"} size={80} /><p className="apps-muted">{detail.description || "此应用的授权、会话及处理记录。"}</p></div>
      <div className="apps-card__actions">
        <Button disabled={busy || !target} onClick={() => { if (target) void open(target); }}>打开应用</Button>
        {<FavoriteButton favorite={detail.favorite} testId={`apps-favorite-${detail.appPublicKeyHex}`} onClick={() => void directory.toggleFavorite(detail.appPublicKeyHex).catch(report)} />}
        {detail.local && !detail.favorite && <Button variant="ghost" onClick={() => void directory.removeLocal(detail.appPublicKeyHex).then(back).catch(report)}>移除本地添加</Button>}
      </div>
      {detail.urls.length > 1 && <label className="app-details__filter">首选打开入口<select data-testid="apps-entry-select" value={detail.selected?.url ?? detail.urls[0]?.url ?? ""} onChange={event => void directory.select(detail.appPublicKeyHex, { url: event.target.value }).catch(report)}>{detail.urls.map((entry, index) => <option key={entry.url} value={entry.url}>入口 {index + 1}</option>)}</select></label>}
      <AppDetails key={detail.appPublicKeyHex} applicationKey={detail.appPublicKeyHex} host={host} snapshot={applications} />
    </> : pending ? <>
      <div className="apps-card__header"><AppIcon icon={pending.icon} url={pending.url} name={pending.name || "新应用"} size={80} /><p className="apps-muted">{pending.description || "首次打开并验证应用身份后，可从应用市场查看永久授权、会话和历史。"}</p></div>
      <div className="apps-card__actions"><Button disabled={busy || !pending.url} onClick={() => { if (pending.url) void open({ url: pending.url, name: pending.name, pendingId: pending.pendingId, marketListed: false, local: true, favorite: false }); }}>打开应用</Button><Button variant="secondary" onClick={() => void directory.removePending(pending.pendingId).then(back).catch(report)}>移除此应用</Button></div>
    </> : <p className="apps-muted" role="status">{!validId ? "未找到此应用，请返回应用市场。" : snapshot.loading ? "正在加载应用…" : snapshot.error || !applications.historyAvailable ? "暂时无法读取此应用，请稍后重试。" : "未找到此应用，请返回应用市场。"}</p>}
  </div>;
}
