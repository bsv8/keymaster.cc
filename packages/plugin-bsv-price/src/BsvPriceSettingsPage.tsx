// packages/plugin-bsv-price/src/BsvPriceSettingsPage.tsx
// BSV Price 设置详情页（施工单 2026-07-08 002 硬切换）。
//
// 设计缘由：
//   - 这里只编辑 `pricePublisherPublicKeyHex`，不承载历史 / 自动发现 / 扫描；
//   - 保存按钮显式提交，便于严格校验与回滚；
//   - 当前实际订阅频道由 service 直接给出，页面只读展示；
//   - 空串是清空配置，不是错误。

import { useState, type ReactElement } from "react";
import { Button, PageHeader, TextInput } from "@keymaster/ui";
import { useOptionalCapability, useResource } from "webloom-framework/react";
import { useI18n, usePluginHost } from "@keymaster/runtime";
import type { BsvPriceService, BsvPriceServiceSnapshot } from "./bsvPriceService.js";

import { BSV_PRICE_SERVICE_CAPABILITY } from "./manifest.js";
const NOT_CONFIGURED_LABEL = "(not configured)";

/**
 * BSV Price 设置页根组件。
 *
 * 设计缘由：capability 不存在时仍要给出可读空态，避免 host 外调用直接炸。
 */
export function BsvPriceSettingsPage(): ReactElement {
  const { t } = useI18n();
  const service = useBsvPriceServiceOrNull();
  if (!service) {
    return (
      <section
        className="km-bsv-price-settings-page km-bsv-price-settings-page--missing"
        data-bsv-price-settings="missing-service"
      >
        <h1 className="km-bsv-price-settings-page__title">
          {t("bsv-price.settings.title")}
        </h1>
        <p className="km-bsv-price-settings-page__empty">
          bsv-price.service is not available.
        </p>
      </section>
    );
  }
  return <BsvPriceSettingsPageInner service={service} />;
}

/** capability 不存在时返回 null，避免页面直接抛错。 */
function useBsvPriceServiceOrNull(): BsvPriceService | null {
  return useOptionalCapability(BSV_PRICE_SERVICE_CAPABILITY) ?? null;
}

interface BsvPriceSettingsPageInnerProps {
  service: BsvPriceService;
}

function BsvPriceSettingsPageInner({
  service
}: BsvPriceSettingsPageInnerProps): ReactElement {
  const { t } = useI18n();
  const host = usePluginHost();
  const snapshot = useResource<BsvPriceServiceSnapshot>(host.resourceStore, "bsv-price.snapshot", []);
  const snap = snapshot.data ?? service.snapshot();
  const [draft, setDraft] = useState<string>(() => service.getPublisherPublicKeyHex());
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSave(): Promise<void> {
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      await service.savePublisherPublicKeyHex(draft);
      const nextHex = service.getPublisherPublicKeyHex();
      setDraft(nextHex);
      setSaveMessage(
        nextHex.length === 0
          ? t("bsv-price.settings.savedCleared", { defaultValue: "已清空配置" })
          : t("bsv-price.settings.saved", { defaultValue: "已保存" })
      );
    } catch (err) {
      setSaveError(describeSaveError(err));
    } finally {
      setSaving(false);
    }
  }

  const channelPreview = snap.configured ? snap.channelId : NOT_CONFIGURED_LABEL;
  const statusLabel = (() => {
    switch (snap.status) {
      case "offline":
        return t("bsv-price.settings.status.offline", { defaultValue: "已断开" });
      case "idle":
        return t("bsv-price.settings.status.idle", { defaultValue: "空闲" });
      case "not_configured":
        return t("bsv-price.settings.status.notConfigured", {
          defaultValue: "未配置"
        });
      case "sat_not_configured":
        return t("bsv-price.settings.status.satNotConfigured", { defaultValue: "SatSubscription 未配置" });
      case "sat_connecting":
        return t("bsv-price.settings.status.satConnecting", { defaultValue: "正在连接 SatSubscription" });
      case "sat_balance_required":
        return t("bsv-price.settings.status.satBalanceRequired", { defaultValue: "SatSubscription 余额不足" });
      case "sat_identity_error":
        return t("bsv-price.settings.status.satIdentityError", { defaultValue: "SatSubscription 身份错误" });
      case "sat_subscription_error":
        return t("bsv-price.settings.status.satSubscriptionError", { defaultValue: "SatSubscription 订阅失败" });
      case "subscription_unknown":
        return t("bsv-price.settings.status.subscriptionUnknown", { defaultValue: "订阅结果未知，请等待重试" });
      case "waiting_snapshot":
        return t("bsv-price.settings.status.waitingSnapshot", { defaultValue: "等待 BSV 价格快照" });
      case "receiving":
        return t("bsv-price.settings.status.receiving", { defaultValue: "正在接收" });
      default:
        return snap.status;
    }
  })();
  const statusHint = (() => {
    switch (snap.status) {
      case "not_configured": return t("bsv-price.settings.action.notConfigured", { defaultValue: "请填写 PriceCast 发布器公钥。" });
      case "offline": return t("bsv-price.settings.action.offline", { defaultValue: "请解锁或重新进入当前 Owner。" });
      case "sat_not_configured": return t("bsv-price.settings.action.satNotConfigured", { defaultValue: "请配置并启用接收 Supplier。" });
      case "sat_connecting": return t("bsv-price.settings.action.satConnecting", { defaultValue: "请检查 Supplier 地址及连接状态。" });
      case "sat_balance_required": return t("bsv-price.settings.action.satBalanceRequired", { defaultValue: "请刷新 SPI 余额并为 SatSubscription 充值。" });
      case "sat_identity_error": return t("bsv-price.settings.action.satIdentityError", { defaultValue: "请检查 Supplier 公钥、Peer ID 和地址。" });
      case "subscription_unknown": return t("bsv-price.settings.action.subscriptionUnknown", { defaultValue: "请勿重复发起收费订阅，等待系统对账。" });
      case "sat_subscription_error": return t("bsv-price.settings.action.satSubscriptionError", { defaultValue: "请根据稳定错误码前往 SatSubscription 设置处理。" });
      case "waiting_snapshot": return t("bsv-price.settings.action.waitingSnapshot", { defaultValue: "无需操作，等待首个价格快照。" });
      case "receiving": return t("bsv-price.settings.action.receiving", { defaultValue: "无需操作。" });
      default: return t("bsv-price.settings.action.idle", { defaultValue: "价格订阅处于空闲状态。" });
    }
  })();

  return (
    <section className="km-bsv-price-settings-page" data-bsv-price-settings="main">
      <PageHeader
        title={t("bsv-price.settings.title", { defaultValue: "BSV Price settings" })}
        description={t("bsv-price.settings.desc", {
          defaultValue: "Edit the BSV price publisher public key. Saving an empty value clears the configuration and stops subscription."
        })}
        actions={<Button onClick={onSave} loading={saving}>{t("bsv-price.settings.save", { defaultValue: "保存" })}</Button>}
      />
      <div className="km-bsv-price-settings-page__card">
        <TextInput
          label={t("bsv-price.settings.field.publisher.label", {
            defaultValue: "BSV price publisher 公钥 hex"
          })}
          description={t("bsv-price.settings.field.publisher.desc", {
            defaultValue: "Trimmed and lowercased before saving. Empty string clears the config."
          })}
          placeholder={t("bsv-price.settings.field.publisher.placeholder", {
            defaultValue: "02... (66 hex chars)"
          })}
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          error={saveError ?? undefined}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="km-bsv-price-settings-page__input"
          data-bsv-price-settings-input="publisher"
        />

        <div className="km-bsv-price-settings-page__row">
          <div className="km-bsv-price-settings-page__label">
            {t("bsv-price.settings.channel.label", {
              defaultValue: "当前实际订阅频道"
            })}
          </div>
          <div
            className="km-bsv-price-settings-page__value km-bsv-price-settings-page__mono"
            data-bsv-price-settings-channel
          >
            {channelPreview}
          </div>
        </div>

        <div className="km-bsv-price-settings-page__row">
          <div className="km-bsv-price-settings-page__label">
            {t("bsv-price.settings.status.label", { defaultValue: "当前状态" })}
          </div>
          <div className="km-bsv-price-settings-page__value" data-bsv-price-settings-status>
            {statusLabel}
          </div>
        </div>

        <p className="km-bsv-price-settings-page__hint">
          {statusHint}
        </p>
        <p className="km-bsv-price-settings-page__hint">
          {t("bsv-price.settings.clearHint", {
            defaultValue: "清空后会取消当前订阅，/bsv-price 会进入未配置状态。"
          })}
        </p>

        {saveMessage ? (
          <p className="km-bsv-price-settings-page__message" data-bsv-price-settings-message>
            {saveMessage}
          </p>
        ) : null}
        {snap.subscriptionErrorCode ? (
          <p className="km-bsv-price-settings-page__error" data-bsv-price-settings-error>
            {t("bsv-price.settings.subscriptionError", { defaultValue: "订阅错误" })} ({snap.subscriptionErrorCode})
            {snap.subscriptionErrorMessage ? `: ${snap.subscriptionErrorMessage}` : ""}
          </p>
        ) : null}
        {snap.status === "sat_balance_required" ? (
          <p className="km-bsv-price-settings-page__hint" data-bsv-price-settings-balance-hint>
            {t("bsv-price.settings.balanceHint", { defaultValue: "请先为 SatSubscription 充值。" })}
          </p>
        ) : null}
        {snap.status === "subscription_unknown" ? (
          <p className="km-bsv-price-settings-page__hint" data-bsv-price-settings-unknown-hint>
            {t("bsv-price.settings.unknownHint", { defaultValue: "请勿手动重复扣费，等待系统对账。" })}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function describeSaveError(err: unknown): string {
  if (err instanceof Error) {
    switch (err.message) {
      case "invalid_type":
        return "输入必须是字符串";
      case "invalid_length":
        return "公钥必须是 66 位压缩 hex";
      case "invalid_hex":
        return "公钥 hex 只能包含 0-9 和 a-f";
      case "invalid_prefix":
        return "压缩公钥前缀必须是 02 或 03";
      case "invalid_public_key":
        return "公钥不是有效的 secp256k1 压缩公钥";
      default:
        return err.message;
    }
  }
  return String(err);
}
