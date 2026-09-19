// packages/plugin-bsv-price/src/BsvPricePage.tsx
// BSV 价格业务页。
//
// 设计缘由：
//   - 展示订阅的全部信息：发布服务器、频道、连接/订阅状态、激活选项、
//     当前展示价、快照时间、收到的全部行情、解析/订阅错误；
//   - 展示价格是「金额 + 单位」，只作显示参考；
//   - 页面不接触 Channel 传输细节；服务走 `bsv-price.service` capability；
//   - **不**展示历史 / 图表 / 告警。

import React from "react";
import { useOptionalCapability, useResource } from "webloom-framework/react";
import { useI18n, useLocale, usePluginHost } from "@keymaster/runtime";
import type {
  BsvPriceService,
  BsvPriceServiceSnapshot
} from "./bsvPriceService.js";

import { BSV_PRICE_SERVICE_CAPABILITY } from "./manifest.js";

export function BsvPricePage(): React.ReactElement {
  const i18n = useI18n();
  const service = useBsvPriceServiceOrNull();

  if (!service) {
    return (
      <section
        className="km-bsv-price-page km-bsv-price-page--missing"
        data-bsv-price-page="missing-service"
      >
        <h1 className="km-bsv-price-page__title">{i18n.t("bsv-price.page.title")}</h1>
        <p className="km-bsv-price-page__empty">
          bsv-price.service is not available.
        </p>
      </section>
    );
  }
  return <BsvPricePageInner service={service} />;
}

/**
 * 兼容版 `useCapability`：capability 不存在时返回 null（**不**抛错）。
 */
function useBsvPriceServiceOrNull(): BsvPriceService | null {
  return useOptionalCapability(BSV_PRICE_SERVICE_CAPABILITY) ?? null;
}

function BsvPricePageInner({ service }: { service: BsvPriceService }): React.ReactElement {
  const i18n = useI18n();
  const host = usePluginHost();
  const locale = useLocale();
  const snapshot = useResource<BsvPriceServiceSnapshot>(host.resourceStore, "bsv-price.snapshot", []);
  const snap = snapshot.data ?? service.snapshot();
  const activeServer = snap.servers.find(
    (server) => server.publisherPublicKeyHex === snap.active.publisherPublicKeyHex
  );
  const quotes = snap.snapshot
    ? Object.entries(snap.snapshot.markets).flatMap(([market, pairs]) =>
        Object.entries(pairs).map(([pair, price]) => ({ market, pair, price }))
      )
    : [];
  const emptyMessage = (() => {
    switch (snap.status) {
      case "waiting_snapshot": return i18n.t("bsv-price.page.empty.waitingSnapshot");
      case "receiving": return i18n.t("bsv-price.page.empty.receiving");
      case "not_configured": return i18n.t("bsv-price.page.empty.notConfigured");
      case "offline": return i18n.t("bsv-price.page.empty.offline");
      case "sat_not_configured": return i18n.t("bsv-price.page.empty.satNotConfigured");
      case "sat_connecting": return i18n.t("bsv-price.page.empty.satConnecting");
      case "sat_balance_required": return i18n.t("bsv-price.page.empty.satBalanceRequired");
      case "sat_identity_error": return i18n.t("bsv-price.page.empty.satIdentityError");
      case "sat_subscription_error": return i18n.t("bsv-price.page.empty.satSubscriptionError");
      case "subscription_unknown": return i18n.t("bsv-price.page.empty.subscriptionUnknown");
      default: return i18n.t("bsv-price.page.empty.idle");
    }
  })();

  const connectionLabel = (() => {
    switch (snap.status) {
      case "offline": return i18n.t("bsv-price.page.connection.offline");
      case "idle": return i18n.t("bsv-price.page.connection.idle");
      case "not_configured": return i18n.t("bsv-price.page.connection.notConfigured");
      case "sat_not_configured": return i18n.t("bsv-price.page.connection.satNotConfigured");
      case "sat_connecting": return i18n.t("bsv-price.page.connection.satConnecting");
      case "sat_balance_required": return i18n.t("bsv-price.page.connection.satBalanceRequired");
      case "sat_identity_error": return i18n.t("bsv-price.page.connection.satIdentityError");
      case "sat_subscription_error": return i18n.t("bsv-price.page.connection.satSubscriptionError");
      case "subscription_unknown": return i18n.t("bsv-price.page.connection.subscriptionUnknown");
      case "waiting_snapshot": return i18n.t("bsv-price.page.connection.waitingSnapshot");
      case "receiving": return i18n.t("bsv-price.page.connection.receiving");
      default: return snap.status;
    }
  })();

  const optionLabel = `${activeServer?.name ?? "—"} · ${snap.active.market} · ${snap.active.pair}`;

  return (
    <section className="km-bsv-price-page" data-bsv-price-page="active">
      <h1 className="km-bsv-price-page__title">{i18n.t("bsv-price.page.title")}</h1>

      <div className="km-bsv-price-page__row">
        <div className="km-bsv-price-page__label">
          {i18n.t("bsv-price.page.connection.label")}
        </div>
        <div
          className="km-bsv-price-page__value"
          data-bsv-price-connection={snap.status}
        >
          {connectionLabel}
        </div>
      </div>

      <div className="km-bsv-price-page__row">
        <div className="km-bsv-price-page__label">
          {i18n.t("bsv-price.page.publisher.label")}
        </div>
        <div className="km-bsv-price-page__value km-bsv-price-page__mono">
          {activeServer ? `${activeServer.name} · ${activeServer.publisherPublicKeyHex}` : "—"}
        </div>
      </div>

      <div className="km-bsv-price-page__row">
        <div className="km-bsv-price-page__label">
          {i18n.t("bsv-price.page.channel.label")}
        </div>
        <div
          className="km-bsv-price-page__value km-bsv-price-page__mono"
          data-bsv-price-channel
        >
          {snap.channelId}
        </div>
      </div>

      <div className="km-bsv-price-page__row">
        <div className="km-bsv-price-page__label">
          {i18n.t("bsv-price.page.quote.label")}
        </div>
        <div className="km-bsv-price-page__value" data-bsv-price-active-option>
          {optionLabel}
        </div>
      </div>

      <div className="km-bsv-price-page__row">
        <div className="km-bsv-price-page__label">
          {i18n.t("bsv-price.page.price.label")}
        </div>
        <div className="km-bsv-price-page__value km-bsv-price-page__mono" data-bsv-price-price>
          {snap.price.amount} {snap.price.unit}
        </div>
      </div>

      <div className="km-bsv-price-page__row">
        <div className="km-bsv-price-page__label">
          {i18n.t("bsv-price.page.snapshotAt.label")}
        </div>
        <div className="km-bsv-price-page__value" data-bsv-price-snapshot-at>
          {formatTimestamp(snap.price.updatedAtMs, locale)}
        </div>
      </div>

      <div className="km-bsv-price-page__section">
        <h2 className="km-bsv-price-page__section-title">
          {i18n.t("bsv-price.page.quotes.label")}
        </h2>
        {quotes.length === 0 ? (
          <p className="km-bsv-price-page__empty">
            {emptyMessage}
          </p>
        ) : (
          <table className="km-bsv-price-page__table">
            <thead>
              <tr>
                <th>{i18n.t("bsv-price.page.table.market")}</th>
                <th>{i18n.t("bsv-price.page.table.pair")}</th>
                <th>{i18n.t("bsv-price.page.table.price")}</th>
              </tr>
            </thead>
            <tbody>
              {quotes.map(({ market, pair, price }) => {
                const active = market === snap.active.market && pair === snap.active.pair;
                return (
                  <tr
                    key={`${market}:${pair}`}
                    data-bsv-price-quote-active={active ? "true" : undefined}
                  >
                    <td className="km-bsv-price-page__exchange">{market}</td>
                    <td className="km-bsv-price-page__exchange">{pair}</td>
                    <td className="km-bsv-price-page__price km-bsv-price-page__mono">
                      {price}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {snap.lastError !== null ? (
        <p className="km-bsv-price-page__error">
          {i18n.t("bsv-price.page.error.lastParse")} {snap.lastError}
        </p>
      ) : null}
      {snap.subscriptionErrorCode !== null ? (
        <p className="km-bsv-price-page__error" data-bsv-price-subscription-error>
          {i18n.t("bsv-price.page.error.subscription")} [{snap.subscriptionErrorCode}]
          {snap.subscriptionErrorMessage ? `: ${snap.subscriptionErrorMessage}` : ""}
          {snap.status === "sat_balance_required" ? ` ${i18n.t("bsv-price.page.error.balanceHint")}` : ""}
          {snap.status === "subscription_unknown" ? ` ${i18n.t("bsv-price.page.error.unknownHint")}` : ""}
        </p>
      ) : null}
    </section>
  );
}

function formatTimestamp(ms: number, locale: string): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  try {
    return new Date(ms).toLocaleString(locale);
  } catch {
    return new Date(ms).toISOString();
  }
}
