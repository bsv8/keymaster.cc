// SatSubscription 系统设置页。
//
// 本页只操作 trusted admin service；不读取私钥、Channel 明文或完整 Wire。
// 连接/订阅失败保留服务端最后状态，不在页面偷偷重试收费动作。

import { useCallback, useState } from "react";
import type {
  SatOwnerSupplierSettingsV1,
  SatSubscriptionAdminService,
  SatSubscriptionSpiService,
  SatSubscriptionSettingsSnapshot,
  SatSupplierConfigV1,
  SatTopUpPreview,
  SatSpiInformation,
  SatSpiCurrencyBalance
} from "@keymaster/contracts";
import { SAT_SUBSCRIPTION_SERVICE_CAPABILITY, SAT_SUBSCRIPTION_SPI_SERVICE_CAPABILITY } from "@keymaster/contracts";
import { useCapability, useI18n, usePluginHost, useResourceSelector } from "@keymaster/runtime";
import { Button } from "@keymaster/ui";

function emptyDraft(): SatSupplierConfigV1 {
  return { supplierId: "", name: "", supplierPublicKeyHex: "", multiaddrs: [""], enabled: true };
}

/** 把 transport/SSP/SPI 的稳定错误码转换成用户可读的中文。 */
function satErrorMessage(cause: unknown): string {
  const code = cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string"
    ? (cause as { code: string }).code
    : "";
  const labels: Record<string, string> = {
    locked: "钱包已锁定",
    unavailable: "Sat 服务暂不可用",
    connect: "无法连接供应商",
    identity: "供应商身份校验失败",
    protocol: "协议响应无效",
    balance: "供应商余额不足或金额超限",
    unknown_result: "请求结果未知，请先核对余额/审计再重试",
    validation: "输入参数无效",
    conflict: "配置或请求已发生冲突",
    config: "供应商配置无效"
  };
  const detail = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "操作失败";
  return labels[code] ? `${labels[code]}：${detail}` : `SatSubscription 操作失败：${detail}`;
}

function bsvNetworkLabel(network: string): string {
  if (network === "mainnet") return "BSV 主网";
  if (network === "testnet") return "BSV 测试网";
  return `BSV/${network}`;
}

export function SatSubscriptionSettings() {
  const { t } = useI18n();
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const host = usePluginHost();
  const service = useCapability<SatSubscriptionAdminService>(SAT_SUBSCRIPTION_SERVICE_CAPABILITY);
  const spi = useCapability<SatSubscriptionSpiService>(SAT_SUBSCRIPTION_SPI_SERVICE_CAPABILITY);
  const snapshot = useResourceSelector<
    SatSubscriptionSettingsSnapshot,
    SatSubscriptionSettingsSnapshot | null
  >(
    host.resourceStore,
    "sat-subscription.settings",
    [],
    (resource) => resource.data ?? null,
    (left, right) => JSON.stringify(left) === JSON.stringify(right)
  );
  const [draft, setDraft] = useState<SatSupplierConfigV1>(emptyDraft);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [spiInfo, setSpiInfo] = useState<Record<string, SatSpiInformation>>({});
  const [topUpAmount, setTopUpAmount] = useState("1000");
  const [collectAmount, setCollectAmount] = useState("1000");
  const [topUpPreview, setTopUpPreview] = useState<SatTopUpPreview | null>(null);

  const reload = useCallback(() => {
    host.resourceStore.invalidate("sat-subscription.settings", []);
  }, [host.resourceStore]);

  const saveSupplier = async () => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      await service.upsertSupplier({ ...draft, multiaddrs: draft.multiaddrs.filter((value) => value.length > 0) });
      setDraft(emptyDraft());
      setMessage(tr("sat.settings.saved", "供应商配置已保存"));
      await reload();
    } catch (cause) {
      setError(satErrorMessage(cause));
    } finally { setBusy(false); }
  };

  const editSupplier = (supplier: SatSupplierConfigV1) => {
    setDraft({ ...supplier, multiaddrs: [...supplier.multiaddrs] });
    setMessage(tr("sat.settings.editing", `正在编辑供应商 ${supplier.supplierId}`));
    setError(null);
  };

  const setDefault = async (supplierId: string) => {
    if (!snapshot?.ownerSettings) return;
    setBusy(true);
    try {
      await service.setOwnerSettings({ ...snapshot.ownerSettings, defaultPublishSupplierId: supplierId });
      await reload();
    } catch (cause) { setError(satErrorMessage(cause)); }
    finally { setBusy(false); }
  };

  const toggleEnabled = async (supplier: SatSupplierConfigV1) => {
    setBusy(true);
    setError(null);
    try {
      await service.upsertSupplier({ ...supplier, multiaddrs: [...supplier.multiaddrs], enabled: !supplier.enabled });
      setMessage(!supplier.enabled ? tr("sat.settings.enabled", "供应商已启用") : tr("sat.settings.disabled", "供应商已停用"));
      await reload();
    } catch (cause) { setError(satErrorMessage(cause)); }
    finally { setBusy(false); }
  };

  const toggleReceive = async (supplierId: string) => {
    if (!snapshot?.ownerSettings) return;
    const receiving = snapshot.ownerSettings.receiveSupplierIds.includes(supplierId);
    setBusy(true);
    try {
      // 设置页只修改 owner 的接收 Supplier 意图；实际 Supplier/频道三元组
      // 的 Subscribe/Unsubscribe 由 Coordinator 统一对账，避免这里与 Mux
      // 各发一次收费请求。
      const next: SatOwnerSupplierSettingsV1 = {
        ...snapshot.ownerSettings,
        receiveSupplierIds: receiving
          ? snapshot.ownerSettings.receiveSupplierIds.filter((id) => id !== supplierId)
          : [...new Set([...snapshot.ownerSettings.receiveSupplierIds, supplierId])]
      };
      await service.setOwnerSettings(next);
      setMessage(receiving ? "已关闭接收意图，Coordinator 将继续对账退订" : "已保存接收意图，Coordinator 将继续对账订阅");
      await reload();
    } catch (cause) { setError(satErrorMessage(cause)); }
    finally { setBusy(false); }
  };

  const refreshSubscriptions = async (supplierId: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await service.refreshSubscriptions({ supplierId });
      setMessage(tr("sat.settings.subscriptions.refreshed", `已刷新远端订阅（${result.channels.length} 个频道）`));
      await reload();
    } catch (cause) { setError(satErrorMessage(cause)); }
    finally { setBusy(false); }
  };

  const refreshSpi = async (supplierId: string) => {
    setBusy(true);
    setError(null);
    try {
      const value = await spi.getInformation({ supplierId });
      setSpiInfo((current) => ({ ...current, [supplierId]: value }));
    } catch (cause) { setError(satErrorMessage(cause)); }
    finally { setBusy(false); }
  };

  const prepareTopUp = async (supplierId: string, account: SatSpiCurrencyBalance) => {
    if (!/^[1-9][0-9]*$/.test(topUpAmount)) { setError("充值金额必须是正整数 satoshis"); return; }
    setBusy(true);
    setError(null);
    try {
      setTopUpPreview(await spi.prepareTopUp({
        supplierId,
        currency: account.currency,
        network: account.network,
        amountSatoshis: BigInt(topUpAmount)
      }));
    } catch (cause) { setError(satErrorMessage(cause)); }
    finally { setBusy(false); }
  };

  const submitTopUp = async () => {
    if (!topUpPreview) return;
    const preview = topUpPreview;
    const raw = preview.p2pkhPreview && typeof preview.p2pkhPreview === "object" ? preview.p2pkhPreview as Record<string, unknown> : {};
    const confirmed = typeof window === "undefined" || window.confirm(`确认向 ${bsvNetworkLabel(preview.network)}账户 ${preview.paymentAddress} 充值 ${preview.amountSatoshis.toString()} satoshis？\n找零地址：${String(raw.changeAddress ?? "未知")}\n预计矿工费：${String(raw.estimatedFeeSatoshis ?? "未知")}`);
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      const result = await spi.submitTopUp(preview);
      setMessage(`充值结果：${result.status}${result.txid ? `，txid=${result.txid}` : ""}`);
      setTopUpPreview(null);
    } catch (cause) { setError(satErrorMessage(cause)); }
    finally { setBusy(false); }
  };

  const collect = async (supplierId: string, account: SatSpiCurrencyBalance) => {
    if (!/^[1-9][0-9]*$/.test(collectAmount)) { setError("回收金额必须是正整数 satoshis"); return; }
    const confirmed = typeof window === "undefined" || window.confirm(`确认从 ${bsvNetworkLabel(account.network)}账户 ${account.paymentAddress} 回收 ${collectAmount} satoshis 到当前 owner 的${bsvNetworkLabel(account.network)}地址？`);
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      const result = await spi.collectNew({ supplierId, currency: account.currency, network: account.network, amount: BigInt(collectAmount) });
      setMessage(`Collect 结果：${result.state}${result.errorCode ? `（${result.errorCode}）` : ""}`);
      await refreshSpi(supplierId);
    } catch (cause) { setError(satErrorMessage(cause)); }
    finally { setBusy(false); }
  };

  const deleteSupplier = async (supplier: SatSupplierConfigV1) => {
    const confirmed = typeof window === "undefined" || window.confirm(
      tr("sat.settings.deleteConfirm", `确认删除供应商 ${supplier.name || supplier.supplierId}？删除不会自动回收该供应商余额。`)
    );
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await service.deleteSupplier(supplier.supplierId);
      if (draft.supplierId === supplier.supplierId) setDraft(emptyDraft());
      setMessage(tr("sat.settings.deleted", "供应商已删除；余额不会自动回收。"));
      await reload();
    } catch (cause) { setError(satErrorMessage(cause)); }
    finally { setBusy(false); }
  };

  return (
    <section className="settings-page sat-subscription-settings">
      <h1>{tr("sat.settings.title", "SatSubscription")}</h1>
      <p>{tr("sat.settings.description", "多供应商 SSP 订阅、Channel 物理传输和 SPI 账户管理。Subscribe 与自动 ACK 可能产生费用。")}</p>
      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <h2>{tr("sat.settings.suppliers", "供应商")}</h2>
      {snapshot?.suppliers.length ? snapshot.suppliers.map((supplier) => {
        const receiving = snapshot.ownerSettings?.receiveSupplierIds.includes(supplier.supplierId) ?? false;
        const view = snapshot.supplierViews.find((item) => item.supplierId === supplier.supplierId);
        return (
          <div key={supplier.supplierId} className="sat-subscription-settings__supplier">
            <strong>{supplier.name}</strong> <code>{supplier.supplierId}</code>
            <div>{tr("sat.settings.identity", "认证公钥")}: <code>{supplier.supplierPublicKeyHex}</code></div>
            <div>{tr("sat.settings.connection", "连接")}: {view?.connectionState ?? "disconnected"}；{supplier.enabled ? tr("sat.settings.enabled", "已启用") : tr("sat.settings.disabled", "已停用")}</div>
            <div>{tr("sat.settings.desired", "期望订阅")}: {view?.desiredChannels.length ? view.desiredChannels.join(", ") : tr("sat.settings.none", "无")}；{tr("sat.settings.observed", "远端观察")}: {view?.observedChannels.length ? view.observedChannels.join(", ") : tr("sat.settings.none", "无")}</div>
            <div>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void refreshSpi(supplier.supplierId)}>{tr("sat.settings.spi.refresh", "刷新 SPI 余额")}</Button>
              <Button size="sm" variant="secondary" disabled={busy || !supplier.enabled} onClick={() => void refreshSubscriptions(supplier.supplierId)}>{tr("sat.settings.subscriptions.refresh", "刷新远端订阅")}</Button>
              {spiInfo[supplier.supplierId]?.currencies.map((currency) => <span key={`${currency.currency}-${currency.network}`} className="sat-subscription-settings__spi-account"> {currency.currency}/{currency.network}: <code>{currency.balance.toString(10)}</code>（充值地址 <code>{currency.paymentAddress}</code>）{currency.currency === "BSV" ? <> <Button size="sm" variant="secondary" disabled={busy} onClick={() => void prepareTopUp(supplier.supplierId, currency)}>{tr("sat.settings.spi.prepare", "生成充值预览")}</Button> <Button size="sm" variant="secondary" disabled={busy} onClick={() => void collect(supplier.supplierId, currency)}>{tr("sat.settings.spi.collect", "回收余额")}</Button></> : null}</span>)}
            </div>
            <div>
              <input aria-label={tr("sat.settings.spi.topupAmount", "充值 satoshis")} value={topUpAmount} onChange={(event) => setTopUpAmount(event.target.value)} inputMode="numeric" />
              <input aria-label={tr("sat.settings.spi.collectAmount", "回收 satoshis")} value={collectAmount} onChange={(event) => setCollectAmount(event.target.value)} inputMode="numeric" />
              <span>请先刷新 SPI 并在对应 BSV 账户行操作</span>
            </div>
            <div>{tr("sat.settings.actions", "操作")}: <Button size="sm" variant="secondary" disabled={busy} onClick={() => editSupplier(supplier)}>{tr("sat.settings.edit", "编辑")}</Button>{" "}<Button size="sm" variant="secondary" disabled={busy} onClick={() => void toggleEnabled(supplier)}>{supplier.enabled ? tr("sat.settings.disable", "停用") : tr("sat.settings.enable", "启用")}</Button>{" "}<Button size="sm" variant="secondary" disabled={busy || !supplier.enabled} onClick={() => void setDefault(supplier.supplierId)}>{tr("sat.settings.default", "设为默认发布")}</Button>{" "}<Button size="sm" variant="secondary" disabled={busy || !supplier.enabled} onClick={() => void toggleReceive(supplier.supplierId)}>{receiving ? tr("sat.settings.receive.off", "关闭接收") : tr("sat.settings.receive.on", "启用接收（可能收费）")}</Button>{" "}<Button size="sm" variant="danger" disabled={busy} onClick={() => void deleteSupplier(supplier)}>{tr("sat.settings.delete", "删除")}</Button></div>
          </div>
        );
      }) : <p>{tr("sat.settings.empty", "尚未配置供应商。")}</p>}
      <h3>{tr("sat.settings.add", "新增/更新供应商")}</h3>
      <input aria-label={tr("sat.settings.id", "供应商编号")} placeholder={tr("sat.settings.id", "供应商编号")} value={draft.supplierId} onChange={(event) => setDraft({ ...draft, supplierId: event.target.value })} />
      <input aria-label={tr("sat.settings.name", "名称")} placeholder={tr("sat.settings.name", "名称")} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
      <input aria-label={tr("sat.settings.key", "供应商公钥")} placeholder={tr("sat.settings.key", "供应商公钥（66 位小写 hex）")} value={draft.supplierPublicKeyHex} onChange={(event) => setDraft({ ...draft, supplierPublicKeyHex: event.target.value })} />
      <textarea aria-label={tr("sat.settings.addresses", "libp2p 地址")} placeholder={tr("sat.settings.addresses", "libp2p 地址，每行一个")} value={draft.multiaddrs.join("\n")} onChange={(event) => setDraft({ ...draft, multiaddrs: event.target.value.split("\n") })} />
      <label><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /> {tr("sat.settings.enabledField", "启用供应商")}</label>
      <Button disabled={busy} onClick={() => void saveSupplier()}>{tr("sat.settings.save", "保存供应商")}</Button>
      {topUpPreview ? <div role="dialog">
        <strong>{tr("sat.settings.spi.preview", "充值预览")}</strong>
        <div>网络: <strong>{bsvNetworkLabel(topUpPreview.network)}</strong>；Supplier: <code>{topUpPreview.supplierId}</code>；目标: <code>{topUpPreview.paymentAddress}</code>；金额: <code>{topUpPreview.amountSatoshis.toString(10)}</code> sats</div>
        <Button disabled={busy} onClick={() => void submitTopUp()}>{tr("sat.settings.spi.confirm", "确认并广播")}</Button>
        <Button disabled={busy} variant="secondary" onClick={() => setTopUpPreview(null)}>{tr("sat.settings.spi.cancel", "取消")}</Button>
      </div> : null}
      <h2>{tr("sat.settings.audit", "最近费用")}</h2>
      <ul>{snapshot?.feeAudit.slice(-20).reverse().map((item, index) => <li key={`${item.createdAtMs}-${index}`}>{item.supplierId} / {item.action} / {item.chargedAmount || tr("sat.settings.unknown", "未知")}</li>)}</ul>
    </section>
  );
}
