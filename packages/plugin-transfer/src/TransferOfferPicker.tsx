// packages/plugin-transfer/src/TransferOfferPicker.tsx
// 通用 Transfer Offer 选择器。
// 设计缘由：Transfer 平台只列 provider 暴露的动态 Offer，不解释资产业务。
// picker 只负责选择与展示。
//
// 硬切换 003：empty 文本与 offer.label 走 i18n。

import { useI18n, usePluginHost } from "@keymaster/runtime";
import type { TransferOffer } from "@keymaster/contracts";

export interface TransferOfferPickerProps {
  offers: TransferOffer[];
  value?: string;
  onChange: (offer: TransferOffer) => void;
}

export function TransferOfferPicker({ offers, value, onChange }: TransferOfferPickerProps) {
  const { t } = useI18n();
  useI18n().language();
  const host = usePluginHost();
  if (offers.length === 0) {
    return <p className="transfer-picker__empty">{t("transfer.page.empty.picker", { defaultValue: "当前没有可用的转账资产。" })}</p>;
  }

  return (
    <div className="transfer-picker">
      {offers.map((o) => (
        <button
          key={o.id}
          type="button"
          className={`transfer-picker__item ${value === o.id ? "is-selected" : ""} is-${o.status}`}
          onClick={() => onChange(o)}
        >
          <span className="transfer-picker__name">{host.i18n.text(o.label)}</span>
          {o.description ? <span className="transfer-picker__desc">{host.i18n.text(o.description)}</span> : null}
          {o.balance ? (
            <span className="transfer-picker__balance">
              {o.balance.display ?? `${o.balance.amount} ${o.balance.unit}`}
            </span>
          ) : null}
          <span className={`transfer-picker__status is-${o.status}`}>{o.status}</span>
        </button>
      ))}
    </div>
  );
}
