// packages/plugin-bsv-price/src/BsvPriceHomeWidget.tsx
// 首页 BSV 价格 widget。
//
// 设计缘由：
//   - 只显示「金额 + 单位」和订阅状态，不展示交易对 / 频道 / 全部行情；
//   - 价格只作显示参考，未就绪时显示 0.00；
//   - 被动消费 `bsv-price.service` 的实时快照，不维护第二份行情状态。

import React from "react";
import { countRender, useOptionalCapability, useResource } from "webloom-framework/react";
import { useI18n, useLocale, usePluginHost } from "@keymaster/runtime";
import type { BsvPriceService, BsvPriceServiceSnapshot } from "./bsvPriceService.js";
import { BSV_PRICE_SERVICE_CAPABILITY } from "./manifest.js";

export function BsvPriceHomeWidget(): React.ReactElement {
  countRender("plugin-bsv-price/BsvPriceHomeWidget");
  const { t, language } = useI18n();
  const host = usePluginHost();
  // owner/session 切换先同步撤销 capability，再异步收尾。首页 widget 是
  // 被动消费者，必须把这个短暂的 unavailable 状态当作合法空态，而不是
  // 用 useCapability() 抛异常把整个 App 卸载。
  const service = useOptionalCapability(BSV_PRICE_SERVICE_CAPABILITY);
  const hasResource = host.resourceRegistry?.get("bsv-price.snapshot") !== undefined;
  if (!service || !hasResource) {
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
  const locale = useLocale();
  const host = usePluginHost();
  const resource = useResource<BsvPriceServiceSnapshot>(host.resourceStore, "bsv-price.snapshot", []);
  const snapshot = resource.data ?? service.snapshot();
  const statusText = t(`bsv-price.home.status.${snapshot.status}`, { defaultValue: snapshot.status });
  const emptyMessage = (() => {
    switch (snapshot.status) {
      case "waiting_snapshot": return t("bsv-price.home.empty.waitingSnapshot", { defaultValue: "等待 BSV 价格快照" });
      case "receiving": return t("bsv-price.home.empty.receiving", { defaultValue: "当前快照没有激活选项的报价" });
      case "not_configured": return t("bsv-price.home.empty.notConfigured", { defaultValue: "未配置激活发布服务器" });
      case "offline": return t("bsv-price.home.empty.offline", { defaultValue: "钱包或订阅频道当前不可用" });
      case "sat_not_configured": return t("bsv-price.home.empty.satNotConfigured", { defaultValue: "SatSubscription 尚未配置" });
      case "sat_connecting": return t("bsv-price.home.empty.satConnecting", { defaultValue: "正在连接 SatSubscription" });
      case "sat_balance_required": return t("bsv-price.home.empty.satBalanceRequired", { defaultValue: "请先为 SatSubscription 充值" });
      case "sat_identity_error": return t("bsv-price.home.empty.satIdentityError", { defaultValue: "请修复 SatSubscription 身份配置" });
      case "sat_subscription_error": return t("bsv-price.home.empty.satSubscriptionError", { defaultValue: "SatSubscription 订阅失败" });
      case "subscription_unknown": return t("bsv-price.home.empty.subscriptionUnknown", { defaultValue: "订阅结果未知，等待系统对账" });
      default: return t("bsv-price.home.empty.idle", { defaultValue: "价格订阅处于空闲状态" });
    }
  })();
  const subscriptionError = snapshot.subscriptionErrorCode !== null ? (
    <p className="home-widget__status bsv-price-home-widget__error" data-bsv-price-home-subscription-error>
      {t("bsv-price.home.error.subscription", { defaultValue: "Subscription error" })} [{snapshot.subscriptionErrorCode}]
      {snapshot.subscriptionErrorMessage ? `: ${snapshot.subscriptionErrorMessage}` : ""}
      {snapshot.status === "sat_balance_required"
        ? ` ${t("bsv-price.home.error.balanceHint", { defaultValue: "Top up SatSubscription before retrying." })}`
        : ""}
      {snapshot.status === "subscription_unknown"
        ? ` ${t("bsv-price.home.error.unknownHint", { defaultValue: "Wait for reconciliation before retrying." })}`
        : ""}
    </p>
  ) : null;

  return (
    <div className="home-widget bsv-price-home-widget">
      <header className="home-widget__head">
        <h3>{t("bsv-price.home.title", { defaultValue: "BSV 价格" })}</h3>
        <span className={`bsv-price-home-widget__status bsv-price-home-widget__status--${snapshot.status}`}>
          {statusText}
        </span>
      </header>
      <p className="home-widget__label">{t("bsv-price.home.price.label", { defaultValue: "当前价格" })}</p>
      <p className="home-widget__amount" data-bsv-price-home-price>
        {snapshot.price.amount} {snapshot.price.unit}
      </p>
      <p className="home-widget__status">
        {snapshot.status === "receiving"
          ? t("bsv-price.home.updatedAt", {
              defaultValue: "更新于 {{time}}",
              time: formatTimestamp(snapshot.price.updatedAtMs, locale)
            })
          : emptyMessage}
      </p>
      {subscriptionError}
    </div>
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
