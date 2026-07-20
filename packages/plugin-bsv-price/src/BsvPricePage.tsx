// packages/plugin-bsv-price/src/BsvPricePage.tsx
// BSV 价格业务页（施工单 2026-07-08 001）。
//
// 设计缘由：
//   - 展示交易所列表与最新价格；
//   - 展示当前广播连接状态（"connected / disconnected / idle"）；
//   - 展示当前订阅频道名（**仅展示**，无编辑）；
//   - 不建本地 DB；刷新 = 等待下一次快照；
//   - 页面不接触 `appmsg`；服务走 `bsv-price.service` capability；
//   - 配错 publisher 公钥时：页面渲染是空态（service 一直拿不到数据）。
//   - **不**展示历史 / 图表 / 告警。

import React from "react";
import { useCapability, useI18n, usePluginHost, useResource } from "@keymaster/runtime";
import type {
  BsvPriceService,
  BsvPriceServiceSnapshot
} from "./bsvPriceService.js";

const BSV_PRICE_SERVICE_CAPABILITY = "bsv-price.service";

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
  return <BsvPricePageInner service={service} i18n={i18n} />;
}

/**
 * 兼容版 `useCapability`：capability 不存在时返回 null（**不**抛错）。
 *
 * 设计缘由：plugin-bsv-price 的 route 在 plugin enable 后才被注册；本组件
 * 一旦被路由命中，capability bus 上就一定有 `bsv-price.service`。但极端
 * host（如未通过 host 渲染）下 capability 可能没注册——这里仅做防御性
 * 兼容，**不**作为生产主路径。
 */
function useBsvPriceServiceOrNull(): BsvPriceService | null {
  try {
    return useCapability<BsvPriceService>(BSV_PRICE_SERVICE_CAPABILITY);
  } catch {
    return null;
  }
}

function BsvPricePageInner({
  service,
  i18n
}: {
  service: BsvPriceService;
  i18n: { t: (key: string) => string };
}): React.ReactElement {
  const host = usePluginHost();
  const snapshot = useResource<BsvPriceServiceSnapshot>(host.resourceStore, "bsv-price.snapshot", []);
  const snap = snapshot.data ?? service.snapshot();

  const connectionLabel = (() => {
    switch (snap.status) {
      case "ready":
        return i18n.t("bsv-price.page.connection.ready");
      case "offline":
        return i18n.t("bsv-price.page.connection.offline");
      case "idle":
        return i18n.t("bsv-price.page.connection.idle");
      case "no_publisher_key":
        return i18n.t("bsv-price.page.connection.noPublisherKey");
      case "not_configured":
        return i18n.t("bsv-price.page.connection.notConfigured");
      default:
        return snap.status;
    }
  })();

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
          {i18n.t("bsv-price.page.channel.label")}
        </div>
        <div className="km-bsv-price-page__value km-bsv-price-page__mono">
          {snap.channelId}
        </div>
      </div>

      <div className="km-bsv-price-page__section">
        <h2 className="km-bsv-price-page__section-title">
          {i18n.t("bsv-price.page.quotes.label")}
        </h2>
        {snap.snapshot === null ? (
          <p className="km-bsv-price-page__empty">
            {i18n.t("bsv-price.page.empty")}
          </p>
        ) : (
          <table className="km-bsv-price-page__table">
            <thead>
              <tr>
                <th>{i18n.t("bsv-price.page.table.exchange")}</th>
                <th>{i18n.t("bsv-price.page.table.price")}</th>
              </tr>
            </thead>
            <tbody>
              {snap.snapshot.quotes.map((q) => (
                <tr key={q.exchange}>
                  <td className="km-bsv-price-page__exchange">{q.exchange}</td>
                  <td className="km-bsv-price-page__price km-bsv-price-page__mono">
                    {q.price}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {snap.lastError !== null ? (
        <p className="km-bsv-price-page__error">
          {i18n.t("bsv-price.page.error.lastParse")} {snap.lastError}
        </p>
      ) : null}
    </section>
  );
}
