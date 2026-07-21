import React from "react";
import { countRender, useCapability, useI18n, usePluginHost, useResource } from "@keymaster/runtime";
import type { BsvPriceService, BsvPriceServiceSnapshot } from "./bsvPriceService.js";

const BSV_PRICE_SERVICE_CAPABILITY = "bsv-price.service";

export function BsvPriceHomeWidget(): React.ReactElement {
  countRender("plugin-bsv-price/BsvPriceHomeWidget");
  const { t } = useI18n();
  const host = usePluginHost();
  const service = useCapability<BsvPriceService>(BSV_PRICE_SERVICE_CAPABILITY);
  const resource = useResource<BsvPriceServiceSnapshot>(host.resourceStore, "bsv-price.snapshot", []);
  const snapshot = resource.data ?? service.snapshot();
  const quotes = snapshot.snapshot?.quotes ?? [];

  return (
    <div className="home-widget bsv-price-home-widget">
      <header className="home-widget__head">
        <h3>{t("bsv-price.home.title", { defaultValue: "BSV 价格" })}</h3>
        <span className={`bsv-price-home-widget__status bsv-price-home-widget__status--${snapshot.status}`}>
          {t(`bsv-price.home.status.${snapshot.status}`, { defaultValue: snapshot.status })}
        </span>
      </header>
      {quotes.length > 0 ? (
        <ul className="home-widget__list bsv-price-home-widget__list">
          {quotes.map((quote) => (
            <li key={quote.exchange}>
              <span>{quote.exchange}</span>
              <strong className="bsv-price-home-widget__price">{quote.price} USDT</strong>
            </li>
          ))}
        </ul>
      ) : (
        <p className="home-widget__status">
          {t("bsv-price.home.empty", { defaultValue: "等待 BSV 价格快照" })}
        </p>
      )}
    </div>
  );
}
