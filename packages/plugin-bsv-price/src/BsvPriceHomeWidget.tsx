import React from "react";
import { countRender, useOptionalCapability, useResource } from "webloom-framework/react";
import { useI18n, usePluginHost } from "@keymaster/runtime";
import type { BsvPriceService, BsvPriceServiceSnapshot } from "./bsvPriceService.js";
import { BSV_PRICE_SERVICE_CAPABILITY } from "./manifest.js";

export function BsvPriceHomeWidget(): React.ReactElement {
  countRender("plugin-bsv-price/BsvPriceHomeWidget");
  const { t, language } = useI18n();
  const host = usePluginHost();
  // owner/session 切换先同步撤销 capability，再异步收尾。React 可能在
  // registry 注销和 capability snapshot 之间重渲染一次；首页 widget 是
  // 被动消费者，必须把这个短暂的 unavailable 状态当作合法空态，而不是
  // 用 useCapability() 抛异常把整个 App 卸载。
  const service = useOptionalCapability(BSV_PRICE_SERVICE_CAPABILITY);
  const hasResource = host.resourceRegistry?.get("bsv-price.snapshot") !== undefined;
  if (!service || !hasResource) {
    // 插件资源会在 owner/session 撤销时一起回收；此处不能再调用该
    // namespace 的 t()，否则合法的短暂降级会制造 missing-key warning。
    const unavailableText = language() === "zh-CN"
      ? { title: "BSV 价格", message: "当前会话暂时无法提供行情。" }
      : { title: "BSV Price", message: "Price service is temporarily unavailable for this session." };
    return (
      <div className="home-widget bsv-price-home-widget bsv-price-home-widget--missing" data-bsv-price-home-widget="missing-service">
        <header className="home-widget__head">
          <h3>{unavailableText.title}</h3>
        </header>
        <p className="home-widget__status">
          {unavailableText.message}
        </p>
      </div>
    );
  }
  // ResourceDefinition 与 service 由同一个 owner/session 实例注册和撤销。
  // 拆出子组件后，service 消失时整个 resource consumer 一起卸载；父组件
  // 仍只调用固定的 optional capability hook，恢复时再重新挂载新实例。
  return <BsvPriceHomeWidgetContent service={service} />;
}

function BsvPriceHomeWidgetContent({ service }: { service: BsvPriceService }): React.ReactElement {
  const { t } = useI18n();
  const host = usePluginHost();
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
