// packages/plugin-p2pkh/src/widgets/P2pkhTransferWidget.tsx
// P2PKH 完整转移 Widget（硬切换 007）。
// 设计缘由：
//   - 平台不再拥有地址/金额/矿工费/UTXO 控件；Widget 内部负责输入、校验、预览、签名、广播。
//   - 不再有"来源 key"选择：active key 由平台决定，
//     签名由 transfer service 按 owner publicKeyHex 借私钥完成；Widget 不直接持有 key 身份。
//   - 不再有来源 key 选择；缺 activePublicKeyHex 时只保留 guard。
//   - active key 切换时清空 preview（activeKey.changed 事件）。
//   - 成功后保留 widget 实例展示结果；用户关闭后才 onCompleted。
//
// 硬切换 003：所有展示文案走 i18n。
//
import { useEffect, useState } from "react";
import { Button, TextInput } from "@keymaster/ui";
import { useOptionalCapability } from "webloom-framework/react";
import { useI18n, useLocale, useOptionalResourceSelector, usePluginHost } from "@keymaster/runtime";
import { BALANCE_NETWORK_KEYS, emptyGlobalBalanceSnapshot, type GlobalBalanceSnapshot, type KeyIdentity, type TransferCompletion, type TransferOffer, type TransferWidgetProps } from "@keymaster/contracts";
import type { P2pkhAssetId, P2pkhFeeRateTier, P2pkhGlobalSettings, P2pkhKeyResource, P2pkhService, P2pkhTransferPreview, P2pkhTransferResult } from "../p2pkhContracts.js";
import { P2PKH_CAPABILITY, assetIdToNetwork, resolveP2pkhFeeRateSatoshisPerKb } from "../p2pkhContracts.js";

interface FormState {
  recipient: string;
  amount: string;
  feeTier: P2pkhFeeRateTier;
}

export function P2pkhTransferWidget(props: TransferWidgetProps) {
  const { t } = useI18n();
  // owner 作用域 capability 会在锁定时撤销；路由/首页组件在锁定瞬间仍可能
  // 完成一次渲染，必须按"暂不可用"降级而不是抛错。
  const service = useOptionalCapability(P2PKH_CAPABILITY);
  if (!service) {
    return (
      <p className="p2pkh-transfer-widget__unavailable">
        {t("p2pkh.transfer.locked", { defaultValue: "钱包已锁定；解锁后可继续转账。" })}
      </p>
    );
  }
  return <P2pkhTransferWidgetInner {...props} service={service} />;
}

function P2pkhTransferWidgetInner({
  offer,
  onCompleted,
  recipientAddress,
  recipientPublicKeyHex,
  service
}: TransferWidgetProps & { service: P2pkhService }) {
  const host = usePluginHost();
  const { t } = useI18n();
  const locale = useLocale();
  const formatNumber = (value: number) => new Intl.NumberFormat(locale).format(value);

  const assetId: P2pkhAssetId = offer.assetId as P2pkhAssetId;
  const network = assetIdToNetwork(assetId);

  const context = useOptionalResourceSelector<{ activePublicKeyHex?: string; identity?: KeyIdentity; resource?: P2pkhKeyResource }, { activePublicKeyHex?: string; identity?: KeyIdentity; resource?: P2pkhKeyResource }>(
    host.resourceStore,
    "p2pkh.transfer-context",
    [assetId],
    (s) => s.data ?? {},
    {}
  );
  const activeKey = { activePublicKeyHex: context.activePublicKeyHex };
  const activeIdentity = context.identity;
  const resource = context.resource;
  const globalSettings = useOptionalResourceSelector<P2pkhGlobalSettings, P2pkhGlobalSettings>(
    host.resourceStore,
    "p2pkh.settings",
    [],
    (snapshot) => snapshot.data ?? { includeTestnet: false },
    { includeTestnet: false }
  );
  const balanceSnapshot = useOptionalResourceSelector<GlobalBalanceSnapshot, GlobalBalanceSnapshot>(
    host.resourceStore,
    "p2pkh.balance",
    [],
    (snapshot) => snapshot.data ?? emptyGlobalBalanceSnapshot(),
    emptyGlobalBalanceSnapshot()
  );
  const networkBalance = balanceSnapshot.balances[BALANCE_NETWORK_KEYS[network]];
  const networkLabel = t(network === "main" ? "p2pkh.network.main" : "p2pkh.network.test", {
    defaultValue: network === "main" ? "主网" : "测试网"
  });
  const feeRates = resolveP2pkhFeeRateSatoshisPerKb(globalSettings);
  const feeRateKey = `${feeRates.low}:${feeRates.medium}:${feeRates.high}`;
  const [form, setForm] = useState<FormState>({
    recipient: recipientAddress ?? "",
    amount: "0",
    feeTier: "medium"
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hexCopied, setHexCopied] = useState(false);
  const [preview, setPreview] = useState<P2pkhTransferPreview | undefined>(undefined);
  const [previewKey, setPreviewKey] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<P2pkhTransferResult | undefined>(undefined);
  const [completion, setCompletion] = useState<TransferCompletion | undefined>(undefined);
  useEffect(() => {
    // 收款地址由平台完成解析、网络锁定和联系人反查；Widget 只读取这一真值，
    // 不再根据公钥静默派生或允许用户编辑地址。
    setForm((current) => ({ ...current, recipient: recipientAddress ?? "" }));
    setPreview(undefined);
    setPreviewKey(undefined);
    setResult(undefined);
    setCompletion(undefined);
    setError(null);
  }, [feeRateKey, network, offer.id, recipientAddress, recipientPublicKeyHex]);

  // 硬切换 005 收尾：active key 不再有 `mode` 字段。"all 模式"被壳层守卫
  // 拦截，本 widget 顶多在 active 缺失的瞬时态出现，作为 fail-closed 防御
  // ——但正常业务流下不会进入 hasNoActiveKey 分支。
  const hasNoActiveKey = !activeKey.activePublicKeyHex;

  const networkAddress = resource?.address;

  function update<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm((f) => ({ ...f, [k]: v }));
    setPreview(undefined);
    setPreviewKey(undefined);
    setResult(undefined);
    setCompletion(undefined);
    setError(null);
    setHexCopied(false);
  }

  function buildInput() {
    if (!form.recipient) {
      setError(t("p2pkh.transfer.err.recipient", { defaultValue: "收款地址尚未通过平台核对" }));
      return null;
    }
    const sendAll = /^(all|全部)$/i.test(form.amount.trim());
    const amount = Number(form.amount);
    if (!sendAll && (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0)) {
      setError(t("p2pkh.transfer.err.amount", { defaultValue: "金额必须为正整数" }));
      return null;
    }
    return {
      assetId,
      recipientAddress: form.recipient,
      amountSatoshis: sendAll ? 0 : amount,
      sendAll,
      feeRateSatoshisPerKb: feeRates[form.feeTier],
      ownerPublicKeyHex: activeIdentity?.publicKeyHex ?? ""
    };
  }

  async function doPrepare() {
    setError(null);
    setResult(undefined);
    setHexCopied(false);
    const input = buildInput();
    if (!input) return;
    setBusy(true);
    try {
      const p = await service.prepareTransfer(input);
      setPreview(p);
      setPreviewKey(activeKey.activePublicKeyHex ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("p2pkh.transfer.err.prepare", { defaultValue: "准备失败" }));
    } finally {
      setBusy(false);
    }
  }

  async function doSubmit() {
    if (!preview) return;
    setError(null);
    setBusy(true);
    try {
      const r = await service.submitTransfer(preview);
      setResult(r);
      if (r.status === "local-confirmed") {
        const c: TransferCompletion = {
          offerId: offer.id,
          providerId: offer.providerId,
          assetProviderId: offer.assetProviderId,
          assetId: offer.assetId,
          reference: r.txid,
          completedAt: new Date().toISOString(),
          details: { localInputClaimIds: r.localInputClaimIds, submissionId: r.submissionId }
        };
        setCompletion(c);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("p2pkh.transfer.err.submit", { defaultValue: "提交失败" }));
    } finally {
      setBusy(false);
    }
  }

  function dismissResult() {
    if (completion) onCompleted(completion);
  }

  function resetForNew() {
    setPreview(undefined);
    setPreviewKey(undefined);
    setResult(undefined);
    setCompletion(undefined);
    setError(null);
    setHexCopied(false);
  }

  useEffect(() => {
    if (!preview) return;
    const current = activeKey.activePublicKeyHex ?? "";
    if (previewKey !== current) {
      setPreview(undefined);
      setPreviewKey(undefined);
      setError(t("p2pkh.transfer.err.keyChanged", { defaultValue: "当前 key 已切换，请重新准备预览" }));
    }
  }, [activeKey, preview, previewKey, t]);

  async function copyRawTxHex() {
    if (!preview) return;
    try {
      await navigator.clipboard.writeText(preview.rawTxHex);
      setHexCopied(true);
    } catch {
      setError(t("p2pkh.transfer.err.copyHex", { defaultValue: "复制 rawTxHex 失败" }));
    }
  }

  return (
    <div className="p2pkh-transfer-widget">
      {result ? (
        <section className="p2pkh-transfer-widget__step-card p2pkh-transfer-widget__result">
          <div className="p2pkh-transfer-widget__step-heading"><span>4</span><div><h4>{t("p2pkh.transfer.result.title", { defaultValue: "本地确认结果" })}</h4><p>{t("p2pkh.transfer.result.stepHint", { defaultValue: "广播供应商已返回结果，本地状态已安全落库。" })}</p></div></div>
          <p>
            {t("p2pkh.transfer.result.status", { defaultValue: "状态：" })}
            {result.status}
          </p>
          {result.txid ? (
            <p>
              {t("p2pkh.transfer.result.txid", { defaultValue: "txid：" })}
              <code>{result.txid}</code>
            </p>
          ) : null}
          {result.error ? <p className="p2pkh-transfer-widget__error">{result.error}</p> : null}
          {result.status === "local-confirmed" ? <p>{t("p2pkh.transfer.result.localConfirmed", { defaultValue: "广播供应商明确接受；找零要等 WoC 返回该输出后才会进入可花费余额。" })}</p> : null}
          {result.status === "isolated" ? <p>{t("p2pkh.transfer.result.isolated", { defaultValue: "交易已隔离，输入占用不会自动释放；可在交易详情查看本地记录与广播尝试。" })}</p> : null}
          {result.status === "not-dispatched" ? <p>{t("p2pkh.transfer.result.notDispatched", { defaultValue: "交易未离开客户端，提交与输入占用已安全撤销。" })}</p> : null}
          <div className="p2pkh-transfer-widget__actions">
            <Button onClick={dismissResult} variant="primary">
              {t("p2pkh.transfer.result.confirmClose", { defaultValue: "确认并关闭" })}
            </Button>
            <Button variant="ghost" onClick={resetForNew}>
              {t("p2pkh.transfer.result.again", { defaultValue: "再来一次" })}
            </Button>
          </div>
        </section>
      ) : hasNoActiveKey ? (
        <section className="p2pkh-transfer-widget__guard">
          <p>{t("p2pkh.transfer.noActiveKeyWarning", { defaultValue: "当前没有可用的 active key。请到 Key 管理处理失败 / 未初始化的 key 后再转账。" })}</p>
        </section>
      ) : (
        <>
          <section className="p2pkh-transfer-widget__step-card" aria-labelledby="p2pkh-transfer-step-2">
            <div className="p2pkh-transfer-widget__step-heading"><span>2</span><div><h4 id="p2pkh-transfer-step-2">{t("p2pkh.transfer.step.addressAmount", { defaultValue: "金额与矿工费率" })}</h4><p>{t("p2pkh.transfer.step.addressAmountHint", { defaultValue: "收款地址已由平台核对并锁定；这里只输入金额和矿工费率。" })}</p></div></div>
            <div className="p2pkh-transfer-widget__readonly-address" data-testid="p2pkh-recipient-address">
              <span>{t("p2pkh.transfer.form.recipient", { defaultValue: "收款地址（只读）" })}</span>
              <code>{form.recipient || t("p2pkh.transfer.loading", { defaultValue: "加载中…" })}</code>
            </div>
            {recipientPublicKeyHex ? <p className="p2pkh-transfer-widget__recipient-proof">{t("p2pkh.transfer.form.recipientTarget", { defaultValue: "此地址由收款人身份派生并已锁定；如需更换，请返回第 1 步。" })}</p> : null}
            <div className="p2pkh-transfer-widget__readonly-address">
              <span>{t("p2pkh.transfer.changeAddress", { defaultValue: "找零地址（不可修改）" })}</span>
              <code>{networkAddress ?? t("p2pkh.transfer.loading", { defaultValue: "加载中…" })}</code>
            </div>
            <div className="p2pkh-transfer-widget__amount-row">
              <TextInput
                className="p2pkh-transfer-widget__amount-input"
                label={t("p2pkh.transfer.form.amount", { defaultValue: "金额 (sats)" })}
                inputMode="numeric"
                placeholder={t("p2pkh.transfer.form.amountPlaceholder", { defaultValue: "输入 sats，或选择全部" })}
                value={form.amount}
                onChange={(e) => update("amount", e.currentTarget.value)}
              />
              <Button className="p2pkh-transfer-widget__send-all" size="sm" variant={/^(all|全部)$/i.test(form.amount.trim()) ? "primary" : "secondary"} onClick={() => update("amount", "全部")}>
                {t("p2pkh.transfer.form.sendAll", { defaultValue: "全部" })}
              </Button>
            </div>
            <p className="p2pkh-transfer-widget__balance-reference" aria-live="polite">
              {networkBalance && networkBalance.available !== false
                ? t("p2pkh.transfer.form.availableBalance", { defaultValue: "可用余额：{{balance}} sats（{{network}}）", balance: formatNumber(networkBalance.total), network: networkLabel })
                : t("p2pkh.transfer.form.availableBalanceUnknown", { defaultValue: "可用余额未知（{{network}}）", network: networkLabel })}
            </p>
            {/^(all|全部)$/i.test(form.amount.trim()) ? <p className="p2pkh-transfer-widget__amount-hint">{t("p2pkh.transfer.form.sendAllHint", { defaultValue: "最终到账额会自动扣除实际矿工费。" })}</p> : null}
            <div className="p2pkh-transfer-widget__fee-tier" role="group" aria-label={t("p2pkh.transfer.form.feeRate", { defaultValue: "矿工费率" })}>
              <span>{t("p2pkh.transfer.form.feeRate", { defaultValue: "矿工费率" })}</span>
              {(["low", "medium", "high"] as const).map((tier) => <Button key={tier} size="sm" variant={form.feeTier === tier ? "primary" : "secondary"} onClick={() => update("feeTier", tier)}>{t(`p2pkh.transfer.form.feeTier.${tier}`, { defaultValue: tier === "low" ? "低" : tier === "medium" ? "中" : "高" })} · {feeRates[tier]} sats/kB</Button>)}
            </div>
            {error ? <p className="p2pkh-transfer-widget__error">{error}</p> : null}
            <div className="p2pkh-transfer-widget__actions">
              <Button onClick={doPrepare} loading={busy} disabled={!form.recipient || !form.amount}>
                {t("p2pkh.transfer.form.prepare", { defaultValue: "生成最终交易" })}
              </Button>
            </div>
          </section>
          {preview ? (
            <section className="p2pkh-transfer-widget__step-card p2pkh-transfer-widget__preview">
              <div className="p2pkh-transfer-widget__step-heading"><span>3</span><div><h4>{t("p2pkh.transfer.preview.title", { defaultValue: "只读核对" })}</h4><p>{t("p2pkh.transfer.preview.stepHint", { defaultValue: "请核对收款地址、到账金额、找零与矿工费，再广播。" })}</p></div></div>
              <div className="p2pkh-transfer-widget__recipient-output">
                <span>{t("p2pkh.transfer.preview.recipientVerify", { defaultValue: "收款输出（请重点核对）" })}</span>
                <code>{preview.recipientAddress}</code>
                <strong>{formatNumber(preview.amountSatoshis)} sats</strong>
              </div>
              <p className="p2pkh-transfer-widget__input-summary">
                {t("p2pkh.transfer.preview.inputs", { defaultValue: "输入数量：{{count}} 个", count: formatNumber(preview.allocation.selected.length) })}
                {t("p2pkh.transfer.preview.totalSats", { defaultValue: "，输入总额 " })}{formatNumber(preview.allocation.totalInputSatoshis)} sats
              </p>
              <p>
                {t("p2pkh.transfer.preview.change", { defaultValue: "找零输出：" })}
                {preview.allocation.changeSatoshis > 0 ? (
                  <>
                    <code>{preview.changeAddress}</code> {formatNumber(preview.allocation.changeSatoshis)} sats
                  </>
                ) : (
                  <span>{t("p2pkh.transfer.preview.noChange", { defaultValue: "无" })}</span>
                )}
              </p>
              <p>
                {t("p2pkh.transfer.preview.fee", { defaultValue: "最终矿工费：" })}
                {formatNumber(preview.estimatedFeeSatoshis)} sats
              </p>
              <p>
                {t("p2pkh.transfer.preview.size", { defaultValue: "序列化大小：" })}
                {formatNumber(preview.serializedSizeBytes)} bytes
              </p>
              <p>
                {t("p2pkh.transfer.preview.txid", { defaultValue: "最终 txid：" })}
                <code>{preview.txid}</code>
              </p>
              <div className="p2pkh-transfer-widget__actions">
                <Button onClick={doSubmit} loading={busy} variant="primary" disabled={!preview}>
                  {t("p2pkh.transfer.form.sign", { defaultValue: "确认并广播交易" })}
                </Button>
                <Button variant="ghost" onClick={copyRawTxHex}>
                  {t("p2pkh.transfer.preview.copyHex", { defaultValue: "复制 rawTxHex" })}
                </Button>
                {hexCopied ? <span>{t("p2pkh.transfer.preview.copied", { defaultValue: "已复制" })}</span> : null}
              </div>
              <label className="p2pkh-transfer-widget__hex-label">
                {t("p2pkh.transfer.preview.rawTxHex", { defaultValue: "最终 rawTxHex：" })}
              </label>
              <pre className="p2pkh-transfer-widget__hex">
                <code>{preview.rawTxHex}</code>
              </pre>
              <ul>
                {preview.outputs.map((o) => (
                  <li key={`${o.address}:${o.value}`}>
                    <code>{o.address}</code> : {formatNumber(o.value)} sats
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
