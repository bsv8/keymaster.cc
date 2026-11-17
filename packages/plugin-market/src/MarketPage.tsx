import { useRef, useState } from "react";
import { navigateTo } from "@keymaster/runtime";
import { AppIcon, Button, Modal, PageHeader, TextInput } from "@keymaster/ui";
import { launchTarget, type AppDirectoryEntry } from "./catalog.js";
import { FavoriteButton } from "./FavoriteButton.js";
import { useAppsModel } from "./useAppsModel.js";

/** 应用目录与已连接应用在市场合并展示，权限仍由协议宿主按应用身份管理。 */
export function MarketPage() {
  const { directory, snapshot, applications, entries, busy, setBusy, error, setError, open } = useAppsModel();
  const [showAdd, setShowAdd] = useState(false);
  const [url, setURL] = useState("");
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [savingFavorite, setSavingFavorite] = useState<string>();
  const favoriteMutation = useRef(false);
  const needle = query.trim().toLocaleLowerCase();
  const matchesName = (name: string | undefined) => (name || "未命名应用").toLocaleLowerCase().includes(needle);
  const favorites = entries.filter(entry => entry.favorite);
  const visibleEntries = entries.filter(entry => matchesName(entry.name));
  const visiblePending = snapshot.pending.filter(entry => matchesName(entry.name || "新应用"));
  async function toggleFavorite(key: string) {
    if (favoriteMutation.current) return;
    favoriteMutation.current = true; setSavingFavorite(key); setError(undefined);
    try { await directory.toggleFavorite(key); }
    catch { setError("收藏更改未能保存，请稍后重试。"); }
    finally { favoriteMutation.current = false; setSavingFavorite(undefined); }
  }
  const appCard = (entry: AppDirectoryEntry, favoriteView = false) => {
    const key = entry.appPublicKeyHex, target = launchTarget(entry), name = entry.name || "未命名应用";
    return <article className="apps-card" key={key} data-testid={`${favoriteView ? "apps-favorite-card" : "apps-card"}-${key}`}>
      <div className="apps-card__header"><AppIcon icon={entry.icon} url={target?.url ?? applications.applications.find(app => app.key === key)?.origin} name={name} size={64} /><div className="apps-card__info"><h3 className="apps-card__title">{name}</h3><span className="apps-muted">{entry.favorite ? "已收藏" : entry.marketListed ? "市场应用" : entry.local ? "我的应用" : "使用过的应用"}</span></div></div>
      <p className="apps-card__summary">{entry.description || "打开应用，体验更多服务。"}</p>
      <div className="apps-card__actions">
        <Button disabled={!target || busy} data-entry-url={target?.url} data-testid={`${favoriteView ? "apps-favorite-open" : "apps-open"}-${key}`} onClick={() => { if (target) void open(target); }}>{target ? "打开" : entry.files.length ? "需使用命令行打开" : "暂不可打开"}</Button>
        <Button variant="ghost" data-testid={`${favoriteView ? "apps-favorite-details" : "apps-details"}-${key}`} onClick={() => { setError(undefined); navigateTo(`/app/${key}`); }}>查看详情</Button>
        {<FavoriteButton favorite={entry.favorite} label={savingFavorite === key ? "保存中…" : favoriteView ? "取消收藏" : entry.favorite ? "已收藏" : "收藏"} disabled={savingFavorite !== undefined || (!favoriteView && entry.favorite)} testId={`${favoriteView ? "apps-unfavorite" : "apps-collect"}-${key}`} onClick={() => void toggleFavorite(key)} />}
      </div>
    </article>;
  };
  return <div className="apps-page apps-market">
    <PageHeader title="应用市场" description="发现应用，管理你的授权与使用记录。" actions={<Button variant="secondary" data-testid="apps-add-toggle" onClick={() => { setError(undefined); setShowAdd(true); }}>添加应用</Button>} />
    {error && <p role="alert">{error}</p>}
    {snapshot.loading && <p className="apps-muted" role="status">正在加载应用…</p>}
    {snapshot.error && <div role="alert" data-testid="apps-market-error">市场暂时不可用，已保存的应用仍可使用。<Button variant="ghost" data-testid="apps-market-retry" onClick={() => void directory.list()}>重试</Button></div>}
    {snapshot.persistError && <p role="alert" data-testid="apps-persist-error">应用更改未能保存，请稍后重试。</p>}
    {!applications.historyAvailable && <p role="alert">应用使用记录暂时不可用。</p>}
    <section className="apps-market__section apps-market__favorites" aria-labelledby="apps-favorites-title">
      <h2 id="apps-favorites-title">收藏应用</h2>
      <div className="apps-list" data-testid="apps-favorites">{favorites.map(entry => appCard(entry, true))}</div>
      {!favorites.length && <p className="apps-muted">还没有收藏应用，可以在下方找到喜欢的应用并收藏。</p>}
    </section>
    <section className="apps-market__section" aria-labelledby="apps-all-title">
      <div className="apps-market__toolbar"><h2 id="apps-all-title">所有应用</h2><TextInput type="search" aria-label="按应用名称搜索" placeholder="搜索应用名称" value={query} onChange={event => setQuery(event.currentTarget.value)} /></div>
      <div className="apps-list" data-testid="apps-list">
      {visibleEntries.map(entry => appCard(entry))}
      {visiblePending.map(pending => <article className="apps-card" key={pending.pendingId} data-testid={`apps-pending-${pending.pendingId}`}>
        <div className="apps-card__header"><AppIcon icon={pending.icon} url={pending.url} name={pending.name || "新应用"} size={64} /><div className="apps-card__info"><h2 className="apps-card__title">{pending.name || "新应用"}</h2><span className="apps-muted">待验证</span></div></div>
        <p className="apps-card__summary">{pending.description || "首次打开后确认应用身份。"}</p>
        {pending.error && <p role="alert">此应用尚未验证成功。</p>}
        <div className="apps-card__actions"><Button disabled={!pending.url || busy} data-entry-url={pending.url} data-testid={`apps-open-${(pending.url ?? pending.pendingId).replace(/[^a-z0-9]+/gi, "-")}`} onClick={() => { if (pending.url) void open({ url: pending.url, name: pending.name, pendingId: pending.pendingId, marketListed: false, local: true, favorite: false }); }}>打开</Button><Button variant="ghost" onClick={() => navigateTo(`/app/pending-${pending.pendingId}`)}>查看详情</Button></div>
      </article>)}
    </div>
    {!snapshot.loading && !visibleEntries.length && !visiblePending.length && <p className="apps-muted" role="status">{needle ? "没有找到匹配的应用。" : "暂无应用，你也可以添加自己常用的应用。"}</p>}
    </section>
    <Modal data-testid="apps-add-modal" closeButtonLabel="关闭添加应用" open={showAdd} title="添加应用" onClose={() => { if (!busy) setShowAdd(false); }}>
      <form className="apps-add-form" onSubmit={async event => {
        event.preventDefault(); if (busy) return; setBusy(true); setError(undefined);
        try { await directory.addLocal({ url, ...(name.trim() ? { name: name.trim() } : {}) }); setShowAdd(false); setURL(""); setName(""); }
        catch { setError("添加失败，请检查应用网址后重试。"); } finally { setBusy(false); }
      }}>
        <label>应用网址<input type="url" required value={url} onChange={event => setURL(event.target.value)} placeholder="https://" data-testid="apps-local-url" /></label>
        <label>名称（可选）<input value={name} onChange={event => setName(event.target.value)} data-testid="apps-local-name" /></label>
        {error && <p role="alert">{error}</p>}
        <Button type="submit" disabled={busy} data-testid="apps-local-submit">添加</Button>
      </form>
    </Modal>
  </div>;
}
