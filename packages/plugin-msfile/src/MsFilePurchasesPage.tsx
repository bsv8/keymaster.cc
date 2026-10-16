import { MsFileFundingPoolsTable } from "./MsFileFundingPoolsTable.js";
import { useEffect, useRef, useState } from "react";
import { useOptionalPluginCapability } from "webloom-framework/react";
import { AppLink, usePluginI18n, useResourceViewSelector } from "@keymaster/runtime";
import { MSFILE_SERVICE_CAPABILITY, sameWalletSession, type MsFileBitfsTaskSnapshot, type VaultLifecycleSnapshot, type VaultStatus } from "@keymaster/contracts";
import { MSFILE_BUCKET_SERVICE_CAPABILITY, type MsFileBucketService } from "./msfileBucketService.js";
import { useMsFileResources } from "./MsFileResourceContext.js";
import { ArbitrationPanel } from "./ArbitrationPanel.js";

export const purchaseDetailPath = (sessionId: string) => `/msfile/purchases/${encodeURIComponent(sessionId)}`;

/** 页面世代隔离：切 Key、锁定、重新登录均销毁旧数据和在途操作的 UI。 */
export function MsFilePurchasesPage({ sessionId }: { sessionId?: string }) {
  const service = useOptionalPluginCapability(MSFILE_BUCKET_SERVICE_CAPABILITY);
  const reader = useMsFileResources();
  const vault = useResourceViewSelector<VaultStatus, VaultStatus>(reader, "msfile.ui.vault-status", [], value => value.data ?? "locked");
  const lifecycle = useResourceViewSelector<VaultLifecycleSnapshot, VaultLifecycleSnapshot>(reader, "msfile.home.lifecycle", [],
    value => value.data ?? { status: "booting", sessionEpoch: "boot", runGeneration: "boot", vaultLifecycleRevision: 0 }, sameWalletSession);
  const { t } = usePluginI18n();
  if (!service || vault !== "unlocked" || !lifecycle.activePublicKeyHex) return <p>{t("msfile.purchases.locked", { defaultValue: "请解锁当前 Key 后查看购买记录。" })}</p>;
  return <PurchaseRecords key={JSON.stringify([lifecycle.activePublicKeyHex, lifecycle.sessionEpoch, lifecycle.runGeneration, lifecycle.walletGeneration, sessionId])} service={service} sessionId={sessionId} />;
}

function PurchaseRecords({ service, sessionId }: { service: MsFileBucketService; sessionId?: string }) {
  const { t } = usePluginI18n();
  const arbitration = useOptionalPluginCapability(MSFILE_SERVICE_CAPABILITY);
  const [records, setRecords] = useState<MsFileBitfsTaskSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [fundingRevision, setFundingRevision] = useState(0);
  const mounted = useRef(true);
  const request = useRef(0);
  // 列表只读；核对、重连、关池和退款必须经详情页点击发起。
  const refresh = async () => {
    const version = ++request.current;
    try {
      if (!service.listBitfsTasks) throw new Error(t("msfile.purchases.unavailable", { defaultValue: "购买记录服务当前不可用。" }));
      const next = await service.listBitfsTasks();
      if (mounted.current && version === request.current) {
        setRecords(next.filter(item => !item.discoveryOnly).sort((a, b) => (b.createdAt ?? b.updatedAt ?? "").localeCompare(a.createdAt ?? a.updatedAt ?? "")));
        setError("");
      }
    } catch (cause) {
      if (mounted.current && version === request.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (mounted.current && version === request.current) setLoading(false); }
  };
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 5000);
    return () => { mounted.current = false; request.current++; clearInterval(timer); };
  }, [service]);
  const operate = async (action: () => Promise<void>) => {
    setBusy(true); setActionError("");
    try { await action(); if (mounted.current) { setDeleteConfirm(false); setClearConfirm(false); setFundingRevision(value => value + 1); await refresh(); } }
    catch (cause) { if (mounted.current) setActionError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const selected = sessionId ? records.find(item => item.sessionId === sessionId) : undefined;
  const history = records.filter(item => !item.historyDeleted);
  const phase = (item: MsFileBitfsTaskSnapshot) => t(`msfile.bucket.bitfs.phase.${item.phase}`, { defaultValue: item.phase });
  const taskLabel = (item: MsFileBitfsTaskSnapshot) => item.taskState === "active" ? t("msfile.purchases.task.active", { defaultValue: "进行中" }) : item.taskState === "ended" ? t("msfile.purchases.task.ended", { defaultValue: "已结束" }) : "—";
  const reasonLabel = (item: MsFileBitfsTaskSnapshot) => item.taskEndReason ? t(`msfile.purchases.task.reason.${item.taskEndReason}`, { defaultValue: item.taskEndReason }) : "—";
  const fundingLabel = (item: MsFileBitfsTaskSnapshot) => t(`msfile.purchases.funding.${item.fundingState ?? "unknown"}`, { defaultValue: "资金状态待核对" });
  const money = (value: string | null | undefined) => value == null ? "—" : `${value} sats`;
  return <section className="msfile-purchases">
    <header className="msfile-purchases__toolbar">
      <h2>{t(sessionId ? "msfile.purchases.detailTitle" : "msfile.purchases.title", { defaultValue: sessionId ? "购买详情" : "购买历史" })}</h2>
      <AppLink to={sessionId ? "/msfile/purchases" : "/msfile/files"}>{t(sessionId ? "msfile.purchases.backHistory" : "msfile.purchases.download", { defaultValue: sessionId ? "返回购买历史" : "下载文件" })}</AppLink>
      <button disabled={busy || loading} onClick={() => { setFundingRevision(value => value + 1); void refresh(); }}>{t("msfile.purchases.refresh", { defaultValue: "刷新记录" })}</button>
    </header>
    {!sessionId && service.deleteBitfsHistory && history.length > 0 ? <div className="msfile-purchases__delete">
      {!clearConfirm ? <button disabled={busy} onClick={() => setClearConfirm(true)}>清空采购历史</button> : <div role="group" aria-label="确认清空采购历史">
        <p>清空当前 Key 的全部采购历史与可清理日志，保留正式文件。未结清费用池和必要证据继续保留在下方独立表中；不会自动关池或退款。</p>
        <button disabled={busy} onClick={() => void operate(async () => {
          const tasks = new Map(history.map(item => [`${item.seedHashHex}:${item.taskId ?? item.sessionId}`, item]));
          for (const item of tasks.values()) {
            if (!mounted.current) return;
            await service.deleteBitfsHistory!(item.seedHashHex, item.sessionId);
          }
        })}>确认清空采购历史</button>
        <button disabled={busy} onClick={() => setClearConfirm(false)}>返回</button>
      </div>}
    </div> : null}
    {error || actionError ? <p role="alert">{error || actionError}</p> : null}
    {loading ? <p role="status">{t("msfile.purchases.loading", { defaultValue: "正在读取购买记录…" })}</p> : null}
    {!loading && !error && (sessionId ? !selected : history.length === 0) ? <p>{t(sessionId ? "msfile.purchases.notFound" : "msfile.purchases.empty", { defaultValue: sessionId ? "当前 Key 下没有这条购买记录。" : "当前 Key 暂无购买记录。" })}</p> : null}
    {!sessionId ? <div className="msfile-purchases__scroll"><table className="msfile-purchases__table">
      <thead><tr>
        <th>{t("msfile.purchases.file", { defaultValue: "文件" })}</th><th>Seed Hash</th>
        <th>{t("msfile.purchases.created", { defaultValue: "购买时间" })}</th>
        <th>{t("msfile.purchases.taskState", { defaultValue: "任务状态" })}</th>
        <th>{t("msfile.purchases.taskReason", { defaultValue: "结束原因" })}</th>
        <th>{t("msfile.purchases.status", { defaultValue: "购买状态" })}</th>
        <th>{t("msfile.purchases.funding", { defaultValue: "资金状态" })}</th>
        <th className="numeric">{t("msfile.purchases.progress", { defaultValue: "已验收 Block" })}</th>
        <th className="numeric">{t("msfile.bucket.bitfs.paid", { defaultValue: "已付卖家" })}</th>
        <th className="numeric">{t("msfile.bucket.bitfs.locked", { defaultValue: "受保护金额" })}</th>
        <th>{t("msfile.purchases.action", { defaultValue: "操作" })}</th>
      </tr></thead>
      <tbody>{history.map(item => <tr key={item.sessionId}>
        <td className="msfile-purchases__filename" title={item.recommendedFilename ?? item.seedHashHex}><AppLink to={purchaseDetailPath(item.sessionId)}>{item.recommendedFilename ?? "—"}</AppLink></td>
        <td><code title={item.seedHashHex}>{item.seedHashHex.slice(0, 10)}…{item.seedHashHex.slice(-6)}</code></td>
        <td className="msfile-purchases__time">{item.createdAt ? new Date(item.createdAt).toLocaleString() : "—"}</td>
        <td>{taskLabel(item)}</td><td>{reasonLabel(item)}</td><td>{phase(item)}</td><td>{fundingLabel(item)}</td>
        <td className="numeric">{item.verifiedBlockCount} / {item.totalBlockCount ?? "—"}</td>
        <td className="numeric">{money(item.paidSatoshis)}</td><td className="numeric">{money(item.lockedSatoshis)}</td>
        <td><AppLink to={purchaseDetailPath(item.sessionId)}>{t("msfile.purchases.details", { defaultValue: "查看购买详情" })}</AppLink></td>
      </tr>)}</tbody>
    </table></div> : null}
    {!sessionId ? <MsFileFundingPoolsTable service={service} revision={fundingRevision} /> : null}
    {selected ? <div className="msfile-purchases__detail">
      {selected.historyDeleted ? <p role="status">采购历史已删除；这里只保留原费用池的资金恢复记录和必要证据。</p> : null}
      <h3>{selected.recommendedFilename ?? selected.seedHashHex}</h3>
      <p>{taskLabel(selected)} · {reasonLabel(selected)} · {phase(selected)} · {fundingLabel(selected)}</p>
      {selected.message ? <p>{selected.message}</p> : null}
      <table className="msfile-purchases__table msfile-purchases__fields"><tbody>
        <tr><th scope="row">{t("msfile.purchases.id", { defaultValue: "购买编号" })}</th><td><code>{selected.sessionId}</code></td></tr>
        <tr><th scope="row">{t("msfile.purchases.taskId", { defaultValue: "文件任务编号" })}</th><td><code>{selected.taskId ?? "—"}</code></td></tr>
        <tr><th scope="row">Seed Hash</th><td><code>{selected.seedHashHex}</code></td></tr>
        <tr><th scope="row">{t("msfile.purchases.seller", { defaultValue: "卖家" })}</th><td><code>{selected.sellerPublicKeyHex ?? "—"}</code></td></tr>
        <tr><th scope="row">{t("msfile.purchases.created", { defaultValue: "购买时间" })}</th><td>{selected.createdAt ? new Date(selected.createdAt).toLocaleString() : "—"}</td></tr>
        <tr className="msfile-purchases__group"><th colSpan={2}>{t("msfile.purchases.amounts", { defaultValue: "费用与资金" })}</th></tr>
        <tr><th scope="row">{t("msfile.purchases.budget", { defaultValue: "该次购买的开池预算" })}</th><td>{money(selected.openingAmountSatoshis)}</td></tr>
        <tr><th scope="row">{t("msfile.bucket.bitfs.paid", { defaultValue: "已付卖家" })}</th><td>{money(selected.paidSatoshis)}</td></tr>
        <tr><th scope="row">{t("msfile.bucket.bitfs.minerFee", { defaultValue: "已知矿工费" })}</th><td>{money(selected.minerFeeSatoshis)}</td></tr>
        <tr><th scope="row">{t("msfile.bucket.bitfs.locked", { defaultValue: "受保护金额" })}</th><td>{money(selected.lockedSatoshis)}</td></tr>
        <tr><th scope="row">{t("msfile.bucket.bitfs.pendingReturn", { defaultValue: "待回收金额" })}</th><td>{money(selected.pendingReturnSatoshis)}</td></tr>
        <tr className="msfile-purchases__group"><th colSpan={2}>{t("msfile.purchases.pool", { defaultValue: "费用池" })}</th></tr>
        <tr><th scope="row">{t("msfile.purchases.transaction", { defaultValue: "开池交易" })}</th><td><code>{selected.fundingTxid ?? "—"}</code></td></tr>
        <tr><th scope="row">{t("msfile.purchases.outpoint", { defaultValue: "费用池输出" })}</th><td><code>{selected.poolOutpoint ?? "—"}</code></td></tr>
        <tr><th scope="row">{t("msfile.purchases.refundLock", { defaultValue: "退款解锁值" })}</th><td>{selected.refundLockTime ?? "—"}</td></tr>
        <tr><th scope="row">{t("msfile.purchases.progress", { defaultValue: "已验收 Block" })}</th><td>{selected.verifiedBlockCount} / {selected.totalBlockCount ?? "—"}</td></tr>
      </tbody></table>
      {selected.fundingState === "not-opened" ? <p>{t("msfile.purchases.noPool", { defaultValue: "该次购买尚未开成费用池；保存的预算不代表资金已经锁入池中。" })}</p> : null}
      <div className="msfile-purchases__actions">
        {service.reconcileBitfsTask ? <button disabled={busy} onClick={() => void operate(() => service.reconcileBitfsTask!(selected.seedHashHex, selected.sessionId))}>{t("msfile.purchases.reconcile", { defaultValue: "核对资金／处理到期退款" })}</button> : null}
        {selected.canReconnect && service.reconnectBitfsTask ? <button disabled={busy} onClick={() => void operate(() => service.reconnectBitfsTask!(selected.seedHashHex, selected.sessionId))}>{t("msfile.purchases.reconnect", { defaultValue: "重新连接卖家" })}</button> : null}
        {selected.canCancel && service.cancelBitfsTask ? <button disabled={busy} onClick={() => void operate(() => service.cancelBitfsTask!(selected.seedHashHex, selected.sessionId))}>{t(selected.fundingState === "not-opened" ? "msfile.purchases.cancel" : "msfile.purchases.close", { defaultValue: selected.fundingState === "not-opened" ? "取消未开池购买" : "取消下载并与卖家协商关池" })}</button> : null}
      </div>
      {service.deleteBitfsHistory ? <div className="msfile-purchases__delete">
        {!deleteConfirm ? <button disabled={busy} onClick={() => setDeleteConfirm(true)}>{selected.historyDeleted ? "清理已处理的恢复记录" : "删除本次采购记录"}</button> : <div role="group" aria-label="确认删除采购记录">
          <p>删除本次文件任务的采购历史和可清理日志，保留正式文件。未结清费用池及必要证据继续保留在“待处理费用池”，不会自动关池或退款。</p>
          <button disabled={busy} onClick={() => void operate(() => service.deleteBitfsHistory!(selected.seedHashHex, selected.sessionId))}>确认删除采购记录</button>
          <button disabled={busy} onClick={() => setDeleteConfirm(false)}>返回</button>
        </div>}
      </div> : null}
      {arbitration ? <ArbitrationPanel service={arbitration} sessionId={selected.sessionId} role="buyer" /> : null}
    </div> : null}
  </section>;
}
