import { useP2pkhResources } from "../P2pkhResourceContext.js";
import { useEffect, useRef, useState } from "react";
import { Button, TextInput } from "@keymaster/ui";
import { useOptionalPluginCapability } from "webloom-framework/react";
import { usePluginI18n, usePluginLocale, useOptionalResourceSelector } from "@keymaster/runtime";
import { emptyGlobalBalanceSnapshot, type GlobalBalanceSnapshot, type KeyIdentity, type P2pkhDirectTransferResult } from "@keymaster/contracts";
import { P2PKH_CAPABILITY, type P2pkhService } from "../p2pkhContracts.js";

export interface P2pkhTransferWidgetProps {
  recipientAddress?: string;
  recipientPublicKeyHex?: string;
  initialAmountSatoshis?: string;
  onCompleted(result: P2pkhDirectTransferResult): void;
}

export function P2pkhTransferWidget(props: P2pkhTransferWidgetProps) {
  const { t } = usePluginI18n();
  const service = useOptionalPluginCapability(P2PKH_CAPABILITY);
  if (!service) return <p>{t("p2pkh.transfer.locked", {defaultValue: "钱包已锁定；解锁后可继续转账。"})}</p>;
  return <Transfer {...props} service={service} />;
}

/** User confirmation precedes allocation. No transaction material leaves the Worker. */
function Transfer({service, recipientAddress, recipientPublicKeyHex, initialAmountSatoshis, onCompleted}: P2pkhTransferWidgetProps & {service: P2pkhService}) {
  const reader = useP2pkhResources();
  const {t} = usePluginI18n();
  const locale = usePluginLocale();
  const context = useOptionalResourceSelector<{identity?: KeyIdentity; address?: string}, {identity?: KeyIdentity; address?: string}>(reader, "p2pkh.wallet-context", [], s => s.data ?? {}, {});
  const balance = useOptionalResourceSelector<GlobalBalanceSnapshot, GlobalBalanceSnapshot>(reader, "p2pkh.balance", [], s => s.data ?? emptyGlobalBalanceSnapshot(), emptyGlobalBalanceSnapshot());
  const [amount, setAmount] = useState(initialAmountSatoshis ?? "0");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const generation = useRef(0);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<P2pkhDirectTransferResult>();
  useEffect(() => {
    generation.current++;
    setResult(undefined); setError(undefined);
    return () => { generation.current++; };
  }, [context.identity?.publicKeyHex, context.identity?.bsvNetwork, recipientAddress, recipientPublicKeyHex]);
  async function submit() {
    if (running.current || !context.identity || !recipientAddress) return;
    const sendAll = /^(all|全部)$/i.test(amount.trim());
    const value = Number(amount);
    if (!sendAll && (!Number.isSafeInteger(value) || value <= 0)) {
      setError(t("p2pkh.transfer.err.amount", {defaultValue: "金额必须为正整数"})); return;
    }
    running.current = true; setBusy(true); setError(undefined);
    const own = generation.current;
    try {
      const value = await service.transfer({recipientAddress, amountSatoshis: sendAll ? 0 : Number(amount), sendAll});
      if (own === generation.current) setResult(value);
    } catch (cause) {
      if (own === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { running.current = false; setBusy(false); }
  }
  const known = balance.publicKeyHex === context.identity?.publicKeyHex.toLowerCase() && balance.bsvNetwork === context.identity?.bsvNetwork && balance.balance.available === true;
  return <div className="p2pkh-transfer-widget">
    {result ? <section className="p2pkh-transfer-widget__result">
      <h4>{t("p2pkh.transfer.result.title", {defaultValue: "提交结果"})}</h4>
      <p>{result.status}</p>
      <p data-testid="transfer-result-amount">{t("p2pkh.transfer.result.amount", {defaultValue: "收款金额"})}：{result.amountSatoshis} sats</p>
      <p data-testid="transfer-result-fee">{t("p2pkh.transfer.result.fee", {defaultValue: "矿工费"})}：{result.feeSatoshis} sats</p>
      <p data-testid="transfer-result-change">{t("p2pkh.transfer.result.change", {defaultValue: "找零"})}：{result.changeSatoshis} sats</p>
      <p data-testid="transfer-result-size">{t("p2pkh.transfer.result.size", {defaultValue: "交易大小"})}：{result.serializedSizeBytes} bytes</p>
      {result.txid ? <p><code>{result.txid}</code></p> : null}
      {result.error ? <p role="alert">{result.error}</p> : null}
      <Button onClick={() => onCompleted(result)}>{t("p2pkh.transfer.result.confirmClose", {defaultValue: "确认并关闭"})}</Button>
    </section> : <section className="p2pkh-transfer-widget__step-card">
      <h4>{t("p2pkh.transfer.step.addressAmount", {defaultValue: "金额"})}</h4>
      <div data-testid="p2pkh-recipient-address"><span>{t("p2pkh.transfer.form.recipient", {defaultValue: "收款地址（只读）"})}</span><code>{recipientAddress}</code></div>
      <TextInput label={t("p2pkh.transfer.form.amount", {defaultValue: "金额 (sats)"})} value={amount} disabled={busy} onChange={e => setAmount(e.currentTarget.value)} />
      <Button disabled={busy} onClick={() => setAmount("全部")}>{t("p2pkh.transfer.form.sendAll", {defaultValue: "全部"})}</Button>
      <p className="p2pkh-transfer-widget__balance-reference">{known
        ? t("p2pkh.transfer.form.availableBalance", {defaultValue: "可用余额：{{balance}} sats（{{network}}）", balance: new Intl.NumberFormat(locale).format(balance.balance.total), network: context.identity?.bsvNetwork === "test" ? "测试网 / testnet" : "主网 / mainnet"})
        : t("p2pkh.transfer.form.availableBalanceUnknown", {defaultValue: "可用余额未知（{{network}}）", network: context.identity?.bsvNetwork === "test" ? "测试网 / testnet" : "主网 / mainnet"})}</p>
      <p>{t("p2pkh.transfer.directHint", {defaultValue: "请核对收款地址和金额。确认后按当前钱包费率直接签名并提交，全部发送会扣除矿工费。"})}</p>
      {error ? <p className="p2pkh-transfer-widget__error" role="alert">{error}</p> : null}
      <Button loading={busy} disabled={busy || !context.identity || !recipientAddress} onClick={() => void submit()}>{t("p2pkh.transfer.confirmSubmit", {defaultValue: "确认并提交交易"})}</Button>
    </section>}
  </div>;
}
