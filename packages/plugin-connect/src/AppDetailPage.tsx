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
  const back = () => navigateTo("/apps");
  const target = detail ? launchTarget(detail) : null;
  const validId = /^(02|03)[0-9a-f]{64}$/i.test(appId);
  return <div className="apps-page apps-market app-detail-page" data-testid="app-detail-page">
    <PageHeader title={detail?.name || "应用详情"} actions={<Button variant="ghost" onClick={back}>返回应用市场</Button>} />
    {error && <p role="alert">{error}</p>}
    {detail ? <>
      <div className="apps-card__header"><AppIcon icon={detail.icon} url={target?.url ?? applications.applications.find(app => app.key === detail.appPublicKeyHex)?.origin} name={detail.name || "应用"} size={80} /><p className="apps-muted">{detail.description || "此应用的授权、会话及处理记录。"}</p></div>
      <p className="apps-muted">版本 {detail.appVersion}</p>
      <div className="apps-card__actions">
        <Button disabled={busy || !target} onClick={() => { if (target) void open(target); }}>打开应用</Button>
        {<FavoriteButton favorite={detail.favorite} testId={`apps-favorite-${detail.appPublicKeyHex}`} onClick={() => void directory.toggleFavorite(detail.appPublicKeyHex).catch(report)} />}
        <Button variant="ghost" data-testid={`apps-delete-${detail.appPublicKeyHex}`} onClick={() => void directory.deleteApp(detail.appPublicKeyHex).then(back).catch(report)}>删除应用</Button>
      </div>
      <AppDetails key={detail.appPublicKeyHex} applicationKey={detail.appPublicKeyHex} host={host} snapshot={applications} />
    </> : <p className="apps-muted" role="status">{!validId ? "未找到此应用，请返回应用市场。" : snapshot.loading ? "正在加载应用…" : "未找到此应用，请返回应用市场。"}</p>}
  </div>;
}
