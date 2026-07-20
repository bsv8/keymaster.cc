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
import { useCapability, useI18n, usePluginHost, useResource } from "@keymaster/runtime";
import type { BsvPriceService, BsvPriceServiceSnapshot } from "./bsvPriceService.js";

const BSV_PRICE_SERVICE_CAPABILITY = "bsv-price.service";
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
  try {
    return useCapability<BsvPriceService>(BSV_PRICE_SERVICE_CAPABILITY);
  } catch {
    return null;
  }
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

  function onSave(): void {
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      service.savePublisherPublicKeyHex(draft);
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
      case "ready":
        return t("bsv-price.settings.status.ready", { defaultValue: "正在订阅" });
      case "offline":
        return t("bsv-price.settings.status.offline", { defaultValue: "已断开" });
      case "idle":
        return t("bsv-price.settings.status.idle", { defaultValue: "空闲" });
      case "no_publisher_key":
        return t("bsv-price.settings.status.noPublisherKey", {
          defaultValue: "广播源不可用"
        });
      case "not_configured":
        return t("bsv-price.settings.status.notConfigured", {
          defaultValue: "未配置"
        });
      default:
        return snap.status;
    }
  })();

  return (
    <section className="km-bsv-price-settings-page" data-bsv-price-settings="main">
      <PageHeader
        title={t("bsv-price.settings.title", { defaultValue: "BSV Price settings" })}
        description={t("bsv-price.settings.desc", {
          defaultValue:
            "Edit the PriceCast publisher public key. Saving an empty value clears the configuration and stops subscription."
        })}
        actions={
          <Button onClick={onSave} loading={saving}>
            {t("bsv-price.settings.save", { defaultValue: "保存" })}
          </Button>
        }
      />

      <div className="km-bsv-price-settings-page__card">
        <TextInput
          label={t("bsv-price.settings.field.publisher.label", {
            defaultValue: "PriceCast publisher 公钥 hex"
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
          {t("bsv-price.settings.clearHint", {
            defaultValue: "清空后会取消当前订阅，/bsv-price 会进入未配置状态。"
          })}
        </p>

        {saveMessage ? (
          <p className="km-bsv-price-settings-page__message" data-bsv-price-settings-message>
            {saveMessage}
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
      default:
        return err.message;
    }
  }
  return String(err);
}
