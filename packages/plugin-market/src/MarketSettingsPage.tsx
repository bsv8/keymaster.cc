import { useState, useSyncExternalStore } from "react";
import { Button, PageHeader, TextInput } from "@keymaster/ui";
import type { WindowMarketClient } from "./windowMarket.js";
import type { MarketRecordSnapshot } from "./marketWorkerContract.js";
function useMarketSnapshot(client: WindowMarketClient) {
  return useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
}
function formatTime(value: number | null): string {
  if (value === null || value === undefined) return "尚未成功同步";
  try { return new Date(value).toLocaleString(); } catch { return String(value); }
}
function MarketCard({ market, refreshing, removing, onRefresh, onDiscard }: {
  market: MarketRecordSnapshot;
  refreshing: boolean;
  removing: boolean;
  onRefresh: (id: string) => void;
  onDiscard: (id: string) => void;
}) {
  return <div data-testid={`market-card-${market.id}`}>
    <p><strong>{market.name}</strong>{market.builtIn ? "（内置）" : ""}</p>
    <p className="apps-muted" data-testid={`market-url-${market.id}`}>{market.directoryUrl}</p>
    <p className="apps-muted" data-testid={`market-last-${market.id}`}>上次成功：{formatTime(market.lastSuccessAt)}</p>
    {market.lastError && <p role="alert" data-testid={`market-error-${market.id}`}>最近错误：{market.lastError}</p>}
    {!!market.lastRejected.length && <div data-testid={`market-rejected-${market.id}`}>
      <p className="apps-muted">本轮部分拒绝：</p>
      <ul>{market.lastRejected.map((item, index) => <li key={`${item.sourceId}:${item.appPublicKeyHex}:${index}`}>{item.appPublicKeyHex}（{item.sourceId}）：{item.status}{item.reason ? `：${item.reason}` : ""}</li>)}</ul>
    </div>}
    <div style={{ display: "flex", gap: "0.5rem" }}>
      {/* 指定市场刷新使用独立状态：挂起只禁用该市场按钮，手工操作与其他市场不受影响。 */}
      <Button variant="ghost" disabled={refreshing || removing} data-testid={`market-refresh-${market.id}`} onClick={() => onRefresh(market.id)}>刷新此市场</Button>
      {!market.builtIn && <Button variant="secondary" disabled={removing} data-testid={`market-discard-${market.id}`} onClick={() => onDiscard(market.id)}>移除市场</Button>}
    </div>
  </div>;
}
/** `/settings/market`：多市场配置与同步、手工来源与待验证项管理。 */
export function MarketSettingsPage({ market }: { market: WindowMarketClient }) {
  const snapshot = useMarketSnapshot(market);
  const [url, setUrl] = useState("");
  const [marketName, setMarketName] = useState("");
  const [marketURL, setMarketURL] = useState("");
  const [busy, setBusy] = useState(false);
  const [removingMarket, setRemovingMarket] = useState<string>();
  const [syncing, setSyncing] = useState(false);
  const [marketBusy, setMarketBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string>();
  const run = async (work: () => Promise<unknown>, failure: string) => {
    if (busy) return; setBusy(true); setError(undefined);
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : failure); } finally { setBusy(false); }
  };
  // 全部同步使用独立状态：任一市场请求挂起时只禁用全部按钮，手工操作不受影响。
  const runSyncAll = async () => {
    if (syncing) return; setSyncing(true); setError(undefined);
    try { await market.syncNow(); } catch (cause) { setError(cause instanceof Error ? cause.message : "同步失败，请稍后重试。"); } finally { setSyncing(false); }
  };
  const runSyncOne = async (marketId: string) => {
    if (marketBusy.has(marketId)) return;
    setMarketBusy(current => new Set(current).add(marketId)); setError(undefined);
    try { await market.syncNow(marketId); } catch (cause) { setError(cause instanceof Error ? cause.message : "同步失败，请稍后重试。"); } finally {
      setMarketBusy(current => {
        const next = new Set(current);
        next.delete(marketId);
        return next;
      });
    }
  };
  const runDiscard = async (marketId: string) => {
    if (removingMarket !== undefined) return;
    setRemovingMarket(marketId); setError(undefined);
    try { await market.discardMarket(marketId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "移除失败，请稍后重试。"); }
    finally { setRemovingMarket(undefined); }
  };
  return <div className="apps-page apps-market" data-testid="market-settings-page">
    <PageHeader title="市场来源" description="管理市场同步与手工来源。应用目录只由 Connect 按来源写入。" />
    {market.unavailableReason && <p role="alert">{market.unavailableReason}</p>}
    {error && <p role="alert">{error}</p>}
    <section aria-labelledby="market-sync-title">
      <h2 id="market-sync-title">市场目录</h2>
      <p className="apps-muted" data-testid="market-sync-count">已应用市场条目：{snapshot.appliedMarketCount}</p>
      <Button data-testid="market-sync-now" disabled={syncing || marketBusy.size > 0} onClick={() => void runSyncAll()}>{syncing ? "全部同步中…" : "全部同步"}</Button>
      <div style={{ display: "grid", gap: "1rem" }}>{snapshot.markets.map(item =>
        <MarketCard key={item.id} market={item} refreshing={marketBusy.has(item.id)} removing={removingMarket !== undefined} onRefresh={id => void runSyncOne(id)} onDiscard={id => void runDiscard(id)} />)}</div>
    </section>
    <section aria-labelledby="market-configure-title">
      <h2 id="market-configure-title">添加第三方市场</h2>
      <form onSubmit={event => {
        event.preventDefault();
        void run(() => market.configureMarket({ name: marketName.trim(), directoryUrl: marketURL.trim() }).then(() => { setMarketName(""); setMarketURL(""); }), "登记失败，请检查目录地址。");
      }}>
        <label>市场名称<TextInput value={marketName} onChange={event => setMarketName(event.currentTarget.value)} data-testid="market-configure-name" /></label>
        <label>完整目录 URL<TextInput value={marketURL} onChange={event => setMarketURL(event.currentTarget.value)} placeholder="https://example.com/v1/apps 或静态 JSON" data-testid="market-configure-url" /></label>
        <p className="apps-muted">第三方市场可使用任何路径或静态托管的 JSON 目录；同一目录地址只登记一次。</p>
        <Button type="submit" disabled={busy || !marketName.trim() || !marketURL.trim()} data-testid="market-configure-add">登记市场</Button>
      </form>
    </section>
    <section aria-labelledby="market-manual-title">
      <h2 id="market-manual-title">手工来源</h2>
      <form onSubmit={event => {
        event.preventDefault();
        void run(() => market.addManual({ url: url.trim() }).then(() => { setUrl(""); }), "添加失败，请检查输入后重试。");
      }}>
        <label>应用网址（URL）<TextInput value={url} onChange={event => setUrl(event.currentTarget.value)} placeholder="https://" data-testid="market-manual-url" /></label>
        <p className="apps-muted">仅支持 URL 手工来源；Files 应用请使用 CLI 完成本地部署验证。</p>
        <Button type="submit" disabled={busy || !url.trim()} data-testid="market-manual-add">添加待验证项</Button>
      </form>
      {!snapshot.manual.length && !snapshot.pending.length && <p className="apps-muted">暂无手工来源或待验证项。</p>}
      {!!snapshot.manual.length && <>
        <h3>已验证手工来源</h3>
        <ul>{snapshot.manual.map(item => <li key={item.pendingId} data-testid={`market-manual-${item.pendingId}`}>
          <p>{item.verifiedPublication?.name ?? "已验证应用"}（{item.verifiedPublication?.appPublicKeyHex}，版本 {item.verifiedPublication?.appVersion}）</p>
          <p className="apps-muted">同步：{item.syncStatus === "synced" ? "已同步" : item.syncStatus === "lower-version" ? "已验证，版本较低，未更新目录" : item.syncStatus === "sync-failed" ? `同步失败：${item.syncError ?? ""}` : "待同步"}</p>
          {item.syncError && item.syncStatus !== "lower-version" && <p role="alert">{item.syncError}</p>}
          <Button variant="ghost" disabled={busy} onClick={() => void run(() => market.retry(item.pendingId), "重试失败。")}>重试同步</Button>
          <Button variant="secondary" disabled={busy} onClick={() => void run(() => market.remove(item.pendingId), "移除失败。")}>移除</Button>
        </li>)}</ul>
      </>}
      {!!snapshot.pending.length && <>
        <h3>待验证项</h3>
        <ul>{snapshot.pending.map(item => <li key={item.pendingId} data-testid={`market-pending-${item.pendingId}`}>
          <p>{item.url ?? ""}（{item.validation === "failed" ? "验证失败" : "验证中"}）</p>
          {item.validationError && <p role="alert">{item.validationError}</p>}
          <Button variant="ghost" disabled={busy} onClick={() => void run(() => market.retry(item.pendingId), "重试失败。")}>重试验证</Button>
          <Button variant="secondary" disabled={busy} onClick={() => void run(() => market.remove(item.pendingId), "移除失败。")}>移除</Button>
        </li>)}</ul>
      </>}
    </section>
  </div>;
}
