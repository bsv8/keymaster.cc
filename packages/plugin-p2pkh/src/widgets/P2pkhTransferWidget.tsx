// packages/plugin-p2pkh/src/widgets/P2pkhTransferWidget.tsx
// P2PKH 完整转移 Widget（硬切换 007）。
// 设计缘由：
//   - 平台不再拥有地址/金额/矿工费/UTXO 控件；Widget 内部负责输入、校验、预览、签名、广播。
//   - 不再有"来源 key"选择：active key 由平台决定，签名通过 vault.withPrivateKey(activeKeyId)。
//   - all 模式下禁止 prepare / submit；Widget 顶部明确提示先选择 key。
//   - active key 切换时清空 preview（activeKey.changed 事件）。
//   - 成功后保留 widget 实例展示结果；用户关闭后才 onCompleted。
//
// 硬切换 003：所有展示文案走 i18n。

import { useEffect, useMemo, useState } from "react";
import { Button, PageHeader, Select, TextInput } from "@keymaster/ui";
import { useCapability, useI18n, usePluginHost } from "@keymaster/runtime";
import type { Contact, ContactsService, KeyIdentity, KeyspaceService, TransferCompletion, TransferOffer, TransferWidgetProps } from "@keymaster/contracts";
import type { P2pkhAssetId, P2pkhKeyResource, P2pkhService, P2pkhTransferPreview, P2pkhTransferResult } from "../p2pkhContracts.js";
import { assetIdToNetwork } from "../p2pkhContracts.js";

interface FormState {
  recipient: string;
  amount: string;
  feeRate: string;
  allowUnconfirmed: boolean;
}

const SETTINGS_KEY = "p2pkh.settings";

function loadAllowUnconfirmed(): boolean {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return false;
    const obj = JSON.parse(raw) as { allowUnconfirmed?: boolean };
    return obj.allowUnconfirmed === true;
  } catch {
    return false;
  }
}

export function P2pkhTransferWidget({ offer, onCompleted }: TransferWidgetProps) {
  const service = useCapability<P2pkhService>("p2pkh.service");
  const keyspace = useCapability<KeyspaceService>("keyspace.service");
  const host = usePluginHost();
  const { t } = useI18n();
  useI18n().language();
  const hasContacts = useCapability<ContactsService | undefined>(
    "contacts.service"
  );
  const contacts = hasContacts ?? undefined;

  const assetId: P2pkhAssetId = offer.assetId as P2pkhAssetId;
  const network = assetIdToNetwork(assetId);

  const [activeKey, setActiveKey] = useState(() => keyspace.active());
  const [resource, setResource] = useState<P2pkhKeyResource | undefined>(undefined);
  const [form, setForm] = useState<FormState>({
    recipient: "",
    amount: "0",
    feeRate: "1000",
    allowUnconfirmed: loadAllowUnconfirmed()
  });
  const [contactList, setContactList] = useState<Contact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<P2pkhTransferPreview | undefined>(undefined);
  const [previewKey, setPreviewKey] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<P2pkhTransferResult | undefined>(undefined);
  const [completion, setCompletion] = useState<TransferCompletion | undefined>(undefined);

  const isAllMode = activeKey.mode === "all";

  // 硬切换 008：通过 keyspace.getKey 拿当前 key 的展示信息（label + fingerprint），
  // 不再在 UI 里渲染完整 publicKeyHash。
  const [activeIdentity, setActiveIdentity] = useState<KeyIdentity | undefined>(undefined);

  useEffect(() => {
    return keyspace.onActiveChange((s) => {
      setActiveKey(s);
      // active key 切换时清空 preview/result：必须重新准备。
      setPreview(undefined);
      setPreviewKey(undefined);
      setResult(undefined);
      setCompletion(undefined);
      setError(null);
      // 重新拉 identity。
      if (s.mode === "single" && s.activePublicKeyHash) {
        keyspace
          .getKey(s.activePublicKeyHash)
          .then((id) => setActiveIdentity(id))
          .catch(() => setActiveIdentity(undefined));
      } else {
        setActiveIdentity(undefined);
      }
    });
  }, [keyspace]);

  // 初始化时拉一次当前 active identity。
  useEffect(() => {
    if (isAllMode || !activeKey.activePublicKeyHash) {
      setActiveIdentity(undefined);
      return;
    }
    let cancelled = false;
    keyspace
      .getKey(activeKey.activePublicKeyHash)
      .then((id) => {
        if (!cancelled) setActiveIdentity(id);
      })
      .catch(() => {
        if (!cancelled) setActiveIdentity(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [keyspace, activeKey.mode, activeKey.activePublicKeyHash, isAllMode]);

  useEffect(() => {
    if (isAllMode) {
      setResource(undefined);
      return;
    }
    let cancelled = false;
    service.listResources(assetId).then((list) => {
      if (cancelled) return;
      setResource(list[0]);
    });
    return () => {
      cancelled = true;
    };
  }, [service, assetId, isAllMode]);

  useEffect(() => {
    if (!contacts) return;
    contacts.listContacts().then(setContactList);
  }, [contacts]);

  const networkAddress = useMemo(() => resource?.address, [resource]);

  function update<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm((f) => ({ ...f, [k]: v }));
    setPreview(undefined);
    setPreviewKey(undefined);
    setError(null);
  }

  function fillFromContact(c: Contact) {
    update("recipient", c.address);
  }

  function buildInput() {
    if (!form.recipient) {
      setError(t("p2pkh.transfer.err.recipient", { defaultValue: "请输入接收方地址" }));
      return null;
    }
    const amount = Number(form.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError(t("p2pkh.transfer.err.amount", { defaultValue: "金额必须为正整数" }));
      return null;
    }
    const feeRate = Number(form.feeRate);
    if (!Number.isFinite(feeRate) || feeRate < 0) {
      setError(t("p2pkh.transfer.err.fee", { defaultValue: "矿工费无效" }));
      return null;
    }
    return {
      assetId,
      recipientAddress: form.recipient,
      amountSatoshis: Math.floor(amount),
      feeRateSatoshisPerKb: Math.floor(feeRate),
      allowUnconfirmed: form.allowUnconfirmed,
      keyId: ""
    };
  }

  async function doPrepare() {
    setError(null);
    setResult(undefined);
    const input = buildInput();
    if (!input) return;
    setBusy(true);
    try {
      const p = await service.prepareTransfer(input);
      setPreview(p);
      setPreviewKey(activeKey.mode === "single" ? activeKey.activePublicKeyHash ?? "" : "all");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("p2pkh.transfer.err.prepare", { defaultValue: "准备失败" }));
    } finally {
      setBusy(false);
    }
  }

  async function doSubmit() {
    if (!preview) return;
    const input = buildInput();
    if (!input) return;
    setError(null);
    setBusy(true);
    try {
      const r = await service.submitTransfer(preview, input);
      setResult(r);
      if (r.status === "broadcast" || r.status === "confirmed") {
        const c: TransferCompletion = {
          offerId: offer.id,
          providerId: offer.providerId,
          assetProviderId: offer.assetProviderId,
          assetId: offer.assetId,
          reference: r.txid,
          completedAt: new Date().toISOString(),
          details: { reservationIds: r.reservationIds, pendingTransferId: r.pendingTransferId }
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
  }

  useEffect(() => {
    if (!preview) return;
    const current = activeKey.mode === "single" ? activeKey.activePublicKeyHash ?? "" : "all";
    if (previewKey !== current) {
      setPreview(undefined);
      setPreviewKey(undefined);
      setError(t("p2pkh.transfer.err.keyChanged", { defaultValue: "当前 key 已切换，请重新准备预览" }));
    }
  }, [activeKey, preview, previewKey, t]);

  const unnamed = t("p2pkh.transfer.unnamed", { defaultValue: "未命名" });

  return (
    <div className="p2pkh-transfer-widget">
      <PageHeader
        title={`${host.i18n.text(offer.label)}${t("p2pkh.transfer.titleSuffix", { defaultValue: " 转账" })}`}
        description={t("p2pkh.transfer.networkDesc", { defaultValue: "网络：{{network}}（{{assetId}}）", network, assetId })}
      />
      <section className="p2pkh-transfer-widget__key-context">
        <p>
          {t("p2pkh.transfer.currentKey", { defaultValue: "当前 key：" })}
          {isAllMode ? (
            <strong>{t("p2pkh.transfer.allKey", { defaultValue: " 全部 key（只读总览，无法签名）" })}</strong>
          ) : activeIdentity ? (
            <>
              <strong>{activeIdentity.label || unnamed}</strong>
              <code className="p2pkh-transfer-widget__fingerprint">
                {activeIdentity.fingerprint}
              </code>
            </>
          ) : activeKey.activePublicKeyHash ? (
            <code>{t("p2pkh.transfer.loading", { defaultValue: "加载中…" })}</code>
          ) : (
            <strong>{t("p2pkh.transfer.unselected", { defaultValue: "未选择" })}</strong>
          )}
        </p>
        {networkAddress ? (
          <p>
            {t("p2pkh.transfer.changeAddress", { defaultValue: "当前找零地址：" })}
            <code>{networkAddress}</code>
          </p>
        ) : null}
      </section>
      {result ? (
        <section className="p2pkh-transfer-widget__result">
          <h4>{t("p2pkh.transfer.result.title", { defaultValue: "提交结果" })}</h4>
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
          {result.status === "rejected" ? (
            <p>{t("p2pkh.transfer.result.rejected", { defaultValue: "交易被网络拒绝。已释放本次 UTXO 占用。" })}</p>
          ) : null}
          {result.status === "unknown" ? (
            <p>{t("p2pkh.transfer.result.unknown", { defaultValue: "广播结果未知，UTXO 已保留为 reservation 状态以防重复花费。" })}</p>
          ) : null}
          {result.status === "broadcast" || result.status === "confirmed" ? (
            <p>{t("p2pkh.transfer.result.broadcast", { defaultValue: "已为本次输入创建 reservation。后续 recent-sync 会观察是否上链。" })}</p>
          ) : null}
          <div className="p2pkh-transfer-widget__actions">
            <Button onClick={dismissResult} variant="primary">
              {t("p2pkh.transfer.result.confirmClose", { defaultValue: "确认并关闭" })}
            </Button>
            <Button variant="ghost" onClick={resetForNew}>
              {t("p2pkh.transfer.result.again", { defaultValue: "再来一次" })}
            </Button>
          </div>
        </section>
      ) : isAllMode ? (
        <section className="p2pkh-transfer-widget__guard">
          <p>{t("p2pkh.transfer.allModeWarning", { defaultValue: "当前是\"全部 key\"只读模式。请到顶栏选择一个具体的 key 后再转账。" })}</p>
        </section>
      ) : (
        <>
          <TextInput
            label={t("p2pkh.transfer.form.recipient", { defaultValue: "接收方地址" })}
            value={form.recipient}
            onChange={(e) => update("recipient", e.currentTarget.value)}
          />
          {contacts && contactList.length > 0 ? (
            <Select
              label={t("p2pkh.transfer.form.contactSelect", { defaultValue: "从联系人选择" })}
              value=""
              onChange={(e) => {
                const c = contactList.find((x) => x.id === e.currentTarget.value);
                if (c) fillFromContact(c);
              }}
              options={[
                { label: t("p2pkh.transfer.form.contactPlaceholder", { defaultValue: "未选择" }), value: "" },
                ...contactList.map((c) => ({ label: c.name, value: c.id }))
              ]}
            />
          ) : null}
          <TextInput
            label={t("p2pkh.transfer.form.amount", { defaultValue: "金额 (sats)" })}
            type="number"
            value={form.amount}
            onChange={(e) => update("amount", e.currentTarget.value)}
          />
          <TextInput
            label={t("p2pkh.transfer.form.feeRate", { defaultValue: "矿工费 (sats/kB)" })}
            type="number"
            value={form.feeRate}
            onChange={(e) => update("feeRate", e.currentTarget.value)}
          />
          <Select
            label={t("p2pkh.transfer.form.allowUnconfirmed", { defaultValue: "允许未确认 UTXO" })}
            value={form.allowUnconfirmed ? "yes" : "no"}
            onChange={(e) => update("allowUnconfirmed", e.currentTarget.value === "yes")}
            options={[
              { label: t("p2pkh.transfer.form.allowUnconfirmed.no", { defaultValue: "否（推荐）" }), value: "no" },
              { label: t("p2pkh.transfer.form.allowUnconfirmed.yes", { defaultValue: "是" }), value: "yes" }
            ]}
          />
          {error ? <p className="p2pkh-transfer-widget__error">{error}</p> : null}
          <div className="p2pkh-transfer-widget__actions">
            <Button
              onClick={doPrepare}
              loading={busy}
              disabled={!form.recipient || !form.amount}
            >
              {t("p2pkh.transfer.form.prepare", { defaultValue: "准备预览" })}
            </Button>
            {preview ? (
              <Button onClick={doSubmit} loading={busy} variant="primary" disabled={!preview}>
                {t("p2pkh.transfer.form.sign", { defaultValue: "签名并广播" })}
              </Button>
            ) : null}
          </div>
          {preview ? (
            <section className="p2pkh-transfer-widget__preview">
              <h4>{t("p2pkh.transfer.preview.title", { defaultValue: "预览" })}</h4>
              <p>
                {t("p2pkh.transfer.preview.utxosCount", { defaultValue: "选定 UTXO：{{count}} 个", count: preview.allocation.selected.length })}
                {t("p2pkh.transfer.preview.totalSats", { defaultValue: "，合计 " })}{preview.allocation.totalInputSatoshis} sats
              </p>
              <p>{t("p2pkh.transfer.preview.change", { defaultValue: "找零：" })}{preview.allocation.changeSatoshis} sats</p>
              <p>{t("p2pkh.transfer.preview.fee", { defaultValue: "估算矿工费：" })}{preview.estimatedFeeSatoshis} sats</p>
              <ul>
                {preview.outputs.map((o, i) => (
                  <li key={i}>
                    <code>{o.address}</code> : {o.value} sats
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
