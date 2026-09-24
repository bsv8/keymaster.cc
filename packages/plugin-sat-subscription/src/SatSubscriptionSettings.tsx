// SatSubscription 广播网关页。
//
// 本页只操作 trusted admin service；不读取私钥、Channel 明文或完整 Wire。
// 连接/订阅失败保留服务端最后状态，不在页面偷偷重试收费动作。

import { useCallback, useState } from "react";
import type {
  SatOwnerSupplierSettingsV1,
  SatBillingPage,
  SatSubscriptionAdminService,
  SatSubscriptionSpiService,
  SatSubscriptionSettingsSnapshot,
  SatSupplierConfigV1,
  SatTopUpPreview,
  SatSpiInformation,
  SatSpiCurrencyBalance
} from "@keymaster/contracts";
import { SAT_SUBSCRIPTION_SERVICE_CAPABILITY, SAT_SUBSCRIPTION_SPI_SERVICE_CAPABILITY } from "@keymaster/contracts";
import { useOptionalCapability } from "webloom-framework/react";
import { useI18n, useOptionalResourceSelector, usePluginHost } from "@keymaster/runtime";
import { Button, Modal } from "@keymaster/ui";
import { SAT_DEFAULT_SUPPLIER_ID } from "./defaults.js";

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

/** 连接状态 → 红绿灯中文说明（字段中文解释，不要靠英文猜）。 */
function connectionStateLabel(state: string, tr: (key: string, fallback: string) => string): string {
  switch (state) {
    case "online":
      return tr("sat.settings.connectionState.online", "已连接（绿灯）");
    case "degraded":
      return tr("sat.settings.connectionState.degraded", "已降级（黄灯）");
    case "connecting":
      return tr("sat.settings.connectionState.connecting", "连接中（黄灯）");
    case "disabled":
      return tr("sat.settings.connectionState.disabled", "已停用（灰灯）");
    case "disconnected":
    default:
      return tr("sat.settings.connectionState.disconnected", "未连接（红灯）");
  }
}

/**
 * 红绿灯无障碍说明必须恒含中文（AGENTS：字段要有中文说明），与当前
 * 界面语言无关；e2e 只认 data-state + 该中文，避免英文环境误判。
 */
function connectionLightChinese(state: string): string {
  switch (state) {
    case "online": return "已连接";
    case "degraded": return "已降级";
    case "connecting": return "连接中";
    case "disabled": return "已停用";
    case "disconnected":
    default: return "未连接";
  }
}

/** 账单 bigint 毫秒 → 本地可读时间；解析失败时保留原文。 */
function formatBillingTime(occurredAtMs: bigint): string {
  const numeric = Number(occurredAtMs);
  if (!Number.isSafeInteger(numeric) || numeric < 0) return String(occurredAtMs);
  try {
    return new Date(numeric).toLocaleString();
  } catch {
    return String(occurredAtMs);
  }
}

const BILLING_PAGE_SIZE_OPTIONS = [2, 5, 10, 20] as const;
const DEFAULT_BILLING_LIMIT = 5;

export function SatSubscriptionSettings() {
  const { t } = useI18n();
  // owner 作用域 capability 会在锁定时撤销；设置区可能正好挂载在系统设置
  // 页面上，必须按"暂不可用"渲染而不是抛错。
  const service = useOptionalCapability(SAT_SUBSCRIPTION_SERVICE_CAPABILITY);
  const spi = useOptionalCapability(SAT_SUBSCRIPTION_SPI_SERVICE_CAPABILITY);
  if (!service || !spi) {
    return (
      <p className="sat-subscription-settings__unavailable">
        {t("sat.settings.unavailable", { defaultValue: "钱包已锁定或 SatSubscription 服务暂不可用；解锁后可继续配置。" })}
      </p>
    );
  }
  return <SatSubscriptionSettingsInner service={service} spi={spi} />;
}

function SatSubscriptionSettingsInner({
  service,
  spi
}: {
  service: SatSubscriptionAdminService;
  spi: SatSubscriptionSpiService;
}) {
  const { t } = useI18n();
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const host = usePluginHost();
  // 锁定时资源定义会被注销，选择器必须能降级为 null 而不是抛错。
  const snapshot = useOptionalResourceSelector<
    SatSubscriptionSettingsSnapshot,
    SatSubscriptionSettingsSnapshot | null
  >(
    host.resourceStore,
    "sat-subscription.settings",
    [],
    (resource) => resource.data ?? null,
    null
  );
  const [draft, setDraft] = useState<SatSupplierConfigV1>(emptyDraft);
  const [supplierEditorOpen, setSupplierEditorOpen] = useState(false);
  const [supplierEditorMode, setSupplierEditorMode] = useState<"create" | "edit">("create");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [spiInfo, setSpiInfo] = useState<Record<string, SatSpiInformation>>({});
  const [billing, setBilling] = useState<Record<string, SatBillingPage>>({});
  // 账单翻页会话：SS server 的 cursor 绑定 fromMs/toMs/limit（见 billing.go
  // billingCursorFingerprint），同一会话的上一页/下一页必须复用完全相同的
  // 时间范围与每页条数；只有“查询首页 / 切换每页条数”才创建新会话。
  interface BillingSession { fromMs: bigint; toMs: bigint; limit: number }
  const [billingSessions, setBillingSessions] = useState<Record<string, BillingSession>>({});
  const [billingHistories, setBillingHistories] = useState<Record<string, string[]>>({});
  const [topUpAmount, setTopUpAmount] = useState("1000");
  const [collectAmount, setCollectAmount] = useState("1000");
  const [topUpPreview, setTopUpPreview] = useState<SatTopUpPreview | null>(null);

  const reload = useCallback(() => {
    host.resourceStore.invalidate("sat-subscription.settings", []);
  }, [host.resourceStore]);

  const openSupplierEditor = () => {
    if (busy) return;
    setDraft(emptyDraft());
    setSupplierEditorMode("create");
    setMessage(null);
    setError(null);
    setSupplierEditorOpen(true);
  };

  const closeSupplierEditor = () => {
    if (busy) return;
    setSupplierEditorOpen(false);
    setSupplierEditorMode("create");
    setDraft(emptyDraft());
    setError(null);
  };

  const saveSupplier = async () => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      await service.upsertSupplier({ ...draft, multiaddrs: draft.multiaddrs.filter((value) => value.length > 0) });
      setSupplierEditorOpen(false);
      setSupplierEditorMode("create");
      setDraft(emptyDraft());
      setMessage(tr("sat.settings.saved", "供应商配置已保存"));
      await reload();
    } catch (cause) {
      setError(satErrorMessage(cause));
    } finally { setBusy(false); }
  };

  const editSupplier = (supplier: SatSupplierConfigV1) => {
    if (busy) return;
    setDraft({ ...supplier, multiaddrs: [...supplier.multiaddrs] });
    setSupplierEditorMode("edit");
    setMessage(null);
    setError(null);
    setSupplierEditorOpen(true);
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

  const getBillingSession = (supplierId: string): BillingSession | undefined => billingSessions[supplierId];
  const getBillingLimit = (supplierId: string): number => billingSessions[supplierId]?.limit ?? DEFAULT_BILLING_LIMIT;
  const getBillingHistory = (supplierId: string): string[] => billingHistories[supplierId] ?? [""];

  const queryBillingWithSession = async (supplierId: string, cursor: string, session: BillingSession, nextHistory: string[]) => {
    setBusy(true);
    setError(null);
    try {
      const page = await service.getBilling({
        supplierId,
        fromMs: session.fromMs,
        toMs: session.toMs,
        limit: session.limit,
        cursor
      });
      setBilling((current) => ({ ...current, [supplierId]: page }));
      setBillingSessions((current) => ({ ...current, [supplierId]: session }));
      setBillingHistories((current) => ({ ...current, [supplierId]: nextHistory }));
      const pageNo = nextHistory.length;
      const more = page.nextCursor ? tr("sat.settings.billing.hasMore", "还有下一页") : tr("sat.settings.billing.noMore", "已是最后一页");
      setMessage(tr("sat.settings.billing.refreshed", `已从 SS server 查询第 ${pageNo} 页 ${page.records.length} 条账单（每页 ${session.limit} 条，${more}）`));
    } catch (cause) { setError(satErrorMessage(cause)); }
    finally { setBusy(false); }
  };

  /** 首页查询：创建新会话（固定 fromMs/toMs/limit），cursor="" 并重置翻页历史。 */
  const refreshBilling = async (supplierId: string, limitOverride?: number) => {
    const requested = limitOverride ?? getBillingLimit(supplierId);
    const safeLimit = Number.isSafeInteger(requested) && requested >= 1 && requested <= 100 ? requested : DEFAULT_BILLING_LIMIT;
    const session: BillingSession = { fromMs: 0n, toMs: BigInt(Date.now() + 1), limit: safeLimit };
    await queryBillingWithSession(supplierId, "", session, [""]);
  };

  /** 下一页：复用同一会话的时间范围与 limit，只换 cursor，历史追加。 */
  const nextBillingPage = async (supplierId: string) => {
    const page = billing[supplierId];
    const session = getBillingSession(supplierId);
    if (!page?.nextCursor || !session) return;
    const history = getBillingHistory(supplierId);
    await queryBillingWithSession(supplierId, page.nextCursor, session, [...history, page.nextCursor]);
  };

  /** 上一页：复用同一会话回到上一个游标并重新查询（不复用缓存，保证远端事实）。 */
  const prevBillingPage = async (supplierId: string) => {
    const session = getBillingSession(supplierId);
    const history = getBillingHistory(supplierId);
    if (!session || history.length <= 1) return;
    const prevHistory = history.slice(0, -1);
    const prevCursor = prevHistory[prevHistory.length - 1] ?? "";
    await queryBillingWithSession(supplierId, prevCursor, session, prevHistory);
  };

  const changeBillingLimit = async (supplierId: string, limit: number) => {
    await refreshBilling(supplierId, limit);
  };

  const refreshSpi = async (supplierId: string) => {
    setBusy(true);
    setError(null);
    try {
      const value = await spi.getInformation({ supplierId });
      setSpiInfo((current) => ({ ...current, [supplierId]: value }));
      setMessage(tr("sat.settings.spi.refreshed", `已刷新 SPI 余额（${value.currencies.length} 个账户）`));
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
    <section className="sat-subscription-settings">
      {message ? <p role="status">{message}</p> : null}
      {error && !supplierEditorOpen ? <p role="alert">{error}</p> : null}
      <div className="sat-subscription-settings__section-header">
        <h3 className="sat-subscription-settings__section-title">{tr("sat.settings.suppliers", "供应商")}</h3>
        <Button size="sm" onClick={openSupplierEditor} disabled={busy}>
          {tr("sat.settings.add", "新增供应商")}
        </Button>
      </div>
      {snapshot?.suppliers.length ? snapshot.suppliers.map((supplier) => {
        const builtIn = supplier.supplierId === SAT_DEFAULT_SUPPLIER_ID;
        const receiving = snapshot.ownerSettings?.receiveSupplierIds.includes(supplier.supplierId) ?? false;
        const view = snapshot.supplierViews.find((item) => item.supplierId === supplier.supplierId);
        const connectionState = view?.connectionState ?? "disconnected";
        const billingPage = billing[supplier.supplierId];
        const billingHistory = getBillingHistory(supplier.supplierId);
        const billingLimit = getBillingLimit(supplier.supplierId);
        const canPrevBilling = billingHistory.length > 1;
        const canNextBilling = Boolean(billingPage?.nextCursor);
        return (
          <div key={supplier.supplierId} className="sat-subscription-settings__supplier" data-supplier-id={supplier.supplierId}>
            <strong>{supplier.name}</strong> <code>{supplier.supplierId}</code>
            <div>{tr("sat.settings.identity", "认证公钥")}: <code>{supplier.supplierPublicKeyHex}</code></div>
            <div data-testid={`ss-connection-status-${supplier.supplierId}`} data-connection-status={connectionState}>
              <span
                data-testid={`ss-connection-light-${supplier.supplierId}`}
                data-connection-light={connectionState}
                data-state={connectionState}
                role="img"
                aria-label={`连接状态 Connection：${connectionState}（${connectionLightChinese(connectionState)}）`}
                title={`连接状态 Connection：${connectionState}（${connectionLightChinese(connectionState)}）`}
                className="sat-connection-light"
              />
              {" "}{tr("sat.settings.connection", "连接状态")}: {connectionState}（{connectionStateLabel(connectionState, tr)}）；{supplier.enabled ? tr("sat.settings.enabled", "已启用") : tr("sat.settings.disabled", "已停用")}
            </div>
            <div>{tr("sat.settings.desired", "期望订阅")}: {view?.desiredChannels.length ? view.desiredChannels.join(", ") : tr("sat.settings.none", "无")}；{tr("sat.settings.observed", "远端观察")}: {view?.observedChannels.length ? view.observedChannels.join(", ") : tr("sat.settings.none", "无")}</div>
            <div>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void refreshSpi(supplier.supplierId)}>{tr("sat.settings.spi.refresh", "刷新 SPI 余额")}</Button>
              <Button size="sm" variant="secondary" disabled={busy || !supplier.enabled} onClick={() => void refreshSubscriptions(supplier.supplierId)}>{tr("sat.settings.subscriptions.refresh", "刷新远端订阅")}</Button>
              <Button size="sm" variant="secondary" disabled={busy || !supplier.enabled} onClick={() => void refreshBilling(supplier.supplierId)}>{tr("sat.settings.billing.refresh", "查询服务器账单")}</Button>
              {spiInfo[supplier.supplierId]?.currencies.map((currency) => <span key={`${currency.currency}-${currency.network}`} className="sat-subscription-settings__spi-account" data-testid={`ss-spi-account-${supplier.supplierId}-${currency.currency}-${currency.network}`}> {currency.currency}/{currency.network}: <code>{currency.balance.toString(10)}</code>（充值地址 <code>{currency.paymentAddress}</code>）{currency.currency === "BSV" ? <> <Button size="sm" variant="secondary" disabled={busy} onClick={() => void prepareTopUp(supplier.supplierId, currency)}>{tr("sat.settings.spi.prepare", "生成充值预览")}</Button> <Button size="sm" variant="secondary" disabled={busy} onClick={() => void collect(supplier.supplierId, currency)}>{tr("sat.settings.spi.collect", "回收余额")}</Button></> : null}</span>)}
            </div>
            <div>
              <input aria-label={tr("sat.settings.spi.topupAmount", "充值金额（satoshis，正整数）")} value={topUpAmount} onChange={(event) => setTopUpAmount(event.target.value)} inputMode="numeric" />
              <input aria-label={tr("sat.settings.spi.collectAmount", "回收金额（satoshis，正整数）")} value={collectAmount} onChange={(event) => setCollectAmount(event.target.value)} inputMode="numeric" />
              <span>请先刷新 SPI 并在对应 BSV 账户行操作</span>
            </div>
            <div data-testid={`ss-billing-panel-${supplier.supplierId}`} data-billing-panel={supplier.supplierId}>
              <div>
                <span>{tr("sat.settings.billing.panel", "服务器账单（SS server 直查，不写入本地）")}</span>{" "}
                <label>
                  {tr("sat.settings.billing.pageSize", "每页条数（账单分页）")}:
                  {" "}
                  <select
                    aria-label={tr("sat.settings.billing.pageSize", "每页条数（账单分页）")}
                    data-testid={`ss-billing-limit-${supplier.supplierId}`}
                    value={String(billingLimit)}
                    disabled={busy}
                    onChange={(event) => void changeBillingLimit(supplier.supplierId, Number(event.target.value))}
                  >
                    {BILLING_PAGE_SIZE_OPTIONS.map((option) => <option key={option} value={String(option)}>{option}</option>)}
                  </select>
                </label>{" "}
                <span data-testid={`ss-billing-status-${supplier.supplierId}`}>
                  {billingPage
                    ? `第 ${billingHistory.length} 页 Page ${billingHistory.length}，本页 ${billingPage.records.length} 条（${billingPage.currency}/${billingPage.network}，${billingPage.nextCursor ? "还有下一页 Has next" : "已是最后一页 Last page"}）`
                    : `尚未查询服务器账单 Not queried`}
                </span>
              </div>
              {billingPage ? (
                <ul data-testid={`ss-billing-records-${supplier.supplierId}`}>
                  {billingPage.records.map((item) => (
                    <li key={item.chargeId} data-testid={`ss-billing-record-${supplier.supplierId}-${item.chargeId}`} data-billing-record={item.chargeId}>
                      供应商编号:{item.supplierId}｜动作:{item.action}｜频道:{item.channel}｜扣费金额:{item.chargedAmount} {billingPage.currency}｜账单编号:{item.chargeId}｜发生时间:{formatBillingTime(item.occurredAtMs)}
                    </li>
                  ))}
                </ul>
              ) : null}
              <div>
                <Button size="sm" variant="secondary" disabled={busy || !canPrevBilling} onClick={() => void prevBillingPage(supplier.supplierId)}>{tr("sat.settings.billing.prev", "上一页")}</Button>{" "}
                <Button size="sm" variant="secondary" disabled={busy || !canNextBilling} onClick={() => void nextBillingPage(supplier.supplierId)}>{tr("sat.settings.billing.next", "下一页")}</Button>
              </div>
            </div>
            <div>{tr("sat.settings.actions", "操作")}: {builtIn ? <span>内置默认 Supplier（不能编辑、停用或删除）</span> : <><Button size="sm" variant="secondary" disabled={busy} onClick={() => editSupplier(supplier)}>{tr("sat.settings.edit", "编辑")}</Button>{" "}<Button size="sm" variant="secondary" disabled={busy} onClick={() => void toggleEnabled(supplier)}>{supplier.enabled ? tr("sat.settings.disable", "停用") : tr("sat.settings.enable", "启用")}</Button>{" "}<Button size="sm" variant="secondary" disabled={busy || !supplier.enabled} onClick={() => void setDefault(supplier.supplierId)}>{tr("sat.settings.default", "设为默认发布")}</Button>{" "}<Button size="sm" variant="secondary" disabled={busy || !supplier.enabled} onClick={() => void toggleReceive(supplier.supplierId)}>{receiving ? tr("sat.settings.receive.off", "关闭接收") : tr("sat.settings.receive.on", "启用接收（可能收费）")}</Button>{" "}<Button size="sm" variant="danger" disabled={busy} onClick={() => void deleteSupplier(supplier)}>{tr("sat.settings.delete", "删除")}</Button></>}</div>
          </div>
        );
      }) : <p>{tr("sat.settings.empty", "尚未配置供应商。")}</p>}
      <Modal
        open={supplierEditorOpen}
        title={supplierEditorMode === "edit"
          ? tr("sat.settings.editing", "编辑供应商")
          : tr("sat.settings.add", "新增供应商")}
        onClose={closeSupplierEditor}
        data-testid="sat-supplier-editor"
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={closeSupplierEditor}>
              {tr("common.action.cancel", "取消")}
            </Button>
            <Button
              loading={busy}
              onClick={() => void saveSupplier()}
            >
              {supplierEditorMode === "edit"
                ? tr("sat.settings.saveEdit", "保存修改")
                : tr("sat.settings.save", "保存供应商")}
            </Button>
          </>
        }
      >
        <p className="sat-supplier-editor__description">
          {tr("sat.settings.supplierEditor.description", "填写供应商身份与连接地址；保存已有供应商时会更新原配置。")}
        </p>
        <div className="sat-supplier-editor__fields">
          <label className="sat-supplier-editor__field">
            <span>{tr("sat.settings.id", "供应商编号")}</span>
            <input
              aria-label={tr("sat.settings.id", "供应商编号")}
              placeholder={tr("sat.settings.id", "供应商编号")}
              value={draft.supplierId}
              disabled={busy || supplierEditorMode === "edit"}
              onChange={(event) => setDraft({ ...draft, supplierId: event.target.value })}
            />
          </label>
          <label className="sat-supplier-editor__field">
            <span>{tr("sat.settings.name", "名称")}</span>
            <input
              aria-label={tr("sat.settings.name", "名称")}
              placeholder={tr("sat.settings.name", "名称")}
              value={draft.name}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label className="sat-supplier-editor__field">
            <span>{tr("sat.settings.key", "供应商公钥")}</span>
            <input
              aria-label={tr("sat.settings.key", "供应商公钥")}
              placeholder={tr("sat.settings.key", "供应商公钥（66 位小写 hex）")}
              value={draft.supplierPublicKeyHex}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, supplierPublicKeyHex: event.target.value })}
            />
          </label>
          <label className="sat-supplier-editor__field">
            <span>{tr("sat.settings.addresses", "libp2p 地址")}</span>
            <textarea
              aria-label={tr("sat.settings.addresses", "libp2p 地址")}
              placeholder={tr("sat.settings.addresses", "libp2p 地址，每行一个")}
              value={draft.multiaddrs.join("\n")}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, multiaddrs: event.target.value.split("\n") })}
            />
          </label>
          <label className="sat-supplier-editor__checkbox">
            <input
              type="checkbox"
              checked={draft.enabled}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
            />
            {tr("sat.settings.enabledField", "启用供应商")}
          </label>
        </div>
        {error ? <p className="sat-supplier-editor__error" role="alert">{error}</p> : null}
      </Modal>
      {topUpPreview ? <div className="sat-subscription-settings__topup-dialog" role="dialog">
        <strong>{tr("sat.settings.spi.preview", "充值预览")}</strong>
        <div>网络: <strong>{bsvNetworkLabel(topUpPreview.network)}</strong>；Supplier: <code>{topUpPreview.supplierId}</code>；目标: <code>{topUpPreview.paymentAddress}</code>；金额: <code>{topUpPreview.amountSatoshis.toString(10)}</code> sats</div>
        <Button disabled={busy} onClick={() => void submitTopUp()}>{tr("sat.settings.spi.confirm", "确认并广播")}</Button>
        <Button disabled={busy} variant="secondary" onClick={() => setTopUpPreview(null)}>{tr("sat.settings.spi.cancel", "取消")}</Button>
      </div> : null}
      <h3 className="sat-subscription-settings__section-title">{tr("sat.settings.billing", "服务器账单")}</h3>
      <p>{tr("sat.settings.billing.description", "账单直接来自 SS server，不写入本地 setting.json。各供应商当前页见上方账单面板，这里是汇总（最新 20 条）。")}</p>
      <ul data-testid="ss-billing-summary">{Object.values(billing).flatMap((page) => page.records.map((item) => ({ item, currency: page.currency }))).slice(-20).reverse().map(({ item, currency }) => <li key={item.chargeId}>供应商编号:{item.supplierId}｜动作:{item.action}｜频道:{item.channel}｜扣费金额:{item.chargedAmount} {currency}｜账单编号:{item.chargeId}</li>)}</ul>
    </section>
  );
}
